import z from '@deepseek-ai/schemastery';
import { type CapabilityId } from '@ishuowang/rolehub-core';
export interface HubConfig {
    /** Stable local name used in selectors such as `official/software-engineer`. */
    id: string;
    /** HTTPS URL serving a RoleHub v1alpha2 catalog. */
    catalogUrl: string;
    /** HTTPS archive template with `{name}` and `{version}` placeholders. */
    archiveUrlTemplate: string;
    /** Publisher ids trusted only when discovered through this exact Hub configuration. */
    trustedPublishers: string[];
    /** Exact HTTPS hostnames accepted as redirect targets in addition to the request host. */
    allowedRedirectHosts: string[];
}
export declare const DEFAULT_HUB: HubConfig;
export declare const DEFAULT_ALLOWED_CAPABILITIES: readonly CapabilityId[];
export interface Config {
    /** Empty uses `$DSH_HOME/rolehub-bridge`, falling back to `~/.dsh/rolehub-bridge`. */
    storageDir: string;
    hubs: HubConfig[];
    allowCommunityRoles: boolean;
    allowedCapabilities: CapabilityId[];
    fetchTimeoutMs: number;
    maxCatalogCacheAgeMs: number;
    maxCatalogBytes: number;
    maxArchiveBytes: number;
    /** Optional DSH model-provider override for newly created role Sessions. */
    agentProvider: string;
    /** Optional DSH model override for newly created role Sessions. */
    agentModel: string;
}
export declare const Config: z<Config>;
export declare function resolveStorageDir(configured: string): string;
export declare function assertConfig(config: Config): void;
//# sourceMappingURL=config.d.ts.map