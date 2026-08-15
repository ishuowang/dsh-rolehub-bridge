import { type CapabilityId, type LoadedRole } from '@ishuowang/rolehub-core';
import type { LoadedEffectivePolicy } from '@ishuowang/rolehub-compat-sdk';
export interface EffectiveRolePolicy {
    policy: LoadedEffectivePolicy;
    bindings: Record<string, string[]>;
}
/** Capabilities for which this Host has a fixed, non-role-controlled implementation. */
export declare const HOST_SUPPORTED_CAPABILITIES: ReadonlySet<CapabilityId>;
/**
 * Resolve a RoleHub request without granting optional capabilities implicitly.
 *
 * A bundle can only narrow this result: grants are required requests intersected
 * with the configured Host allowlist and the bridge's fixed capability map.
 */
export declare function createEffectivePolicy(role: LoadedRole, allowedCapabilities: readonly CapabilityId[]): EffectiveRolePolicy;
/** Return detached copies of Host-owned bindings for only the effective grants. */
export declare function bindingsForGrants(grants: readonly CapabilityId[]): Record<string, string[]>;
/** Re-check a persisted receipt before it is mounted into a fresh Activation. */
export declare function assertEffectivePolicy(role: LoadedRole, policy: LoadedEffectivePolicy, bindings: Readonly<Record<string, readonly string[]>>): void;
//# sourceMappingURL=policy.d.ts.map