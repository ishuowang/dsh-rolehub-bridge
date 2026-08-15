import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LoadedRole } from '@ishuowang/rolehub-core'
import type {
  ContinuableSetupContribution,
  SubagentInterruptAuthority,
  SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import type { Config } from '../src/config.js'
import RoleHubBridgeRuntime from '../src/index.js'
import { createEffectivePolicy } from '../src/policy.js'
import { providerNameForBundleDigest } from '../src/provider.js'
import {
  DEPLOYMENT_SCHEMA_VERSION,
  type HubRole,
  type LoadedRoleDeployment,
  type RoleSessionBinding,
  type RoleView,
} from '../src/types.js'

const BUNDLE_DIGEST = 'b'.repeat(64)

class FakeSubagents extends Service {
  readonly providers = new Map<string, SubagentProvider>()
  readonly interrupts: Array<{ childId: string; authority: SubagentInterruptAuthority }> = []
  setup: ContinuableSetupContribution | undefined
  startContinuable = vi.fn(async () => ({
    childId: SessionId('child-1'),
    messageId: 'message-1' as never,
  }))

  constructor(ctx: Context) {
    super(ctx, 'subagents')
  }

  registerContinuableSetup(contribution: ContinuableSetupContribution): () => void {
    this.setup = contribution
    return () => { this.setup = undefined }
  }

  registerProvider(provider: SubagentProvider): () => void {
    if (this.providers.has(provider.name)) throw new Error(`duplicate provider ${provider.name}`)
    this.providers.set(provider.name, provider)
    return () => { this.providers.delete(provider.name) }
  }

  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name)
  }

  interrupt(childId: SessionId, authority: SubagentInterruptAuthority): void {
    this.interrupts.push({ childId, authority })
  }
}

class FakeRooms extends Service {
  readonly operations: string[] = []
  readonly attachSession = vi.fn(async () => {
    this.operations.push('attach')
    return { memberId: 'member-1' }
  })
  readonly removeMember = vi.fn(async () => {
    this.operations.push('remove')
    return { memberId: 'member-1', status: 'removed' }
  })
  readonly listRooms = vi.fn(() => [
    { id: 'room-open', name: 'Open room', status: 'open' },
  ])

  constructor(ctx: Context) {
    super(ctx, 'rooms')
  }
}

function loadedRole(): LoadedRole {
  return {
    root: '/roles/reviewer',
    manifestPath: '/roles/reviewer/role.yaml',
    manifestDigest: 'a'.repeat(64),
    bundleDigest: BUNDLE_DIGEST,
    prompt: 'Review carefully.',
    skills: [],
    manifest: {
      apiVersion: 'rolehub.dev/v1alpha1',
      kind: 'AgentRole',
      metadata: {
        id: 'io.example/reviewer',
        name: 'reviewer',
        version: '1.0.0',
        displayName: 'Reviewer',
        description: 'Reviews bounded changes.',
        publisher: 'io.example',
        license: 'Apache-2.0',
        tags: ['review'],
      },
      spec: {
        prompt: { path: 'prompt.md', mode: 'append' },
        skills: [],
        capabilities: {
          required: [{ id: 'filesystem.read', reason: 'Read source.' }],
          optional: [],
          denied: [{ id: 'source-control.write', reason: 'No writes.' }],
        },
        isolation: {
          scope: 'session',
          context: 'workspace',
          filesystem: 'read-only',
          network: 'denied',
        },
        limits: { maxTurns: 8 },
        secrets: [],
        evals: { path: 'evals/cases.yaml' },
      },
    },
  }
}

function roleView(): RoleView {
  const role = loadedRole()
  return {
    hubId: 'official',
    id: role.manifest.metadata.id,
    name: role.manifest.metadata.name,
    displayName: role.manifest.metadata.displayName,
    description: role.manifest.metadata.description,
    publisher: role.manifest.metadata.publisher,
    version: role.manifest.metadata.version,
    license: role.manifest.metadata.license,
    tags: [...role.manifest.metadata.tags],
    trust: 'reference',
    manifestDigest: role.manifestDigest,
    bundleDigest: role.bundleDigest,
    capabilities: {
      required: ['filesystem.read'],
      optional: [],
      denied: ['source-control.write'],
    },
    installed: true,
  }
}

function deployment(): LoadedRoleDeployment {
  const role = loadedRole()
  const effective = createEffectivePolicy(role, ['filesystem.read'])
  return {
    role,
    record: {
      schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
      hubId: 'official',
      catalogUrl: 'https://roles.example/catalog.json',
      archiveUrl: 'https://roles.example/reviewer.tgz',
      archiveSha256: 'c'.repeat(64),
      roleRoot: role.root,
      role: {
        id: role.manifest.metadata.id,
        name: role.manifest.metadata.name,
        displayName: role.manifest.metadata.displayName,
        description: role.manifest.metadata.description,
        publisher: role.manifest.metadata.publisher,
        version: role.manifest.metadata.version,
        tags: [...role.manifest.metadata.tags],
        trust: 'reference',
        manifestDigest: role.manifestDigest,
        bundleDigest: role.bundleDigest,
      },
      providerName: providerNameForBundleDigest(role.bundleDigest),
      policy: effective.policy,
      bindings: effective.bindings,
      installedAt: '2026-08-15T00:00:00.000Z',
    },
  }
}

