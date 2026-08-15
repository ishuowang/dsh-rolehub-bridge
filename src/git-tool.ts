import { execFile } from 'node:child_process'
import path from 'node:path'

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

export const ROLEHUB_GIT_READ_TOOL = 'rolehub_git_read'
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

export type GitReadOperation = 'status' | 'diff' | 'log' | 'show'

export interface GitReadInput {
  operation: GitReadOperation
  path?: string
  base?: string
  head?: string
  ref?: string
  staged?: boolean
  limit?: number
}

export interface GitReadProcessResult {
  stdout: string
  stderr: string
}

export type GitReadRunner = (
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
) => Promise<GitReadProcessResult>

export interface GitReadToolOptions {
  run?: GitReadRunner
  maxOutputBytes?: number
  timeoutMs?: number
}

/** Build a fixed, separator-safe argv for the read-only git surface. */
export function buildGitReadArgs(input: GitReadInput): string[] {
  const prefix = [
    '--no-pager',
    '--no-optional-locks',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.untrackedCache=false',
  ]
  const file = input.path === undefined ? undefined : safeRelativePath(input.path)

  switch (input.operation) {
    case 'status':
      rejectFields(input, ['base', 'head', 'ref', 'staged', 'limit'])
      return [...prefix, 'status', '--short', '--branch', '--untracked-files=all', '--', ...(file ? [file] : [])]
    case 'diff': {
      rejectFields(input, ['ref', 'limit'])
      if (input.staged === true && (input.base !== undefined || input.head !== undefined)) {
        throw new Error('rolehub_git_read: staged cannot be combined with base or head')
      }
      if (input.head !== undefined && input.base === undefined) {
        throw new Error('rolehub_git_read: head requires base')
      }
      const revisions = input.staged === true
        ? ['--cached']
        : [
            ...(input.base === undefined ? [] : [safeRevision(input.base, 'base')]),
            ...(input.head === undefined ? [] : [safeRevision(input.head, 'head')]),
          ]
      return [
        ...prefix,
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        ...revisions,
        '--',
        ...(file ? [file] : []),
      ]
    }
    case 'log': {
      rejectFields(input, ['base', 'head', 'staged'])
      const limit = input.limit ?? 20
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('rolehub_git_read: limit must be an integer from 1 to 100')
      }
      const ref = safeRevision(input.ref ?? 'HEAD', 'ref')
      return [
        ...prefix,
        'log',
        '--no-ext-diff',
        '--no-textconv',
        `--max-count=${limit}`,
        '--format=%H%x09%aI%x09%an%x09%s',
        ref,
        '--',
        ...(file ? [file] : []),
      ]
    }
    case 'show': {
      rejectFields(input, ['base', 'head', 'staged', 'limit'])
      const ref = safeRevision(input.ref ?? 'HEAD', 'ref')
      return [
        ...prefix,
        'show',
        '--no-ext-diff',
        '--no-textconv',
        '--format=fuller',
        '--decorate=no',
        ref,
        '--',
        ...(file ? [file] : []),
      ]
    }
  }
}

/** A model-visible tool with no shell, mutation subcommands, or free-form argv. */
export function createGitReadTool(options: GitReadToolOptions = {}): ToolDefinition {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error('rolehub-bridge: max git output bytes must be a positive integer')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('rolehub-bridge: git timeout must be a positive integer')
  }
  const run = options.run ?? ((args, cwd, signal) => runGit(args, cwd, signal, maxOutputBytes, timeoutMs))

  return defineTool({
    name: ROLEHUB_GIT_READ_TOOL,
    description:
      'Read repository status, diffs, commit history, or one commit through a fixed non-mutating git interface. '
      + 'This tool never accepts a shell command or arbitrary git arguments.',
    parameters: {
      operation: {
        type: 'string',
        enum: ['status', 'diff', 'log', 'show'],
        required: true,
        description: 'The fixed read-only operation.',
      },
      path: { type: 'string', description: 'Optional repository-relative path; traversal is rejected.' },
      base: { type: 'string', description: 'Diff base revision.' },
      head: { type: 'string', description: 'Diff head revision; requires base.' },
      ref: { type: 'string', description: 'Log/show revision (default HEAD).' },
      staged: { type: 'boolean', description: 'For diff only, inspect the staged index.' },
      limit: { type: 'integer', description: 'For log only, 1-100 entries (default 20).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operation: { type: 'string', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.stdout || value.stderr || '(git returned no output)',
      }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd
      if (cwd === undefined || !path.isAbsolute(cwd)) {
        throw new Error('rolehub_git_read: the role Session has no absolute workspace cwd')
      }
      const argv = buildGitReadArgs(args)
      const result = await run(argv, cwd, exec.signal)
      return {
        operation: args.operation,
        stdout: bounded(result.stdout, maxOutputBytes),
        stderr: bounded(result.stderr, maxOutputBytes),
      }
    },
  })
}

function runGit(
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  maxOutputBytes: number,
  timeoutMs: number,
): Promise<GitReadProcessResult> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: maxOutputBytes,
      timeout: timeoutMs,
      signal,
      windowsHide: true,
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
      },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`rolehub_git_read: git failed: ${error.message}`, { cause: error }))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function safeRelativePath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/')
  if (
    normalized.length === 0
    || normalized.length > 4_096
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized)
    || normalized.includes('\0')
    || normalized.split('/').some(part => part === '..')
  ) {
    throw new Error('rolehub_git_read: path must be a safe repository-relative path')
  }
  return normalized
}

function safeRevision(value: string, field: string): string {
  const revision = value.trim()
  if (
    revision.length === 0
    || revision.length > 256
    || revision.startsWith('-')
    || !/^[A-Za-z0-9][A-Za-z0-9._/@{}~^:+-]*$/u.test(revision)
  ) {
    throw new Error(`rolehub_git_read: ${field} is not a safe revision`)
  }
  return revision
}

function rejectFields(input: GitReadInput, fields: readonly (keyof GitReadInput)[]): void {
  for (const field of fields) {
    if (input[field] !== undefined) {
      throw new Error(`rolehub_git_read: ${String(field)} is not valid for ${input.operation}`)
    }
  }
}

function bounded(value: string, maximum: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximum) return value
  throw new Error(`rolehub_git_read: output exceeded ${maximum} bytes`)
}
