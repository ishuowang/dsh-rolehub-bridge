import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LoadedRole } from '@ishuowang/rolehub-core'
import {
  snapshotSubagentDescriptor,
  type ContinuableCreateRequest,
  type ResolvedSubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import { createEffectivePolicy } from '../src/policy.js'
import {
  RoleHubProvider,
  createRoleHubContinuableSetup,
  providerNameForBundleDigest,
} from '../src/provider.js'
import {
  DEPLOYMENT_SCHEMA_VERSION,
  type LoadedRoleDeployment,
} from '../src/types.js'

const BUNDLE_DIGEST = 'b'.repeat(64)
const MANIFEST_DIGEST = 'a'.repeat(64)

function loadedRole(): LoadedRole {
  return {
    root: '/roles/reviewer',
    manifestPath: '/roles/reviewer/role.yaml',
    manifestDigest: MANIFEST_DIGEST,
    bundleDigest: BUNDLE_DIGEST,
    prompt: 'Review carefully.',
    skills: [{
      name: 'review-evidence',
      description: 'Collect review evidence.',
      path: '/roles/reviewer/skills/review-evidence/SKILL.md',
      content: '# Review evidence\n',
      required: true,
    }],
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
        skills: [{ name: 'review-evidence', path: 'skills/review-evidence', required: true }],
        capabilities: {
          required: [{ id: 'source-control.read', reason: 'Read repository state.' }],
          optional: [{ id: 'network.fetch', reason: 'Optional docs.', approval: 'ask' }],
          denied: [{ id: 'source-control.write', reason: 'No repository mutation.' }],
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

function deployment(): LoadedRoleDeployment {
  const role = loadedRole()
  const effective = createEffectivePolicy(role, ['source-control.read'])
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

function descriptorEvent(provider: string): SessionEvent {
  return {
    type: 'subagent/descriptor',
    data: snapshotSubagentDescriptor({
      mode: 'continuable',
      provider,
      label: 'Reviewer',
    }),
  } as unknown as SessionEvent
}

function activationContext(
  provider: string,
  events: string[],
  failAt?: 'skill',
): Context {
  const disposer = (name: string): (() => void) => {
    events.push(`install:${name}`)
    return () => events.push(`dispose:${name}`)
  }
  return {
    agent: { session: { events: [descriptorEvent(provider)] } },
    systemPrompt: { section: vi.fn(() => disposer('prompt')) },
    skills: {
      register: vi.fn(() => {
        if (failAt === 'skill') throw new Error('skill registry failed')
        return disposer('skill')
      }),
    },
    tools: {
      register: vi.fn(() => disposer('git')),
      restrict: vi.fn(() => disposer('restrict')),
      guard: vi.fn(() => disposer('guard')),
    },
  } as unknown as Context
}

describe('RoleHubProvider', () => {
  it('derives one provider identity per digest and rejects the one-shot path', async () => {
    const provider = new RoleHubProvider(BUNDLE_DIGEST)

    expect(provider.name).toBe(`rolehub-bridge-${BUNDLE_DIGEST}`)
    expect(provider.capabilities).toEqual({
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    })
    await expect(provider.start({} as ResolvedSubagentStartRequest)).rejects.toThrow(
      'rejects one-shot reuse',
    )
  })

  it('prepares only a detached empty continuable spec and observes cancellation', async () => {
    const provider = new RoleHubProvider(BUNDLE_DIGEST)
    const controller = new AbortController()
    const request = {
      sessionId: 'child-1',
      parent: {} as Agent,
      signal: controller.signal,
    } as ContinuableCreateRequest

    await expect(provider.prepareContinuable(request)).resolves.toEqual({})
    controller.abort()
    await expect(provider.prepareContinuable(request)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects invalid digests and provider aliases', () => {
    expect(() => providerNameForBundleDigest('not-a-digest')).toThrow('64 lowercase')
    expect(() => new RoleHubProvider(BUNDLE_DIGEST, 'rolehub-bridge-alias')).toThrow(
      'must be derived',
    )
  })
})

describe('createRoleHubContinuableSetup()', () => {
  it('revalidates the pinned deployment, installs through a facade, and disposes everything in reverse', () => {
    const installed = deployment()
    const events: string[] = []
    const setup = createRoleHubContinuableSetup({
      getDeployment: vi.fn(() => installed),
    })
    const childCtx = activationContext(installed.record.providerName, events)

    const dispose = setup(childCtx)

    expect(events).toEqual([
      'install:git',
      'install:prompt',
      'install:skill',
      'install:restrict',
      'install:guard',
    ])
    dispose()
    dispose()
    expect(events.slice(5)).toEqual([
      'dispose:guard',
      'dispose:restrict',
      'dispose:skill',
      'dispose:prompt',
      'dispose:git',
    ])
  })

  it('rolls back every earlier registration when setup fails part-way', () => {
    const installed = deployment()
    const events: string[] = []
    const setup = createRoleHubContinuableSetup({ getDeployment: () => installed })

    expect(() => setup(activationContext(installed.record.providerName, events, 'skill'))).toThrow(
      'skill registry failed',
    )
    expect(events).toEqual([
      'install:git',
      'install:prompt',
      'dispose:prompt',
      'dispose:git',
    ])
  })

  it('leaves unrelated continuable providers untouched', () => {
    const events: string[] = []
    const lookup = vi.fn()
    const setup = createRoleHubContinuableSetup({ getDeployment: lookup })

    const dispose = setup(activationContext('spawn', events))

    expect(events).toEqual([])
    expect(lookup).not.toHaveBeenCalled()
    expect(() => dispose()).not.toThrow()
  })

  it('fails before registration when the durable provider has no exact verified deployment', () => {
    const provider = providerNameForBundleDigest(BUNDLE_DIGEST)
    const events: string[] = []
    const setup = createRoleHubContinuableSetup({ getDeployment: () => undefined })

    expect(() => setup(activationContext(provider, events))).toThrow('no verified deployment')
    expect(events).toEqual([])
  })
})