function catalogRole(): HubRole {
  const view = roleView()
  return {
    ...view,
    portability: 'universal',
    path: 'roles/reviewer',
    url: 'https://roles.example/reviewer',
    archiveUrl: 'https://roles.example/reviewer.tgz',
  }
}

function config(): Config {
  return {
    storageDir: '/tmp/rolehub-bridge-tests',
    hubs: [{
      id: 'official',
      catalogUrl: 'https://roles.example/catalog.json',
      archiveUrlTemplate: 'https://roles.example/{name}-{version}.tgz',
      trustedPublishers: ['io.example'],
      allowedRedirectHosts: [],
    }],
    allowCommunityRoles: false,
    allowedCapabilities: ['filesystem.read'],
    fetchTimeoutMs: 10_000,
    maxCatalogCacheAgeMs: 86_400_000,
    maxCatalogBytes: 100_000,
    maxArchiveBytes: 1_000_000,
    agentProvider: 'deepseek',
    agentModel: 'chat',
  }
}

function fakeResolver(options: { failActiveAudit?: boolean } = {}) {
  const installed = deployment()
  const bindings: RoleSessionBinding[] = []
  return {
    bindings,
    init: vi.fn(async () => undefined),
    refreshCatalogs: vi.fn(async () => [{
      hub: config().hubs[0]!,
      catalog: {
        apiVersion: 'rolehub.dev/catalog/v1alpha2' as const,
        generatedBy: 'test',
        roles: [catalogRole()],
      },
      roles: [catalogRole()],
      source: 'network' as const,
      fetchedAt: '2026-08-15T00:00:00.000Z',
    }]),
    listRoles: vi.fn(() => [roleView()]),
    resolveRole: vi.fn(() => catalogRole()),
    install: vi.fn(async () => installed),
    loadDeployments: vi.fn(async () => [installed]),
    getDeployment: vi.fn(() => installed),
    writeSessionBinding: vi.fn(async (binding: RoleSessionBinding) => {
      bindings.push(structuredClone(binding))
      if (options.failActiveAudit && binding.state === 'active') throw new Error('audit disk full')
    }),
    listSessionBindings: vi.fn(async () => bindings),
  }
}

async function harness(options: { rooms?: boolean; failActiveAudit?: boolean } = {}) {
  const ctx = new Context()
  const subagents = new FakeSubagents(ctx)
  const rooms = options.rooms === false ? undefined : new FakeRooms(ctx)
  const resolver = fakeResolver(
    options.failActiveAudit === undefined ? {} : { failActiveAudit: options.failActiveAudit },
  )
  const runtime = new RoleHubBridgeRuntime(ctx, config(), resolver)
  const lifecycle = runtime[Service.init]()
  const initialized = await lifecycle.next()
  if (initialized.done || typeof initialized.value !== 'function') throw new Error('runtime did not initialize')
  return { ctx, subagents, rooms, resolver, runtime, dispose: initialized.value }
}

function leader(): Agent {
  return { id: SessionId('leader-1') } as unknown as Agent
}

