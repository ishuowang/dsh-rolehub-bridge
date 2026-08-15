import { SessionId } from '@deepseek-ai/dsh-session';
export const name = 'rolehub-bridge-native-api';
export const inject = ['agents', 'roleHubBridge', 'webServer'];
export const ROLEHUB_NATIVE_API_PREFIX = '/rolehub-bridge/api/session/';
function json(req, res, status, value) {
    const body = `${JSON.stringify(value)}\n`;
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(body)),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
}
/** Browser reads are same-origin/same-site only. This endpoint never accepts writes. */
export function isSameSiteRead(req) {
    const value = req.headers['sec-fetch-site'];
    if (value === undefined)
        return true;
    return value === 'same-origin' || value === 'same-site' || value === 'none';
}
function capabilityView(capabilities) {
    return {
        required: [...capabilities.required],
        optional: [...capabilities.optional],
        denied: [...capabilities.denied],
    };
}
function roleView(role) {
    return {
        hubId: role.hubId,
        id: role.id,
        name: role.name,
        displayName: role.displayName,
        description: role.description,
        publisher: role.publisher,
        version: role.version,
        license: role.license,
        tags: [...role.tags],
        trust: role.trust,
        manifestDigest: role.manifestDigest,
        bundleDigest: role.bundleDigest,
        capabilities: capabilityView(role.capabilities),
        installed: role.installed,
    };
}
/** Explicit browser projection: no archive URL, local path, policy, binding, or Session receipt. */
export function nativeBridgeSnapshot(snapshot) {
    return {
        hubs: snapshot.hubs.map(hub => ({ id: hub.id })),
        roles: snapshot.roles.map(roleView),
        rooms: snapshot.rooms.map(room => ({
            id: room.id,
            name: room.name,
            ...(room.status === undefined ? {} : { status: room.status }),
        })),
        roomAvailable: snapshot.roomAvailable,
    };
}
/** Read-only, live-Agent-scoped snapshot used by the additive native client. */
export function apply(ctx) {
    ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: '/rolehub-bridge/api',
        async handler(req, res) {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405, { allow: 'GET, HEAD' });
                res.end();
                return;
            }
            if (!isSameSiteRead(req)) {
                json(req, res, 403, { error: 'cross_site_rolehub_read_denied' });
                return;
            }
            const pathname = new URL(req.url ?? '/', 'http://dsh.local').pathname;
            if (!pathname.startsWith(ROLEHUB_NATIVE_API_PREFIX)) {
                json(req, res, 404, { error: 'not_found' });
                return;
            }
            const encoded = pathname.slice(ROLEHUB_NATIVE_API_PREFIX.length);
            if (encoded.length === 0 || encoded.includes('/')) {
                json(req, res, 404, { error: 'not_found' });
                return;
            }
            let sessionId;
            try {
                sessionId = decodeURIComponent(encoded);
            }
            catch {
                json(req, res, 400, { error: 'invalid_session_id' });
                return;
            }
            if (sessionId.length === 0 || sessionId.length > 240 || /[\u0000-\u001f\u007f]/u.test(sessionId)) {
                json(req, res, 400, { error: 'invalid_session_id' });
                return;
            }
            const agent = ctx.agents.get(SessionId(sessionId));
            if (!agent) {
                json(req, res, 404, { error: 'session_not_live' });
                return;
            }
            try {
                const snapshot = await Promise.resolve(ctx.roleHubBridge.snapshot(agent));
                json(req, res, 200, nativeBridgeSnapshot(snapshot));
            }
            catch {
                // Resolver failures can contain local paths and remote URLs; keep the HTTP surface generic.
                json(req, res, 503, { error: 'rolehub_snapshot_unavailable' });
            }
        },
    }), 'rolehub-bridge: native UI read API');
}
//# sourceMappingURL=native-api.js.map