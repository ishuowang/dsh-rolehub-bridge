import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RoleView } from '../src/types.js'

interface FakeElement {
  type: unknown
  props: Record<string, unknown>
}

vi.mock('react', () => ({
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): FakeElement {
    return {
      type,
      props: {
        ...(props ?? {}),
        ...(children.length === 0
          ? {}
          : { children: children.length === 1 ? children[0] : children }),
      },
    }
  },
  useCallback<T>(callback: T): T {
    return callback
  },
  useEffect(): void {},
  useMemo<T>(factory: () => T): T {
    return factory()
  },
  useState<T>(initial: T): [T, () => void] {
    return [initial, () => undefined]
  },
}))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: 'Button',
  IconAgentPresetOutline16: 'IconAgentPresetOutline16',
  IconCheckOutline16: 'IconCheckOutline16',
  IconRefreshOutline16: 'IconRefreshOutline16',
  IconSearchOutline16: 'IconSearchOutline16',
  IconSkillOutline16: 'IconSkillOutline16',
  Input: 'Input',
  Modal: 'Modal',
  Pill: 'Pill',
  Tooltip: 'Tooltip',
}))

import {
  ROLEHUB_FOOTER_ENTRY_ID,
  ROLEHUB_HEADER_ENTRY_ID,
  ROLEHUB_NATIVE_API_PREFIX,
  ROLEHUB_ROOM_INVITE_ENTRY_ID,
  apply,
  availableTags,
  buildStartRoleCommand,
  filterRoles,
  inject,
  loadRoleHubSnapshot,
  roleHubSnapshotUrl,
  roleSelector,
} from '../src/client/index.js'

interface RegisteredEntry {
  registration: { name: string; id: string; order: number }
  component: (props: Record<string, unknown>) => FakeElement
}

function role(overrides: Partial<RoleView> = {}): RoleView {
  return {
    hubId: 'official',
    id: 'io.example/reviewer',
    name: 'reviewer',
    displayName: 'Careful Reviewer',
    description: 'Reviews changes with evidence.',
    publisher: 'io.example',
    version: '1.2.3',
    license: 'Apache-2.0',
    tags: ['review', 'safety'],
    trust: 'reference',
    manifestDigest: 'a'.repeat(64),
    bundleDigest: 'b'.repeat(64),
    capabilities: {
      required: ['filesystem.read'],
      optional: ['room.message'],
      denied: ['secrets.use'],
    },
    installed: true,
    ...overrides,
  }
}

function clientHarness() {
  const entries: RegisteredEntry[] = []
  const register = vi.fn((registration: RegisteredEntry['registration'], component: RegisteredEntry['component']) => {
    entries.push({ registration, component })
    return () => undefined
  })
  const injectSlot = vi.fn((_name: string, callback: () => unknown) => callback())
  const sessions = {}
  const context = {
    slots: { inject: injectSlot, register },
    get: vi.fn((name: string) => {
      if (name === 'sessions') return sessions
      throw new Error(`unexpected service: ${name}`)
    }),
  }
  return { context, entries, register, injectSlot }
}

function renderLauncher(entry: RegisteredEntry, location: 'header' | 'footer' | 'room'): FakeElement {
  const state = { current: 'leader-1' }
  const props = location === 'header'
    ? { sessionId: 'leader-1' }
    : location === 'footer'
      ? { wide: true, useSessions: (selector: (value: typeof state) => unknown) => selector(state) }
      : {
          sessionId: 'leader-1',
          roomId: 'room-1',
          roomName: 'Review Room',
          disabled: false,
          onAttached: vi.fn(),
        }
  const launcher = entry.component(props)
  if (typeof launcher.type !== 'function') throw new Error('slot contribution did not return the RoleHub launcher')
  return launcher.type(launcher.props) as FakeElement
}

function findElement(root: unknown, type: unknown): FakeElement | undefined {
  if (root === null || root === undefined) return undefined
  if (Array.isArray(root)) {
    for (const child of root) {
      const found = findElement(child, type)
      if (found) return found
    }
    return undefined
  }
  if (typeof root !== 'object') return undefined
  const candidate = root as Partial<FakeElement>
  if (candidate.type === type && candidate.props) return candidate as FakeElement
  return findElement(candidate.props?.children, type)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RoleHub client helpers', () => {
  it('builds a shell-free Host command with a Hub selector and optional Room', () => {
    const selected = role({ name: "reviewer's-role" })

    expect(roleSelector(selected)).toBe("official/reviewer's-role")
    expect(buildStartRoleCommand(selected, {
      label: "Release \\ reviewer",
      roomId: 'room 1',
      prompt: "Check Alice's patch",
    })).toBe(
      "/rolehub start 'official/reviewer\\'s-role' --label 'Release \\\\ reviewer' "
      + "--room 'room 1' --prompt 'Check Alice\\'s patch'",
    )
  })

  it('filters across Hub, tags, descriptions, and capabilities', () => {
    const roles = [
      role(),
      role({
        hubId: 'community',
        id: 'org.example/researcher',
        name: 'researcher',
        displayName: 'Research Librarian',
        description: 'Finds primary sources.',
        tags: ['research'],
        capabilities: { required: ['web.search'], optional: [], denied: [] },
      }),
    ]

    expect(filterRoles(roles, 'filesystem')).toEqual([roles[0]])
    expect(filterRoles(roles, 'primary', 'community')).toEqual([roles[1]])
    expect(filterRoles(roles, '', 'all', 'research')).toEqual([roles[1]])
    expect(availableTags(roles)).toEqual(['research', 'review', 'safety'])
  })

  it('uses a same-origin GET and validates the snapshot envelope', async () => {
    const payload = { hubs: [], roles: [], rooms: [], roomAvailable: false }
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }))
    vi.stubGlobal('fetch', fetch)

    expect(ROLEHUB_NATIVE_API_PREFIX).toBe('/rolehub-bridge/api/session/')
    expect(roleHubSnapshotUrl('leader/one')).toBe('/rolehub-bridge/api/session/leader%2Fone')
    await expect(loadRoleHubSnapshot('leader/one')).resolves.toEqual(payload)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      '/rolehub-bridge/api/session/leader%2Fone',
      {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      },
    )
  })

  it('rejects malformed or unsuccessful snapshot responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ roles: [] }) })))
    await expect(loadRoleHubSnapshot('leader-1')).rejects.toThrow('invalid shape')

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })))
    await expect(loadRoleHubSnapshot('leader-1')).rejects.toThrow('(503)')
  })
})

