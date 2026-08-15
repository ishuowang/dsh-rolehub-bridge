import { Context, Service } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Config, type Config as BridgeConfig } from './config.js';
import { RoleHubResolver } from './resolver.js';
import { type BridgeSnapshot, type HubCatalogSnapshot, type HubRole, type LoadedRoleDeployment, type RoleSessionBinding, type RoleView, type StartRoleInput, type StartRoleResult } from './types.js';
export * from './types.js';
export { Config, RoleHubResolver };
export type { BridgeConfig };
export { createEffectivePolicy, assertEffectivePolicy, bindingsForGrants, } from './policy.js';
export { createGitReadTool, buildGitReadArgs, ROLEHUB_GIT_READ_TOOL, } from './git-tool.js';
export { RoleHubProvider, createRoleHubContinuableSetup, providerNameForBundleDigest, } from './provider.js';
export declare const name = "rolehub-bridge";
export declare const inject: string[];
interface ResolverContract {
    init(): Promise<void>;
    refreshCatalogs(signal?: AbortSignal): Promise<HubCatalogSnapshot[]>;
    listRoles(): RoleView[];
    resolveRole(selector: string): HubRole;
    install(selectorOrRole: string | HubRole, signal?: AbortSignal): Promise<LoadedRoleDeployment>;
    loadDeployments(): Promise<LoadedRoleDeployment[]>;
    getDeployment(bundleDigestOrProviderName: string): LoadedRoleDeployment | undefined;
    writeSessionBinding(binding: RoleSessionBinding): Promise<void>;
    listSessionBindings(): RoleSessionBinding[] | Promise<RoleSessionBinding[]>;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        roleHubBridge: RoleHubBridgeRuntime;
    }
}
/** Verified RoleHub deployments and continuable role Session orchestration. */
export declare class RoleHubBridgeRuntime extends Service {
    private readonly config;
    static inject: string[];
    static Config: import("@deepseek-ai/schemastery").default<Config>;
    private readonly resolver;
    private readonly registeredProviders;
    private readonly registryDisposers;
    constructor(ctx: Context, config: BridgeConfig, resolver?: ResolverContract);
    [Service.init](): AsyncGenerator<() => void, void, void>;
    listHubs(): Array<{
        id: string;
        catalogUrl: string;
    }>;
    listRoles(): RoleView[];
    refresh(signal: AbortSignal): Promise<{
        roleCount: number;
        hubs: Array<{
            id: string;
            source: 'network' | 'cache';
            fetchedAt: string;
        }>;
    }>;
    inspectRole(selector: string): RoleView;
    listSessions(parent: Agent): Promise<RoleSessionBinding[]>;
    snapshot(parent: Agent): BridgeSnapshot;
    /**
     * Install and start one pinned role through the Host-only continuable path.
     * The child id is returned as soon as its first prompt reaches its inbox.
     */
    startRole(parent: Agent, input: StartRoleInput, signal: AbortSignal): Promise<StartRoleResult>;
    private ensureProvider;
    private orphanStartedSession;
}
export default RoleHubBridgeRuntime;
//# sourceMappingURL=index.d.ts.map