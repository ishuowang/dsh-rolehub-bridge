import type { CapabilityId, LoadedRole } from '@ishuowang/rolehub-core'
import { describe, expect, it } from 'vitest'

import {
  assertEffectivePolicy,
  createEffectivePolicy,
} from '../src/policy.js'

const BUNDLE_DIGEST = 'b'.repeat(64)

function role(
  required: CapabilityId[],
  optional: CapabilityId[] = [],
  denied: CapabilityId[] = [],
): LoadedRole {
  return {
    root: '/tmp/role',
    manifestPath: '/tmp/role/role.yaml',
    manifestDigest: 'a'.repeat(64),
    bundleDigest: BUNDLE_DIGEST,
    prompt: 'Work within the declared role.',
    skills: [],
    manifest: {
      apiVersion: 'rolehub.dev/v1alpha1',
      kind: 'AgentRole',
      metadata: {
        id: 'io.example/reviewer',
        name: 'reviewer',
        version: '1.0.0',
        displayName: 'Reviewer',
        description: 'Reviews changes.',
        publisher: 'io.example',
        license: 'Apache-2.0',
        tags: ['review'],
      },
      spec: {
        prompt: { path: 'prompt.md', mode: 'append' },
        skills: [],
        capabilities: {
          required: required.map(id => ({ id, reason: `Required ${id}` })),
          optional: optional.map(id => ({ id, reason: `Optional ${id}`, approval: 'ask' as const })),
          denied: denied.map(id => ({ id, reason: `Denied ${id}` })),
        },
        isolation: {
          scope: 'session',
          context: 'workspace',
          filesystem: 'workspace-write',
          network: 'approval-required',
        },
        limits: { maxTurns: 12 },
        secrets: [],
        evals: { path: 'evals/cases.yaml' },
      },
    },
  }
}

describe('createEffectivePolicy()', () => {
  it('grants required, allowlisted, bridge-supported capabilities', () => {
    const loaded = role(
      ['filesystem.read', 'source-control.read'],
      ['network.fetch'],
    )

    const result = createEffectivePolicy(loaded, [
      'filesystem.read',
      'source-control.read',
      'network.fetch',
    ])

    expect(result.policy.grants).toEqual(['filesystem.read', 'source-control.read'])
    expect(result.bindings).toEqual({
      'filesystem.read': ['glob', 'grep', 'read', 'read_image'],
      'source-control.read': ['rolehub_git_read'],
    })
    expect(result.policy.enforcement).toMatchObject({
      filesystem: 'tool-policy',
      network: 'none',
      approvals: 'none',
      process: 'shared',
      configuration: 'isolated',
    })
    expect(result.policy.policyDigest).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('fails loud when any required capability is unavailable or unsupported', () => {
    expect(() => createEffectivePolicy(role(['filesystem.read']), [])).toThrow(
      'cannot grant required capabilities: filesystem.read',
    )
    expect(() => createEffectivePolicy(role(['shell.execute']), ['shell.execute'])).toThrow(
      'cannot grant required capabilities: shell.execute',
    )
  })

  it('defaults optional capabilities to deny even when the Host allowlists them', () => {
    const result = createEffectivePolicy(role([], ['network.fetch', 'room.message']), [
      'network.fetch',
      'room.message',
    ])

    expect(result.policy.grants).toEqual([])
    expect(result.bindings).toEqual({})
    expect(result.policy.enforcement).toMatchObject({ network: 'none', room: 'none' })
  })
})

describe('assertEffectivePolicy()', () => {
  it('accepts an intact generated receipt and fixed bindings', () => {
    const loaded = role(['filesystem.read'])
    const generated = createEffectivePolicy(loaded, ['filesystem.read'])
    expect(() => assertEffectivePolicy(loaded, generated.policy, generated.bindings)).not.toThrow()
  })

  it('rejects a changed digest or a role-controlled binding substitution', () => {
    const loaded = role(['source-control.read'])
    const generated = createEffectivePolicy(loaded, ['source-control.read'])

    expect(() => assertEffectivePolicy(loaded, {
      ...generated.policy,
      policyDigest: '0'.repeat(64),
    }, generated.bindings)).toThrow('policy digest')
    expect(() => assertEffectivePolicy(loaded, generated.policy, {
      'source-control.read': ['bash'],
    })).toThrow('not the fixed Host binding')
  })
})