describe('RoleHubBridgeRuntime', () => {
  it('loads deployments, registers one provider per digest, and tears down both registries', async () => {
    const { subagents, resolver, dispose } = await harness()
    const provider = providerNameForBundleDigest(BUNDLE_DIGEST)

    expect(resolver.init).toHaveBeenCalledOnce()
    expect(resolver.loadDeployments).toHaveBeenCalledOnce()
    expect(subagents.setup).toBeTypeOf('function')
    expect(subagents.providers.get(provider)).toBeInstanceOf(Object)

    dispose()
    expect(subagents.setup).toBeUndefined()
    expect(subagents.providers.size).toBe(0)
  })

  it('keeps snapshot synchronous, memory-only, and limited to open owned Rooms', async () => {
    const { runtime, rooms, resolver } = await harness()
    const owner = leader()

    expect(runtime.snapshot(owner)).toMatchObject({
      hubs: [{ id: 'official' }],
      roles: [{ id: 'io.example/reviewer' }],
      rooms: [{ id: 'room-open' }],
      roomAvailable: true,
    })
    expect(rooms?.listRooms).toHaveBeenCalledExactlyOnceWith(owner, false)
    expect(resolver.refreshCatalogs).not.toHaveBeenCalled()
    expect(resolver.listSessionBindings).not.toHaveBeenCalled()
  })

  it('refreshes catalogs explicitly without changing snapshot into an async fetch', async () => {
    const { runtime, resolver } = await harness()
    const signal = new AbortController().signal

    await expect(runtime.refresh(signal)).resolves.toEqual({
      roleCount: 1,
      hubs: [{ id: 'official', source: 'network', fetchedAt: '2026-08-15T00:00:00.000Z' }],
    })
    expect(resolver.refreshCatalogs).toHaveBeenCalledExactlyOnceWith(signal)
  })

  it('starts a continuable Session, attaches RoleHub provenance, and writes an active audit binding', async () => {
    const { runtime, rooms, resolver, subagents } = await harness()
    const owner = leader()
    const signal = new AbortController().signal

    await expect(runtime.startRole(owner, {
      selector: 'official/reviewer',
      label: 'Careful reviewer',
      prompt: 'Review PR 42',
      roomId: 'room-1',
    }, signal)).resolves.toMatchObject({
      childId: 'child-1',
      messageId: 'message-1',
      room: { id: 'room-1', memberId: 'member-1' },
    })

    expect(subagents.startContinuable).toHaveBeenCalledExactlyOnceWith({
      provider: providerNameForBundleDigest(BUNDLE_DIGEST),
      label: 'Careful reviewer',
      request: {
        parent: owner,
        prompt: [{ type: 'text', text: 'Review PR 42' }],
        agentOptions: { provider: 'deepseek', model: 'chat' },
      },
      signal,
    })
    expect(rooms?.attachSession).toHaveBeenCalledExactlyOnceWith(owner, 'room-1', {
      sessionId: 'child-1',
      name: 'Careful reviewer',
      profile: {
        apiVersion: 'rolehub.dev/v1alpha1',
        kind: 'AgentRole',
        id: 'io.example/reviewer',
        version: '1.0.0',
        digest: `sha256:${BUNDLE_DIGEST}`,
      },
    }, signal)
    expect(resolver.bindings).toEqual([
      expect.objectContaining({
        sessionId: 'child-1',
        parentSessionId: 'leader-1',
        roomId: 'room-1',
        roomMemberId: 'member-1',
        state: 'active',
      }),
    ])
  })

  it('detaches before interrupt and records orphan state when active audit persistence fails', async () => {
    const { runtime, rooms, resolver, subagents } = await harness({ failActiveAudit: true })
    const order: string[] = []
    rooms?.removeMember.mockImplementation(async () => {
      order.push('remove')
      return { memberId: 'member-1', status: 'removed' }
    })
    const originalInterrupt = subagents.interrupt.bind(subagents)
    vi.spyOn(subagents, 'interrupt').mockImplementation((childId, authority) => {
      order.push('interrupt')
      originalInterrupt(childId, authority)
    })
    resolver.writeSessionBinding.mockImplementation(async (binding: RoleSessionBinding) => {
      order.push(`audit:${binding.state}`)
      resolver.bindings.push(structuredClone(binding))
      if (binding.state === 'active') throw new Error('audit disk full')
    })

    await expect(runtime.startRole(leader(), {
      selector: 'official/reviewer',
      roomId: 'room-1',
    }, new AbortController().signal)).rejects.toThrow('was created but finalization failed')

    expect(order).toEqual(['audit:active', 'remove', 'interrupt', 'audit:orphaned'])
    expect(rooms?.removeMember).toHaveBeenCalledWith(
      expect.anything(),
      'room-1',
      'member-1',
      false,
    )
    expect(resolver.bindings.at(-1)).toMatchObject({ state: 'orphaned', roomMemberId: 'member-1' })
  })

  it('interrupts and audits an orphan when Room attachment fails before returning a member id', async () => {
    const { runtime, rooms, resolver, subagents } = await harness()
    rooms?.attachSession.mockRejectedValueOnce(new Error('Room capacity reached'))

    await expect(runtime.startRole(leader(), {
      selector: 'official/reviewer',
      roomId: 'room-1',
    }, new AbortController().signal)).rejects.toThrow('was created but finalization failed')

    expect(rooms?.removeMember).not.toHaveBeenCalled()
    expect(subagents.interrupts).toEqual([
      expect.objectContaining({ childId: 'child-1' }),
    ])
    expect(resolver.bindings).toEqual([
      expect.objectContaining({
        state: 'orphaned',
        roomId: 'room-1',
        sessionId: 'child-1',
      }),
    ])
    expect(resolver.bindings[0]).not.toHaveProperty('roomMemberId')
  })

  it('fails before creating a child when a requested Room service is unavailable', async () => {
    const { runtime, subagents, resolver } = await harness({ rooms: false })

    await expect(runtime.startRole(leader(), {
      selector: 'official/reviewer',
      roomId: 'missing-room',
    }, new AbortController().signal)).rejects.toThrow('Agent Team Room is not available')
    expect(resolver.install).not.toHaveBeenCalled()
    expect(subagents.startContinuable).not.toHaveBeenCalled()
  })
})
