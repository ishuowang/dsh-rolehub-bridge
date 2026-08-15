import {
  sha256,
  stableJson,
  type CapabilityId,
  type LoadedRole,
} from '@ishuowang/rolehub-core'
import type {
  EffectivePolicyReceipt,
  LoadedEffectivePolicy,
} from '@ishuowang/rolehub-compat-sdk'

import { HOST_TOOL_BINDINGS } from './types.js'

export interface EffectiveRolePolicy {
  policy: LoadedEffectivePolicy
  bindings: Record<string, string[]>
}

/** Capabilities for which this Host has a fixed, non-role-controlled implementation. */
export const HOST_SUPPORTED_CAPABILITIES: ReadonlySet<CapabilityId> = new Set(
  Object.keys(HOST_TOOL_BINDINGS) as CapabilityId[],
)

/**
 * Resolve a RoleHub request without granting optional capabilities implicitly.
 *
 * A bundle can only narrow this result: grants are required requests intersected
 * with the configured Host allowlist and the bridge's fixed capability map.
 */
export function createEffectivePolicy(
  role: LoadedRole,
  allowedCapabilities: readonly CapabilityId[],
): EffectiveRolePolicy {
  const hostAllowed = new Set(allowedCapabilities)
  const denied = new Set(role.manifest.spec.capabilities.denied.map(request => request.id))
  const grants = role.manifest.spec.capabilities.required
    .map(request => request.id)
    .filter(capability => (
      hostAllowed.has(capability)
      && HOST_SUPPORTED_CAPABILITIES.has(capability)
      && !denied.has(capability)
    ))
  const granted = new Set(grants)
  const missing = role.manifest.spec.capabilities.required
    .map(request => request.id)
    .filter(capability => !granted.has(capability))
  if (missing.length > 0) {
    throw new Error(
      `rolehub-bridge: Host policy cannot grant required capabilities: ${missing.join(', ')}`,
    )
  }

  const receipt: EffectivePolicyReceipt = {
    apiVersion: 'rolehub.dev/policy/v1alpha1',
    kind: 'EffectiveRolePolicy',
    role: {
      id: role.manifest.metadata.id,
      bundleDigest: role.bundleDigest,
    },
    compatibility: 'dsharness',
    grants,
    enforcement: {
      filesystem: grants.some(isFilesystemCapability) ? 'tool-policy' : 'none',
      network: grants.some(isNetworkCapability) ? 'tool-policy' : 'none',
      approvals: 'none',
      room: grants.includes('room.message') ? 'broker' : 'none',
      process: 'shared',
      configuration: 'isolated',
    },
  }

  return {
    policy: {
      ...receipt,
      policyDigest: sha256(stableJson(receipt)),
    },
    bindings: bindingsForGrants(grants),
  }
}

/** Return detached copies of Host-owned bindings for only the effective grants. */
export function bindingsForGrants(
  grants: readonly CapabilityId[],
): Record<string, string[]> {
  const bindings: Record<string, string[]> = {}
  for (const capability of grants) {
    const tools = HOST_TOOL_BINDINGS[capability]
    if (tools === undefined) continue
    bindings[capability] = [...tools]
  }
  return bindings
}

/** Re-check a persisted receipt before it is mounted into a fresh Activation. */
export function assertEffectivePolicy(
  role: LoadedRole,
  policy: LoadedEffectivePolicy,
  bindings: Readonly<Record<string, readonly string[]>>,
): void {
  const expectedReceipt: EffectivePolicyReceipt = {
    apiVersion: policy.apiVersion,
    kind: policy.kind,
    role: policy.role,
    compatibility: policy.compatibility,
    grants: policy.grants,
    enforcement: policy.enforcement,
  }
  const expectedDigest = sha256(stableJson(expectedReceipt))
  if (policy.policyDigest !== expectedDigest) {
    throw new Error('rolehub-bridge: effective policy digest no longer matches its receipt')
  }
  if (
    policy.apiVersion !== 'rolehub.dev/policy/v1alpha1'
    || policy.kind !== 'EffectiveRolePolicy'
    || policy.compatibility !== 'dsharness'
    || policy.role.id !== role.manifest.metadata.id
    || policy.role.bundleDigest !== role.bundleDigest
  ) {
    throw new Error('rolehub-bridge: effective policy does not match the pinned role bundle')
  }

  const required = new Set(role.manifest.spec.capabilities.required.map(request => request.id))
  const denied = new Set(role.manifest.spec.capabilities.denied.map(request => request.id))
  if (new Set(policy.grants).size !== policy.grants.length) {
    throw new Error('rolehub-bridge: persisted policy contains duplicate grants')
  }
  for (const grant of policy.grants) {
    if (!required.has(grant) || denied.has(grant)) {
      throw new Error(`rolehub-bridge: invalid persisted capability grant ${grant}`)
    }
    const fixed = HOST_TOOL_BINDINGS[grant]
    const persisted = bindings[grant]
    if (fixed === undefined || persisted === undefined || !sameStrings(fixed, persisted)) {
      throw new Error(`rolehub-bridge: persisted binding for ${grant} is not the fixed Host binding`)
    }
  }

  const granted = new Set(policy.grants)
  const missing = [...required].filter(capability => !granted.has(capability))
  if (missing.length > 0) {
    throw new Error(`rolehub-bridge: persisted policy omits required capabilities: ${missing.join(', ')}`)
  }

  const regenerated = createEffectivePolicy(role, policy.grants)
  if (
    !sameStrings(regenerated.policy.grants, policy.grants)
    || stableJson(regenerated.policy.enforcement) !== stableJson(policy.enforcement)
  ) {
    throw new Error('rolehub-bridge: persisted policy differs from current Host enforcement')
  }

  for (const capability of Object.keys(bindings)) {
    if (!policy.grants.includes(capability as CapabilityId)) {
      throw new Error(`rolehub-bridge: persisted binding exists outside policy grants: ${capability}`)
    }
  }
}

function isFilesystemCapability(capability: CapabilityId): boolean {
  return capability === 'filesystem.read'
    || capability === 'filesystem.write'
    || capability === 'source-control.read'
}

function isNetworkCapability(capability: CapabilityId): boolean {
  return capability === 'network.fetch' || capability === 'web.search'
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
