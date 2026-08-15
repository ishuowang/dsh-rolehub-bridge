import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { NativeBridgeSnapshot, NativeRoleView } from './protocol.js';
type RoleView = NativeRoleView;
export declare const ROLEHUB_HEADER_ENTRY_ID = "dsh-rolehub-bridge-header";
export declare const ROLEHUB_FOOTER_ENTRY_ID = "dsh-rolehub-bridge-footer";
export declare const ROLEHUB_ROOM_INVITE_ENTRY_ID = "dsh-rolehub-bridge-room-invite";
export declare const ROLEHUB_NATIVE_API_PREFIX = "/rolehub-bridge/api/session/";
export type RoleHubHeaderActionProps = PropsRuntime<'conversation.session.header.actions'>;
export type RoleHubFooterActionProps = PropsRuntime<'sidebar.footer.action'> & SidebarFooterActionOwnerProps;
export interface RoleHubRoomInviteOwnerProps {
    sessionId: string;
    roomId: string;
    roomName: string;
    disabled: boolean;
    onAttached: () => void;
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap {
        'agent-team-room.invite.provider': {
            kind: 'list';
            scope: 'session';
            owner: RoleHubRoomInviteOwnerProps;
        };
    }
}
export type RoleHubRoomInviteProps = PropsRuntime<'agent-team-room.invite.provider'>;
export interface StartRoleCommandOptions {
    label?: string;
    roomId?: string;
    prompt?: string;
}
export declare function roleSelector(role: Pick<RoleView, 'hubId' | 'name'>): string;
export declare function buildStartRoleCommand(role: Pick<RoleView, 'hubId' | 'name'>, options?: StartRoleCommandOptions): string;
export declare function roleHubSnapshotUrl(sessionId: string): string;
export declare function loadRoleHubSnapshot(sessionId: string, signal?: AbortSignal): Promise<NativeBridgeSnapshot>;
export declare function roleKey(role: Pick<RoleView, 'hubId' | 'name' | 'version'>): string;
export declare function availableTags(roles: readonly RoleView[]): string[];
export declare function filterRoles(roles: readonly RoleView[], query: string, hubId?: string, tag?: string): RoleView[];
/** Required DSH services: official additive slots and the native Session runtime. */
export declare const inject: string[];
/** Add RoleHub controls without replacing a DSH root, sidebar, conversation, or details surface. */
export declare function apply(ctx: ClientContext): void;
export {};
//# sourceMappingURL=index.d.ts.map