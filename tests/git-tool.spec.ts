import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import {
  ROLEHUB_GIT_READ_TOOL,
  buildGitReadArgs,
  createGitReadTool,
  type GitReadRunner,
} from '../src/git-tool.js'

function execution(cwd?: string): ToolRunContext {
  return {
    agent: {
      session: { header: cwd === undefined ? {} : { cwd } },
    } as unknown as Agent,
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
}

describe('buildGitReadArgs()', () => {
  it('builds fixed argv with an option separator before a path', () => {
    const args = buildGitReadArgs({
      operation: 'diff',
      base: 'main',
      head: 'feature/rolehub',
      path: 'src/index.ts',
    })

    expect(args).toContain('--no-pager')
    expect(args).toContain('--no-optional-locks')
    expect(args).toContain('--no-ext-diff')
    expect(args).toContain('--no-textconv')
    expect(args.slice(-2)).toEqual(['--', 'src/index.ts'])
    expect(args).not.toContain('bash')
  })

  it.each([
    [{ operation: 'show', ref: '--exec=touch' }, /not a safe revision/u],
    [{ operation: 'status', path: '../secret' }, /safe repository-relative path/u],
    [{ operation: 'status', path: 'C:\\secret.txt' }, /safe repository-relative path/u],
    [{ operation: 'diff', staged: true, base: 'HEAD' }, /cannot be combined/u],
    [{ operation: 'diff', head: 'HEAD' }, /head requires base/u],
    [{ operation: 'log', limit: 101 }, /integer from 1 to 100/u],
    [{ operation: 'status', ref: 'HEAD' }, /ref is not valid for status/u],
  ] as const)('rejects unsafe or inapplicable input %#', (input, expected) => {
    expect(() => buildGitReadArgs(input)).toThrow(expected)
  })
})

describe('createGitReadTool()', () => {
  it('runs only the fixed git argv in the Session cwd and returns bounded output', async () => {
    const run = vi.fn<GitReadRunner>(async () => ({ stdout: '## main\n', stderr: '' }))
    const tool = createGitReadTool({ run, maxOutputBytes: 1024, timeoutMs: 500 })
    const exec = execution('/workspace/repository')

    await expect(tool.execute({ operation: 'status' }, exec)).resolves.toEqual({
      operation: 'status',
      stdout: '## main\n',
      stderr: '',
    })
    expect(tool.name).toBe(ROLEHUB_GIT_READ_TOOL)
    expect(run).toHaveBeenCalledExactlyOnceWith(
      expect.arrayContaining(['status', '--no-pager', '--no-optional-locks']),
      '/workspace/repository',
      exec.signal,
    )
  })

  it('requires an absolute Session cwd and rejects oversized runner output', async () => {
    const run = vi.fn<GitReadRunner>(async () => ({ stdout: 'too long', stderr: '' }))
    const tool = createGitReadTool({ run, maxOutputBytes: 3 })

    await expect(tool.execute({ operation: 'status' }, execution('relative'))).rejects.toThrow(
      'no absolute workspace cwd',
    )
    await expect(tool.execute({ operation: 'status' }, execution('/repo'))).rejects.toThrow(
      'output exceeded 3 bytes',
    )
  })

  it('schema-rejects mutating or unknown operations before invoking the runner', async () => {
    const run = vi.fn<GitReadRunner>(async () => ({ stdout: '', stderr: '' }))
    const tool = createGitReadTool({ run })

    await expect(tool.execute({ operation: 'push' }, execution('/repo'))).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
})