describe('native DSH Web entries', () => {
  it('depends only on typed slots and the native Session runtime', () => {
    expect(inject).toEqual(['slots', 'sessions'])
  })

  it('registers additive header, footer, and Room invitation entries only', () => {
    const { context, entries, injectSlot, register } = clientHarness()

    apply(context as never)

    expect(injectSlot.mock.calls.map(call => call[0])).toEqual([
      'conversation.session.header.actions',
      'sidebar.footer.action',
      'agent-team-room.invite.provider',
    ])
    expect(register).toHaveBeenCalledTimes(3)
    expect(entries.map(entry => entry.registration)).toEqual([
      { name: 'conversation.session.header.actions', id: ROLEHUB_HEADER_ENTRY_ID, order: 30 },
      { name: 'sidebar.footer.action', id: ROLEHUB_FOOTER_ENTRY_ID, order: 30 },
      { name: 'agent-team-room.invite.provider', id: ROLEHUB_ROOM_INVITE_ENTRY_ID, order: 10 },
    ])
    expect(entries.map(entry => entry.registration.name)).not.toContain('root')
    expect(entries.map(entry => entry.registration.name)).not.toContain('sidebar')
    expect(entries.map(entry => entry.registration.name)).not.toContain('conversation')
  })

  it('renders the browser in a native Modal from all three additive entries', () => {
    const { context, entries } = clientHarness()
    apply(context as never)

    const cases = [
      [ROLEHUB_HEADER_ENTRY_ID, 'header'],
      [ROLEHUB_FOOTER_ENTRY_ID, 'footer'],
      [ROLEHUB_ROOM_INVITE_ENTRY_ID, 'room'],
    ] as const
    for (const [id, location] of cases) {
      const entry = entries.find(candidate => candidate.registration.id === id)
      if (!entry) throw new Error(`missing ${id}`)
      const rendered = renderLauncher(entry, location)
      expect(findElement(rendered, 'Modal')?.props).toMatchObject({
        open: false,
        title: 'RoleHub',
        description: expect.stringContaining('separate verified Session'),
      })
    }
  })

  it('renders a lightweight Room-owned invitation action', () => {
    const { context, entries } = clientHarness()
    apply(context as never)
    const entry = entries.find(candidate => candidate.registration.id === ROLEHUB_ROOM_INVITE_ENTRY_ID)
    if (!entry) throw new Error('missing Room invitation entry')

    const rendered = renderLauncher(entry, 'room')
    expect(findElement(rendered, 'Button')?.props).toMatchObject({
      children: 'Choose RoleHub role',
      disabled: false,
      'aria-label': 'Choose a RoleHub role for Review Room',
    })
  })

  it('ships a ModuleLoader bundle using official primitives and no replacement UI', async () => {
    const entryPoint = fileURLToPath(new URL('../src/client/index.ts', import.meta.url))
    const result = await build({
      entryPoints: [entryPoint],
      bundle: true,
      format: 'cjs',
      platform: 'browser',
      target: ['es2022'],
      write: false,
      external: [
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-*',
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'scheduler',
      ],
      banner: {
        js: "window.__ModuleLoader__.load({ id: 'dsh-rolehub-bridge', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
      },
      footer: { js: 'return module.exports; } });' },
    })
    const source = result.outputFiles[0]?.text
    if (!source) throw new Error('esbuild returned no client bundle')
    let id: string | undefined
    let client: unknown
    const primitive = () => null
    const window = {
      __ModuleLoader__: {
        load(registration: {
          id: string
          factory: (require: (specifier: string) => unknown) => unknown
        }) {
          id = registration.id
          client = registration.factory(specifier => {
            if (specifier === 'react') {
              return {
                createElement: (type: unknown, props: unknown) => ({ type, props }),
                useCallback: (callback: unknown) => callback,
                useEffect: () => undefined,
                useMemo: (factory: () => unknown) => factory(),
                useState: (initial: unknown) => [initial, () => undefined],
              }
            }
            if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
              return new Proxy({}, { get: () => primitive })
            }
            throw new Error(`unexpected browser external: ${specifier}`)
          })
        },
      },
    }

    runInNewContext(source, { window })

    expect(id).toBe('dsh-rolehub-bridge')
    expect(client).toMatchObject({ inject: ['slots', 'sessions'], apply: expect.any(Function) })
    expect(source).toContain('.Modal')
    expect(source).toContain('agent-team-room.invite.provider')
  })

  it('contains no DOM patch, global stylesheet, standalone dashboard, or social automation', () => {
    const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(
      /document\.|querySelector|appendChild|innerHTML|window\.open|globalThis\.document|api\.github\.com|\/starred\/|\/following\//u,
    )
  })
})
