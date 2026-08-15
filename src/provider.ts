import type { Context } from '@deepseek-ai/cordis'
import type { DsharnessAgentContext } from '@ishuowang/rolehub-compat-dsharness'
import { createDsharnessSetup } from '@ishuowang/rolehub-compat-dsharness'
import {
  foldSubagentDescriptor,
  type ContinuableCreateRequest,
  type ContinuableCreateSpec,
  type ResolvedSubagentStartRequest,
  type SubagentProvider,
  type SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { createGitReadTool } from './git-tool.js'
import { assertEffectivePolicy } from './policy.js'
import {
  ROLEHUB_PROVIDER_PREFIX,
  type LoadedRoleDeployment,
} from './types.js'

export interface DeploymentLookup {
  getDeployment(bundleDigestOrProviderName: string): LoadedRoleDeployment | undefined
}

interface ActivationContext extends DsharnessAgentContext {
  tools: DsharnessAgentContext['tools'] & {
    register(tool: ToolDefinition): () => void
  }
}

export function providerNameForBundleDigest(bundleDigest: string): string {
  if (!/^[a-f0-9]{64}$/u.test(bundleDigest)) {
    throw new Error('rolehub-bridge: bundle digest must be 64 lowercase hexadecimal characters')
  }
  return `${ROLEHUB_PROVIDER_PREFIX}${bundleDigest}`
}

/**
 * Role providers exist only to reserve a durable descriptor for continuable
 * Sessions. The ordinary one-shot subagent path is deliberately unavailable.
 */
export class RoleHubProvider implements SubagentProvider {
  readonly capabilities = {
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false,
  } as const

  readonly inheritsParentContext = false

  constructor(
    readonly bundleDigest: string,
    readonly name = providerNameForBundleDigest(bundleDigest),
  ) {
    if (name !== providerNameForBundleDigest(bundleDigest)) {
      throw new Error('rolehub-bridge: provider name must be derived from its exact bundle digest')
    }
  }

  async start(_request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    throw new Error(
      `rolehub-bridge: provider ${this.name} rejects one-shot reuse; start the role through the Host /rolehub start command`,
    )
  }

  async prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
    request.signal.throwIfAborted()
    return {}
  }
}

/**
 * Build the single global continuation contribution. Non-RoleHub children are
 * untouched; RoleHub children are re-bound from their durable provider digest.
 */
export function createRoleHubContinuableSetup(
  deployments: DeploymentLookup,
): (childCtx: Context) => () => void {
  return (childCtx: Context): (() => void) => {
    const agent = childCtx.agent
    if (agent === undefined) {
      throw new Error('rolehub-bridge: continuable setup requires an unpublished child Agent')
    }
    const descriptor = foldSubagentDescriptor(agent.session.events)
    if (descriptor === undefined || !descriptor.provider.startsWith(ROLEHUB_PROVIDER_PREFIX)) {
      return () => undefined
    }
    if (descriptor.mode !== 'continuable') {
      throw new Error('rolehub-bridge: a RoleHub provider descriptor must be continuable')
    }

    const deployment = deployments.getDeployment(descriptor.provider)
    if (deployment === undefined) {
      throw new Error(`rolehub-bridge: no verified deployment exists for provider ${descriptor.provider}`)
    }
    assertDeploymentMatchesProvider(deployment, descriptor.provider)

    const registry = childCtx as unknown as ActivationContext
    const collected = new RegistryDisposerFacade(registry)
    try {
      if (deployment.record.policy.grants.includes('source-control.read')) {
        collected.registerTool(createGitReadTool())
      }
      createDsharnessSetup(deployment.role, {
        mode: 'strict',
        scope: 'session',
        policy: deployment.record.policy,
        bindings: deployment.record.bindings,
      })(collected.context)
      return collected.unifiedDisposer()
    } catch (error) {
      return collected.rollback(error)
    }
  }
}

export function assertDeploymentMatchesProvider(
  deployment: LoadedRoleDeployment,
  providerName: string,
): void {
  const { record, role } = deployment
  const expectedProvider = providerNameForBundleDigest(role.bundleDigest)
  if (providerName !== expectedProvider || record.providerName !== expectedProvider) {
    throw new Error('rolehub-bridge: deployment provider does not match the loaded bundle digest')
  }
  if (
    record.role.bundleDigest !== role.bundleDigest
    || record.role.manifestDigest !== role.manifestDigest
    || record.role.id !== role.manifest.metadata.id
    || record.role.name !== role.manifest.metadata.name
    || record.role.version !== role.manifest.metadata.version
  ) {
    throw new Error('rolehub-bridge: deployment receipt no longer matches the loaded role')
  }
  assertEffectivePolicy(role, record.policy, record.bindings)
}

/** Captures every compatibility registration and exposes exactly one teardown. */
class RegistryDisposerFacade {
  private readonly disposers: Array<() => void> = []
  private disposed = false

  readonly context: DsharnessAgentContext

  constructor(private readonly registry: ActivationContext) {
    this.context = {
      systemPrompt: {
        section: section => this.collect(registry.systemPrompt.section(section)),
      },
      skills: {
        register: skill => this.collect(registry.skills.register(skill)),
      },
      tools: {
        restrict: filter => this.collect(registry.tools.restrict(filter)),
        guard: guard => this.collect(registry.tools.guard(guard)),
      },
    }
  }

  registerTool(tool: ToolDefinition): void {
    this.collect(this.registry.tools.register(tool))
  }

  unifiedDisposer(): () => void {
    return () => this.disposeAll()
  }

  rollback(primary: unknown): never {
    try {
      this.disposeAll()
    } catch (cleanup) {
      throw new AggregateError(
        [primary, cleanup],
        'rolehub-bridge: role setup and registry rollback both failed',
      )
    }
    throw primary
  }

  private collect(disposer: () => void): () => void {
    if (this.disposed) {
      disposer()
      throw new Error('rolehub-bridge: cannot register into a disposed Activation facade')
    }
    if (typeof disposer !== 'function') {
      throw new Error('rolehub-bridge: a child registry did not return a disposer')
    }
    this.disposers.push(disposer)
    return disposer
  }

  private disposeAll(): void {
    if (this.disposed) return
    this.disposed = true
    const failures: unknown[] = []
    for (const disposer of this.disposers.reverse()) {
      try {
        disposer()
      } catch (error) {
        failures.push(error)
      }
    }
    this.disposers.length = 0
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'rolehub-bridge: multiple child registry disposers failed')
    }
  }
}
