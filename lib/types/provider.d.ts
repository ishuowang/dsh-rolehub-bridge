import type { Context } from '@deepseek-ai/cordis';
import { type ContinuableCreateRequest, type ContinuableCreateSpec, type ResolvedSubagentStartRequest, type SubagentProvider, type SubagentRun } from '@deepseek-ai/dsh-subagent';
import { type LoadedRoleDeployment } from './types.js';
export interface DeploymentLookup {
    getDeployment(bundleDigestOrProviderName: string): LoadedRoleDeployment | undefined;
}
export declare function providerNameForBundleDigest(bundleDigest: string): string;
/**
 * Role providers exist only to reserve a durable descriptor for continuable
 * Sessions. The ordinary one-shot subagent path is deliberately unavailable.
 */
export declare class RoleHubProvider implements SubagentProvider {
    readonly bundleDigest: string;
    readonly name: string;
    readonly capabilities: {
        readonly outputSchema: false;
        readonly depthLimit: false;
        readonly toolFilter: false;
        readonly persona: false;
    };
    readonly inheritsParentContext = false;
    constructor(bundleDigest: string, name?: string);
    start(_request: ResolvedSubagentStartRequest): Promise<SubagentRun>;
    prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>;
}
/**
 * Build the single global continuation contribution. Non-RoleHub children are
 * untouched; RoleHub children are re-bound from their durable provider digest.
 */
export declare function createRoleHubContinuableSetup(deployments: DeploymentLookup): (childCtx: Context) => () => void;
export declare function assertDeploymentMatchesProvider(deployment: LoadedRoleDeployment, providerName: string): void;
//# sourceMappingURL=provider.d.ts.map