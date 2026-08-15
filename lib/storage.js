import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm, unlink, } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CAPABILITY_IDS, stableJson } from '@ishuowang/rolehub-core';
import { DEPLOYMENT_SCHEMA_VERSION, SESSION_BINDING_SCHEMA_VERSION, } from './types.js';
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_CATALOG_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_STORAGE_MARKER_BYTES = 4 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const TOOL_NAME = /^[A-Za-z0-9_.:-]+$/u;
const STORAGE_MARKER = '.dsh-rolehub-bridge-storage.json';
const STORAGE_MARKER_VALUE = {
    schemaVersion: 1,
    owner: 'dsh-rolehub-bridge',
};
/**
 * Small, deliberately boring filesystem store. Receipt filenames never contain
 * caller-controlled ids, writes are same-directory atomic renames, and every
 * read rejects symlinks and non-private permissions.
 */
export class RoleHubStorage {
    rootDir;
    catalogsDir;
    rolesDir;
    deploymentsDir;
    sessionsDir;
    stagingDir;
    constructor(rootDir) {
        this.rootDir = path.resolve(rootDir);
        this.catalogsDir = path.join(this.rootDir, 'catalogs');
        this.rolesDir = path.join(this.rootDir, 'roles');
        this.deploymentsDir = path.join(this.rootDir, 'deployments');
        this.sessionsDir = path.join(this.rootDir, 'sessions');
        this.stagingDir = path.join(this.rootDir, 'staging');
    }
    async init() {
        assertNonDangerousStorageRoot(this.rootDir);
        await claimStorageRoot(this.rootDir);
        for (const directory of [
            this.catalogsDir,
            this.rolesDir,
            this.deploymentsDir,
            this.sessionsDir,
            this.stagingDir,
        ]) {
            await ensureOwnedDirectory(directory);
        }
    }
    async readCatalogCache(hubId) {
        return readOptionalPrivateJson(path.join(this.catalogsDir, `${safeHubId(hubId)}.json`), MAX_CATALOG_CACHE_BYTES);
    }
    async writeCatalogCache(hubId, value) {
        await atomicWriteJson(path.join(this.catalogsDir, `${safeHubId(hubId)}.json`), value);
    }
    async createInstallStaging() {
        await assertPrivateDirectory(this.stagingDir);
        const directory = await mkdtemp(path.join(this.stagingDir, 'install-'));
        await chmod(directory, PRIVATE_DIRECTORY_MODE);
        return directory;
    }
    roleRoot(bundleDigest) {
        return path.join(this.rolesDir, assertDigest(bundleDigest));
    }
    async commitRoleRoot(stagedRoleRoot, bundleDigest) {
        const destination = this.roleRoot(bundleDigest);
        const source = path.resolve(stagedRoleRoot);
        if (!source.startsWith(`${this.stagingDir}${path.sep}`)) {
            throw new Error('rolehub-bridge: staged role is outside the private staging directory');
        }
        const sourceStat = await lstat(source);
        if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
            throw new Error('rolehub-bridge: staged role root must be a real directory');
        }
        const existing = await safeLstat(destination);
        if (existing) {
            if (!existing.isDirectory() || existing.isSymbolicLink()) {
                throw new Error(`rolehub-bridge: installed role path is unsafe: ${destination}`);
            }
            return destination;
        }
        try {
            await rename(source, destination);
        }
        catch (error) {
            const code = error.code;
            if (code !== 'EEXIST' && code !== 'ENOTEMPTY')
                throw error;
            const raced = await lstat(destination);
            if (!raced.isDirectory() || raced.isSymbolicLink())
                throw error;
        }
        return destination;
    }
    async removeStaging(directory) {
        const target = path.resolve(directory);
        if (!target.startsWith(`${this.stagingDir}${path.sep}`)) {
            throw new Error('rolehub-bridge: refusing to remove a path outside staging');
        }
        await rm(target, { recursive: true, force: true });
    }
    async writeDeploymentRecord(record) {
        const validated = parseDeploymentRecord(record);
        await atomicWriteJson(path.join(this.deploymentsDir, `${validated.role.bundleDigest}.json`), validated);
    }
    async listDeploymentRecords() {
        const records = await readReceiptDirectory(this.deploymentsDir, parseDeploymentRecord);
        for (const { filename, value } of records) {
            if (filename !== `${value.role.bundleDigest}.json`) {
                throw new Error(`rolehub-bridge: deployment receipt filename does not match ${value.role.bundleDigest}`);
            }
        }
        return records.map(entry => entry.value);
    }
    async writeSessionBinding(binding) {
        const validated = parseSessionBinding(binding);
        await atomicWriteJson(path.join(this.sessionsDir, `${sessionFilename(validated.sessionId)}.json`), validated);
    }
    async listSessionBindings() {
        return readSessionBindingsStrict(this.sessionsDir);
    }
}
async function readSessionBindingsStrict(directory) {
    const files = await receiptFiles(directory);
    const values = [];
    const ids = new Set();
    for (const file of files) {
        const value = parseSessionBinding(await readPrivateJson(path.join(directory, file.name)));
        if (file.name !== `${sessionFilename(value.sessionId)}.json`) {
            throw new Error(`rolehub-bridge: Session receipt filename does not match ${value.sessionId}`);
        }
        if (ids.has(value.sessionId)) {
            throw new Error(`rolehub-bridge: duplicate Session binding ${value.sessionId}`);
        }
        ids.add(value.sessionId);
        values.push(value);
    }
    return values;
}
async function readReceiptDirectory(directory, parse) {
    const files = await receiptFiles(directory);
    const values = [];
    for (const file of files) {
        values.push({
            filename: file.name,
            value: parse(await readPrivateJson(path.join(directory, file.name))),
        });
    }
    return values;
}
async function receiptFiles(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
        .filter(entry => entry.name.endsWith('.json'))
        .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
        if (!entry.isFile()) {
            throw new Error(`rolehub-bridge: receipt must be a regular file: ${entry.name}`);
        }
    }
    return entries;
}
async function atomicWriteJson(destination, value) {
    await assertPrivateDirectory(path.dirname(destination));
    await atomicWriteJsonUnchecked(destination, value);
}
async function atomicWriteJsonUnchecked(destination, value) {
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
    let handle;
    try {
        handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, PRIVATE_FILE_MODE);
        await handle.writeFile(stableJson(value), 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, destination);
        await chmod(destination, PRIVATE_FILE_MODE);
        await syncDirectory(path.dirname(destination));
    }
    finally {
        await handle?.close().catch(() => undefined);
        await unlink(temporary).catch((error) => {
            if (error.code !== 'ENOENT')
                throw error;
        });
    }
}
async function claimStorageRoot(root) {
    const before = await safeLstat(root);
    if (before === undefined) {
        const created = await mkdir(root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
        if (created !== undefined)
            await chmod(root, PRIVATE_DIRECTORY_MODE);
    }
    await assertPrivateDirectory(root);
    const marker = path.join(root, STORAGE_MARKER);
    const markerStat = await safeLstat(marker);
    if (markerStat !== undefined) {
        await validateStorageMarker(marker);
        return;
    }
    const entries = await readdir(root);
    if (entries.length !== 0) {
        throw new Error(`rolehub-bridge: refusing non-empty unclaimed storage directory: ${root}`);
    }
    await atomicWriteJsonUnchecked(marker, STORAGE_MARKER_VALUE);
}
async function ensureOwnedDirectory(directory) {
    const existing = await safeLstat(directory);
    if (existing !== undefined) {
        await assertPrivateDirectory(directory);
        return;
    }
    try {
        await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
        await chmod(directory, PRIVATE_DIRECTORY_MODE);
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    await assertPrivateDirectory(directory);
}
async function assertPrivateDirectory(directory) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`rolehub-bridge: storage path is not a real directory: ${directory}`);
    }
    if ((stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
        throw new Error(`rolehub-bridge: storage directory permissions must be 0700: ${directory}`);
    }
}
async function validateStorageMarker(marker) {
    const value = record(await readPrivateJson(marker, MAX_STORAGE_MARKER_BYTES), 'storage ownership marker');
    exactKeys(value, ['schemaVersion', 'owner'], 'storage ownership marker');
    if (value['schemaVersion'] !== STORAGE_MARKER_VALUE.schemaVersion ||
        value['owner'] !== STORAGE_MARKER_VALUE.owner) {
        invalid('storage ownership marker');
    }
}
function assertNonDangerousStorageRoot(root) {
    const dangerous = new Set([
        path.parse(root).root,
        path.resolve(os.homedir()),
        path.resolve(os.tmpdir()),
        path.resolve(process.cwd()),
    ]);
    const dshHome = process.env['DSH_HOME']?.trim();
    if (dshHome)
        dangerous.add(path.resolve(dshHome));
    if (dangerous.has(root)) {
        throw new Error(`rolehub-bridge: refusing dangerous storage root: ${root}`);
    }
}
async function syncDirectory(directory) {
    const handle = await open(directory, constants.O_RDONLY);
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
async function readOptionalPrivateJson(file, maximumBytes = MAX_RECEIPT_BYTES) {
    try {
        return await readPrivateJson(file, maximumBytes);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
async function readPrivateJson(file, maximumBytes = MAX_RECEIPT_BYTES) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if (!stat.isFile())
            throw new Error(`rolehub-bridge: receipt is not a regular file: ${file}`);
        if ((stat.mode & 0o777) !== PRIVATE_FILE_MODE) {
            throw new Error(`rolehub-bridge: receipt permissions must be 0600: ${file}`);
        }
        if (!Number.isSafeInteger(stat.size) || stat.size > maximumBytes) {
            throw new Error(`rolehub-bridge: receipt exceeds ${maximumBytes} bytes: ${file}`);
        }
        const chunks = [];
        let total = 0;
        for (;;) {
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes - total + 1));
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
            if (bytesRead === 0)
                break;
            total += bytesRead;
            if (total > maximumBytes) {
                throw new Error(`rolehub-bridge: receipt exceeds ${maximumBytes} bytes: ${file}`);
            }
            chunks.push(chunk.subarray(0, bytesRead));
        }
        const raw = Buffer.concat(chunks, total).toString('utf8');
        try {
            return JSON.parse(raw);
        }
        catch {
            throw new Error(`rolehub-bridge: invalid JSON receipt: ${file}`);
        }
    }
    finally {
        await handle.close();
    }
}
export function parseDeploymentRecord(value) {
    const root = record(value, 'deployment receipt');
    exactKeys(root, [
        'schemaVersion',
        'hubId',
        'catalogUrl',
        'archiveUrl',
        'archiveSha256',
        'roleRoot',
        'role',
        'providerName',
        'policy',
        'bindings',
        'installedAt',
    ], 'deployment receipt');
    if (root['schemaVersion'] !== DEPLOYMENT_SCHEMA_VERSION)
        invalid('deployment schemaVersion');
    string(root['hubId'], 'deployment hubId');
    string(root['catalogUrl'], 'deployment catalogUrl');
    string(root['archiveUrl'], 'deployment archiveUrl');
    digest(root['archiveSha256'], 'deployment archiveSha256');
    string(root['roleRoot'], 'deployment roleRoot');
    string(root['providerName'], 'deployment providerName');
    isoDate(root['installedAt'], 'deployment installedAt');
    const role = record(root['role'], 'deployment role');
    exactKeys(role, [
        'id',
        'name',
        'displayName',
        'description',
        'publisher',
        'version',
        'tags',
        'trust',
        'manifestDigest',
        'bundleDigest',
    ], 'deployment role');
    for (const key of ['id', 'name', 'displayName', 'description', 'publisher', 'version']) {
        string(role[key], `deployment role.${key}`);
    }
    stringArray(role['tags'], 'deployment role.tags');
    if (role['trust'] !== 'reference' && role['trust'] !== 'community')
        invalid('deployment role.trust');
    digest(role['manifestDigest'], 'deployment role.manifestDigest');
    digest(role['bundleDigest'], 'deployment role.bundleDigest');
    parsePolicy(root['policy']);
    const bindings = record(root['bindings'], 'deployment bindings');
    for (const [capability, tools] of Object.entries(bindings)) {
        if (!CAPABILITY_IDS.includes(capability))
            invalid(`binding capability ${capability}`);
        const names = stringArray(tools, `binding ${capability}`);
        if (names.some((name) => !TOOL_NAME.test(name)))
            invalid(`binding ${capability}`);
    }
    return value;
}
export function parseSessionBinding(value) {
    const root = record(value, 'Session binding');
    exactKeys(root, [
        'schemaVersion',
        'sessionId',
        'parentSessionId',
        'roleBundleDigest',
        'providerName',
        'roomId',
        'roomMemberId',
        'state',
        'createdAt',
    ], 'Session binding', ['roomId', 'roomMemberId']);
    if (root['schemaVersion'] !== SESSION_BINDING_SCHEMA_VERSION)
        invalid('Session schemaVersion');
    for (const key of ['sessionId', 'parentSessionId', 'providerName']) {
        boundedString(root[key], `Session ${key}`, 512);
    }
    digest(root['roleBundleDigest'], 'Session roleBundleDigest');
    if (root['roomId'] !== undefined)
        boundedString(root['roomId'], 'Session roomId', 512);
    if (root['roomMemberId'] !== undefined)
        boundedString(root['roomMemberId'], 'Session roomMemberId', 512);
    if (!['active', 'orphaned', 'revoked'].includes(String(root['state'])))
        invalid('Session state');
    isoDate(root['createdAt'], 'Session createdAt');
    return value;
}
function parsePolicy(value) {
    const policy = record(value, 'deployment policy');
    exactKeys(policy, ['apiVersion', 'kind', 'role', 'compatibility', 'grants', 'enforcement', 'policyDigest'], 'deployment policy');
    if (policy['apiVersion'] !== 'rolehub.dev/policy/v1alpha1')
        invalid('policy apiVersion');
    if (policy['kind'] !== 'EffectiveRolePolicy')
        invalid('policy kind');
    if (policy['compatibility'] !== 'dsharness')
        invalid('policy compatibility');
    digest(policy['policyDigest'], 'policy digest');
    const role = record(policy['role'], 'policy role');
    exactKeys(role, ['id', 'bundleDigest'], 'policy role');
    string(role['id'], 'policy role.id');
    digest(role['bundleDigest'], 'policy role.bundleDigest');
    const grants = stringArray(policy['grants'], 'policy grants');
    if (grants.some((grant) => !CAPABILITY_IDS.includes(grant)))
        invalid('policy grants');
    const enforcement = record(policy['enforcement'], 'policy enforcement');
    exactKeys(enforcement, ['filesystem', 'network', 'approvals', 'room', 'process', 'configuration'], 'policy enforcement');
    enumValue(enforcement['filesystem'], ['none', 'tool-policy', 'os-sandbox'], 'filesystem enforcement');
    enumValue(enforcement['network'], ['none', 'tool-policy', 'egress-policy'], 'network enforcement');
    enumValue(enforcement['approvals'], ['none', 'interactive-broker'], 'approval enforcement');
    enumValue(enforcement['room'], ['none', 'broker'], 'room enforcement');
    enumValue(enforcement['process'], ['shared', 'dedicated'], 'process enforcement');
    enumValue(enforcement['configuration'], ['shared', 'isolated'], 'configuration enforcement');
}
function sessionFilename(sessionId) {
    return createHash('sha256').update(sessionId).digest('hex');
}
function safeHubId(value) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value))
        invalid('Hub id');
    return value;
}
function assertDigest(value) {
    if (!SHA256.test(value))
        invalid('bundle digest');
    return value;
}
function digest(value, label) {
    if (typeof value !== 'string' || !SHA256.test(value))
        invalid(label);
}
function record(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        invalid(label);
    return value;
}
function exactKeys(value, keys, label, optional = []) {
    const allowed = new Set(keys);
    const required = new Set(keys.filter((key) => !optional.includes(key)));
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    const missing = [...required].filter((key) => !(key in value));
    if (unknown.length || missing.length) {
        throw new Error(`rolehub-bridge: invalid ${label} keys` +
            `${unknown.length ? `; unknown: ${unknown.join(', ')}` : ''}` +
            `${missing.length ? `; missing: ${missing.join(', ')}` : ''}`);
    }
}
function string(value, label) {
    boundedString(value, label, 4_096);
}
function boundedString(value, label, maximum) {
    if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\0'))
        invalid(label);
}
function stringArray(value, label) {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string'))
        invalid(label);
    if (new Set(value).size !== value.length)
        invalid(`${label} duplicates`);
    return value;
}
function enumValue(value, allowed, label) {
    if (typeof value !== 'string' || !allowed.includes(value))
        invalid(label);
}
function isoDate(value, label) {
    if (typeof value !== 'string')
        invalid(label);
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value)
        invalid(label);
}
function invalid(label) {
    throw new Error(`rolehub-bridge: invalid ${label}`);
}
async function safeLstat(target) {
    try {
        return await lstat(target);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
//# sourceMappingURL=storage.js.map