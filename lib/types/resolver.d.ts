import { type Config } from './config.js';
import { type HubCatalogSnapshot, type HubRole, type LoadedRoleDeployment, type RoleSessionBinding, type RoleView } from './types.js';
interface ResolverOptions {
    fetch?: typeof globalThis.fetch;
    now?: () => Date;
}
/**
 * Resolves untrusted, multi-Hub metadata into digest-pinned local deployments.
 * Network catalogs are never authoritative for grants; they only select bytes
 * that must subsequently pass RoleHub core validation and Host policy.
 */
export declare class RoleHubResolver {
    private readonly config;
    private readonly storage;
    private readonly fetchImpl;
    private readonly now;
    private snapshots;
    private deployments;
    private sessionBindings;
    private operationQueue;
    private sessionWriteQueue;
    private initialized;
    constructor(config: Config, options?: ResolverOptions);
    init(): Promise<void>;
    /** Refresh every configured Hub, falling back only for temporary availability failures. */
    refreshCatalogs(signal?: AbortSignal): Promise<HubCatalogSnapshot[]>;
    private refreshCatalogsUnlocked;
    listRoles(): RoleView[];
    resolveRole(selector: string): HubRole;
    install(selectorOrRole: string | HubRole, signal?: AbortSignal): Promise<LoadedRoleDeployment>;
    private installUnlocked;
    /** Reload and fully revalidate every persisted role. Called during init and safe to repeat. */
    loadDeployments(): Promise<LoadedRoleDeployment[]>;
    getDeployment(bundleDigestOrProviderName: string): LoadedRoleDeployment | undefined;
    writeSessionBinding(binding: RoleSessionBinding): Promise<void>;
    listSessionBindings(): RoleSessionBinding[];
    private refreshOneHub;
    private canonicalRole;
    private requireSnapshot;
    private verifyLoadedRole;
    private authorizeRole;
    private verifyDeploymentRecord;
    private authorizePersistedRole;
    private assertDeploymentAgainstCatalog;
    private assertReady;
    private enqueueOperation;
}
export {};
//# sourceMappingURL=resolver.d.ts.map