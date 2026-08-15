import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
export declare const ROLEHUB_GIT_READ_TOOL = "rolehub_git_read";
export type GitReadOperation = 'status' | 'diff' | 'log' | 'show';
export interface GitReadInput {
    operation: GitReadOperation;
    path?: string;
    base?: string;
    head?: string;
    ref?: string;
    staged?: boolean;
    limit?: number;
}
export interface GitReadProcessResult {
    stdout: string;
    stderr: string;
}
export type GitReadRunner = (args: readonly string[], cwd: string, signal: AbortSignal) => Promise<GitReadProcessResult>;
export interface GitReadToolOptions {
    run?: GitReadRunner;
    maxOutputBytes?: number;
    timeoutMs?: number;
}
/** Build a fixed, separator-safe argv for the read-only git surface. */
export declare function buildGitReadArgs(input: GitReadInput): string[];
/** A model-visible tool with no shell, mutation subcommands, or free-form argv. */
export declare function createGitReadTool(options?: GitReadToolOptions): ToolDefinition;
//# sourceMappingURL=git-tool.d.ts.map