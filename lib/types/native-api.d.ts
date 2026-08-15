import type { IncomingMessage } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { NativeBridgeSnapshot } from './client/protocol.js';
import type { BridgeSnapshot } from './types.js';
export type { NativeBridgeSnapshot } from './client/protocol.js';
export declare const name = "rolehub-bridge-native-api";
export declare const inject: string[];
export declare const ROLEHUB_NATIVE_API_PREFIX = "/rolehub-bridge/api/session/";
/** Browser reads are same-origin/same-site only. This endpoint never accepts writes. */
export declare function isSameSiteRead(req: Pick<IncomingMessage, 'headers'>): boolean;
/** Explicit browser projection: no archive URL, local path, policy, binding, or Session receipt. */
export declare function nativeBridgeSnapshot(snapshot: BridgeSnapshot): NativeBridgeSnapshot;
/** Read-only, live-Agent-scoped snapshot used by the additive native client. */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=native-api.d.ts.map