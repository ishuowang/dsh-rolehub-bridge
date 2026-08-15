import { type RoleDeploymentRecord, type RoleSessionBinding } from './types.js';
/**
 * Small, deliberately boring filesystem store. Receipt filenames never contain
 * caller-controlled ids, writes are same-directory atomic renames, and every
 * read rejects symlinks and non-private permissions.
 */
export declare class RoleHubStorage {
    readonly rootDir: string;
    readonly catalogsDir: string;
    readonly rolesDir: string;
    readonly deploymentsDir: string;
    readonly sessionsDir: string;
    readonly stagingDir: string;
    constructor(rootDir: string);
    init(): Promise<void>;
    readCatalogCache(hubId: string): Promise<unknown | undefined>;
    writeCatalogCache(hubId: string, value: unknown): Promise<void>;
    createInstallStaging(): Promise<string>;
    roleRoot(bundleDigest: string): string;
    commitRoleRoot(stagedRoleRoot: string, bundleDigest: string): Promise<string>;
    removeStaging(directory: string): Promise<void>;
    writeDeploymentRecord(record: RoleDeploymentRecord): Promise<void>;
    listDeploymentRecords(): Promise<RoleDeploymentRecord[]>;
    writeSessionBinding(binding: RoleSessionBinding): Promise<void>;
    listSessionBindings(): Promise<RoleSessionBinding[]>;
}
export declare function parseDeploymentRecord(value: unknown): RoleDeploymentRecord;
export declare function parseSessionBinding(value: unknown): RoleSessionBinding;
//# sourceMappingURL=storage.d.ts.map