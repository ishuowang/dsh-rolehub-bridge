import type { Context } from '@deepseek-ai/cordis';
export declare const name = "rolehub-bridge-commands";
export declare const inject: string[];
export type ParsedRoleHubCommand = {
    action: 'hubs';
} | {
    action: 'list';
} | {
    action: 'refresh';
} | {
    action: 'inspect';
    selector: string;
} | {
    action: 'start';
    selector: string;
    label?: string;
    roomId?: string;
    prompt?: string;
} | {
    action: 'sessions';
};
/** Tokenize Host command text without shell expansion or evaluation. */
export declare function tokenizeRoleHubCommand(rawInput: string): string[];
export declare function parseRoleHubCommand(rawInput: string): ParsedRoleHubCommand;
/** Register the sole mutating RoleHub surface as an explicit human Host command. */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=commands.d.ts.map