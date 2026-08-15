import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  CommandDefinition,
  CommandInvocation,
  CommandResult,
} from '@deepseek-ai/dsh-commands'
import { describe, expect, it, vi } from 'vitest'

import {
  apply,
  inject,
  parseRoleHubCommand,
  tokenizeRoleHubCommand,
} from '../src/commands.js'

function invocation(rawInput: string, signal = new AbortController().signal): CommandInvocation {
  return {
    commandId: 'command-1' as CommandInvocation['commandId'],
    agent: { id: 'leader-1' } as unknown as Agent,
    rawInput,
    signal,
  }
}

function mount(overrides: Record<string, unknown> = {}) {
  let definition: CommandDefinition | undefined
  const roleHubBridge = {
    listHubs: vi.fn(() => [{ id: 'official', catalogUrl: 'https://roles.example/catalog.json' }]),
    listRoles: vi.fn(() => [{ id: 'io.example/reviewer', displayName: 'Reviewer' }]),
    refresh: vi.fn(async () => ({
      roleCount: 1,
      hubs: [{ id: 'official', source: 'network', fetchedAt: '2026-08-15T00:00:00.000Z' }],
    })),
    inspectRole: vi.fn(() => ({ id: 'io.example/reviewer', displayName: 'Reviewer' })),
    startRole: vi.fn(async () => ({ childId: 'child-1', messageId: 'message-1' })),
    listSessions: vi.fn(async () => [{ sessionId: 'child-1', state: 'active' }]),
    ...overrides,
  }
  apply({
    commands: {
      register(candidate: CommandDefinition) {
        definition = candidate
        return () => undefined
      },
    },
    roleHubBridge,
  } as unknown as Context)
  if (definition === undefined) throw new Error('/rolehub command was not registered')
  return { definition, roleHubBridge }
}

async function run(
  definition: CommandDefinition,
  rawInput: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return await definition.handler(invocation(rawInput, signal))
}

describe('tokenizeRoleHubCommand()', () => {
  it('preserves quoted prompt text and escaped spaces without evaluating either', () => {
    expect(tokenizeRoleHubCommand(
      String.raw`start official/reviewer --label 'Code reviewer' --prompt inspect\ this`,
    )).toEqual([
      'start',
      'official/reviewer',
      '--label',
      'Code reviewer',
      '--prompt',
      'inspect this',
    ])
  })

  it.each([
    ['start role --prompt "unfinished', /unterminated/u],
    ['start role --prompt trailing\\', /dangling escape/u],
  ])('rejects malformed quoting in %j', (input, expected) => {
    expect(() => tokenizeRoleHubCommand(input)).toThrow(expected)
  })
})

describe('parseRoleHubCommand()', () => {
  it.each([
    ['', { action: 'list' }],
    ['hubs', { action: 'hubs' }],
    ['list', { action: 'list' }],
    ['refresh', { action: 'refresh' }],
    ['inspect official/reviewer', { action: 'inspect', selector: 'official/reviewer' }],
    [
      'start official/reviewer --label "Careful reviewer" --room room-1 --prompt "Review PR 42"',
      {
        action: 'start',
        selector: 'official/reviewer',
        label: 'Careful reviewer',
        roomId: 'room-1',
        prompt: 'Review PR 42',
      },
    ],
    ['sessions', { action: 'sessions' }],
  ])('parses %j', (input, expected) => {
    expect(parseRoleHubCommand(input)).toEqual(expected)
  })

  it.each([
    ['wat', /unknown action/u],
    ['hubs extra', /accepts no arguments/u],
    ['inspect', /requires exactly one selector/u],
    ['inspect one two', /requires exactly one selector/u],
    ['start', /selector is required/u],
    ['start role extra', /unexpected positional argument/u],
    ['start role --wat value', /unknown flag/u],
    ['start role --label', /requires a value/u],
    ['start role --label one --label two', /duplicate flag/u],
    ['start role --prompt ""', /--prompt value is required/u],
  ])('rejects invalid syntax %j', (input, expected) => {
    expect(() => parseRoleHubCommand(input)).toThrow(expected)
  })
})

describe('/rolehub Host command', () => {
  it('registers only a Host command and does not record prompt-bearing input', () => {
    const { definition } = mount()

    expect(inject).toEqual(['commands', 'roleHubBridge'])
    expect(definition).toMatchObject({
      name: 'rolehub',
      recordInput: false,
      input: { hint: expect.stringContaining('start') },
    })
  })

  it('routes discovery, refresh, inspection, and Session audit reads', async () => {
    const { definition, roleHubBridge } = mount()
    const refreshCall = invocation('refresh')
    const sessionsCall = invocation('sessions')

    await run(definition, 'hubs')
    await run(definition, 'list')
    await run(definition, 'inspect official/reviewer')
    await definition.handler(refreshCall)
    await definition.handler(sessionsCall)

    expect(roleHubBridge.listHubs).toHaveBeenCalledOnce()
    expect(roleHubBridge.listRoles).toHaveBeenCalledOnce()
    expect(roleHubBridge.inspectRole).toHaveBeenCalledExactlyOnceWith('official/reviewer')
    expect(roleHubBridge.refresh).toHaveBeenCalledExactlyOnceWith(refreshCall.signal)
    expect(roleHubBridge.listSessions).toHaveBeenCalledExactlyOnceWith(sessionsCall.agent)
    expect(roleHubBridge.startRole).not.toHaveBeenCalled()
  })

  it('passes exact explicit start data, caller Agent, and cancellation signal', async () => {
    const { definition, roleHubBridge } = mount()
    const controller = new AbortController()
    const call = invocation(
      'start official/reviewer --label "Careful reviewer" --room room-1 --prompt "Review PR 42"',
      controller.signal,
    )

    await expect(definition.handler(call)).resolves.toMatchObject({
      kind: 'success',
      text: expect.stringContaining('child-1'),
    })
    expect(roleHubBridge.startRole).toHaveBeenCalledExactlyOnceWith(call.agent, {
      selector: 'official/reviewer',
      label: 'Careful reviewer',
      roomId: 'room-1',
      prompt: 'Review PR 42',
    }, controller.signal)
  })

  it('turns cancellation, parser, and runtime failures into command errors', async () => {
    const failed = mount({
      inspectRole: vi.fn(() => { throw new Error('catalog unavailable') }),
    }).definition
    await expect(run(failed, 'inspect official/reviewer')).resolves.toEqual({
      kind: 'error',
      text: 'catalog unavailable',
    })
    await expect(run(failed, 'unknown')).resolves.toMatchObject({ kind: 'error' })

    const controller = new AbortController()
    controller.abort()
    const { definition, roleHubBridge } = mount()
    await expect(run(definition, 'list', controller.signal)).resolves.toMatchObject({ kind: 'error' })
    expect(roleHubBridge.listRoles).not.toHaveBeenCalled()
  })
})
