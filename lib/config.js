import os from 'node:os';
import { isIP } from 'node:net';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { CAPABILITY_IDS } from '@ishuowang/rolehub-core';
export const DEFAULT_HUB = {
    id: 'official',
    catalogUrl: 'https://raw.githubusercontent.com/ishuowang/agent-role-hub/main/catalog/index.json',
    archiveUrlTemplate: 'https://github.com/ishuowang/agent-role-hub/releases/download/v{version}/{name}-{version}.role.tgz',
    trustedPublishers: ['io.github.ishuowang'],
    allowedRedirectHosts: [
        'release-assets.githubusercontent.com',
        'objects.githubusercontent.com',
    ],
};
export const DEFAULT_ALLOWED_CAPABILITIES = [
    'filesystem.read',
    'filesystem.write',
    'network.fetch',
    'web.search',
    'source-control.read',
    'room.message',
];
const hubSchema = z.object({
    id: z.string().required(),
    catalogUrl: z.string().required(),
    archiveUrlTemplate: z.string().required(),
    trustedPublishers: z.array(z.string()).default([]),
    allowedRedirectHosts: z.array(z.string()).default([]),
});
export const Config = z.object({
    storageDir: z.string().default(''),
    hubs: z.array(hubSchema).default([DEFAULT_HUB]),
    allowCommunityRoles: z.boolean().default(false),
    allowedCapabilities: z.array(z.string()).default([...DEFAULT_ALLOWED_CAPABILITIES]),
    fetchTimeoutMs: z.natural().min(1_000).max(120_000).default(15_000),
    maxCatalogCacheAgeMs: z.natural().min(60_000).max(604_800_000).default(86_400_000),
    maxCatalogBytes: z.natural().min(1_024).max(20_000_000).default(2_000_000),
    maxArchiveBytes: z.natural().min(1_024).max(200_000_000).default(20_000_000),
    agentProvider: z.string().default(''),
    agentModel: z.string().default(''),
});
export function resolveStorageDir(configured) {
    if (configured.trim())
        return path.resolve(configured);
    const dshHome = process.env['DSH_HOME']?.trim();
    return dshHome
        ? path.join(path.resolve(dshHome), 'rolehub-bridge')
        : path.join(os.homedir(), '.dsh', 'rolehub-bridge');
}
export function assertConfig(config) {
    const hubIds = new Set();
    for (const hub of config.hubs) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(hub.id)) {
            throw new Error(`rolehub-bridge: invalid Hub id "${hub.id}"`);
        }
        if (hubIds.has(hub.id))
            throw new Error(`rolehub-bridge: duplicate Hub id "${hub.id}"`);
        hubIds.add(hub.id);
        assertHttpsUrl(hub.catalogUrl, `Hub ${hub.id} catalogUrl`);
        assertHttpsUrl(hub.archiveUrlTemplate.replaceAll('{name}', 'role').replaceAll('{version}', '1.0.0'), `Hub ${hub.id} archiveUrlTemplate`);
        if (!hub.archiveUrlTemplate.includes('{name}') || !hub.archiveUrlTemplate.includes('{version}')) {
            throw new Error(`rolehub-bridge: Hub ${hub.id} archiveUrlTemplate requires {name} and {version}`);
        }
        if (new Set(hub.trustedPublishers).size !== hub.trustedPublishers.length) {
            throw new Error(`rolehub-bridge: Hub ${hub.id} trustedPublishers cannot contain duplicates`);
        }
        for (const publisher of hub.trustedPublishers) {
            if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(publisher)) {
                throw new Error(`rolehub-bridge: invalid trusted publisher "${publisher}" for Hub ${hub.id}`);
            }
        }
        if (new Set(hub.allowedRedirectHosts).size !== hub.allowedRedirectHosts.length) {
            throw new Error(`rolehub-bridge: Hub ${hub.id} allowedRedirectHosts cannot contain duplicates`);
        }
        for (const hostname of hub.allowedRedirectHosts) {
            if (!isDnsHostname(hostname) || hostname === 'localhost') {
                throw new Error(`rolehub-bridge: invalid redirect hostname "${hostname}" for Hub ${hub.id}`);
            }
        }
    }
    if (config.hubs.length === 0)
        throw new Error('rolehub-bridge: configure at least one Hub');
    if (new Set(config.allowedCapabilities).size !== config.allowedCapabilities.length) {
        throw new Error('rolehub-bridge: allowedCapabilities cannot contain duplicates');
    }
    for (const capability of config.allowedCapabilities) {
        if (!CAPABILITY_IDS.includes(capability)) {
            throw new Error(`rolehub-bridge: unknown allowed capability "${capability}"`);
        }
    }
}
function isDnsHostname(value) {
    if (value.length === 0
        || value.length > 253
        || value !== value.toLowerCase()
        || isIP(value) !== 0)
        return false;
    return value.split('.').every(label => (label.length > 0
        && label.length <= 63
        && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)));
}
function assertHttpsUrl(value, label) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new Error(`rolehub-bridge: ${label} must be a valid URL`);
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        throw new Error(`rolehub-bridge: ${label} must be credential-free HTTPS`);
    }
}
//# sourceMappingURL=config.js.map