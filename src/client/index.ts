import { createElement, useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'

import type {
  ClientContext,
  ISessions,
  SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  Button,
  IconAgentPresetOutline16,
  IconCheckOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconSkillOutline16,
  Input,
  Modal,
  Pill,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import type {
  NativeBridgeSnapshot,
  NativeRoleView,
} from './protocol.js'

type RoleView = NativeRoleView

export const ROLEHUB_HEADER_ENTRY_ID = 'dsh-rolehub-bridge-header'
export const ROLEHUB_FOOTER_ENTRY_ID = 'dsh-rolehub-bridge-footer'
export const ROLEHUB_ROOM_INVITE_ENTRY_ID = 'dsh-rolehub-bridge-room-invite'
export const ROLEHUB_NATIVE_API_PREFIX = '/rolehub-bridge/api/session/'

export type RoleHubHeaderActionProps = PropsRuntime<'conversation.session.header.actions'>
export type RoleHubFooterActionProps = PropsRuntime<'sidebar.footer.action'> & SidebarFooterActionOwnerProps

export interface RoleHubRoomInviteOwnerProps {
  sessionId: string
  roomId: string
  roomName: string
  disabled: boolean
  onAttached: () => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'agent-team-room.invite.provider': {
      kind: 'list'
      scope: 'session'
      owner: RoleHubRoomInviteOwnerProps
    }
  }
}

export type RoleHubRoomInviteProps = PropsRuntime<'agent-team-room.invite.provider'>

interface LauncherProps {
  sessionId: SessionId | undefined
  sessions: ISessions
  wide?: boolean
  location: 'header' | 'footer' | 'room'
  roomContext?: Pick<RoleHubRoomInviteOwnerProps, 'roomId' | 'roomName' | 'disabled' | 'onAttached'>
}

export interface StartRoleCommandOptions {
  label?: string
  roomId?: string
  prompt?: string
}

const EMPTY_SNAPSHOT: NativeBridgeSnapshot = {
  hubs: [],
  roles: [],
  rooms: [],
  roomAvailable: false,
}

const color = {
  panel: 'var(--dsw-alias-bg-layer-1, #fff)',
  subtle: 'var(--dsw-alias-bg-layer-2, #f7f7f8)',
  raised: 'var(--dsw-alias-bg-layer-3, #f0f1f4)',
  border: 'var(--dsw-alias-border-normal, rgba(0,0,0,.1))',
  text: 'var(--dsw-alias-label-primary, #171717)',
  muted: 'var(--dsw-alias-label-secondary, #6b6b6b)',
  accent: 'var(--dsw-alias-interactive-primary, #4d6bfe)',
  danger: 'var(--dsw-alias-label-error, #d84a4a)',
  success: 'var(--dsw-alias-label-success, #18834b)',
  warning: 'var(--dsw-alias-label-warning, #8a5a00)',
}

const cardStyle: CSSProperties = {
  border: `1px solid ${color.border}`,
  borderRadius: 14,
  background: color.panel,
}

function commandQuote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

export function roleSelector(role: Pick<RoleView, 'hubId' | 'name'>): string {
  return `${role.hubId}/${role.name}`
}

export function buildStartRoleCommand(
  role: Pick<RoleView, 'hubId' | 'name'>,
  options: StartRoleCommandOptions = {},
): string {
  const parts = ['/rolehub start', commandQuote(roleSelector(role))]
  const label = options.label?.trim()
  const roomId = options.roomId?.trim()
  const prompt = options.prompt?.trim()
  if (label) parts.push('--label', commandQuote(label))
  if (roomId) parts.push('--room', commandQuote(roomId))
  if (prompt) parts.push('--prompt', commandQuote(prompt))
  return parts.join(' ')
}

export function roleHubSnapshotUrl(sessionId: string): string {
  return `${ROLEHUB_NATIVE_API_PREFIX}${encodeURIComponent(sessionId)}`
}

function isNativeSnapshot(value: unknown): value is NativeBridgeSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<NativeBridgeSnapshot>
  return Array.isArray(candidate.hubs)
    && Array.isArray(candidate.roles)
    && Array.isArray(candidate.rooms)
    && typeof candidate.roomAvailable === 'boolean'
}

export async function loadRoleHubSnapshot(
  sessionId: string,
  signal?: AbortSignal,
): Promise<NativeBridgeSnapshot> {
  const response = await fetch(roleHubSnapshotUrl(sessionId), {
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) throw new Error(`RoleHub snapshot failed (${response.status})`)
  const value: unknown = await response.json()
  if (!isNativeSnapshot(value)) throw new Error('RoleHub snapshot has an invalid shape')
  return value
}

export function roleKey(role: Pick<RoleView, 'hubId' | 'name' | 'version'>): string {
  return `${role.hubId}/${role.name}@${role.version}`
}

export function availableTags(roles: readonly RoleView[]): string[] {
  return [...new Set(roles.flatMap(role => role.tags))]
    .sort((left, right) => left.localeCompare(right, 'en'))
}

export function filterRoles(
  roles: readonly RoleView[],
  query: string,
  hubId = 'all',
  tag = 'all',
): RoleView[] {
  const needle = query.trim().toLocaleLowerCase()
  return roles.filter(role => {
    if (hubId !== 'all' && role.hubId !== hubId) return false
    if (tag !== 'all' && !role.tags.includes(tag)) return false
    if (!needle) return true
    return [
      role.displayName,
      role.id,
      role.description,
      role.publisher,
      ...role.tags,
      ...role.capabilities.required,
      ...role.capabilities.optional,
      ...role.capabilities.denied,
    ].some(value => value.toLocaleLowerCase().includes(needle))
  })
}

function shortDigest(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value
}

function Empty({ children }: { children: ReactNode }): ReactElement {
  return createElement('div', {
    style: {
      display: 'grid',
      placeItems: 'center',
      minHeight: 150,
      padding: 24,
      color: color.muted,
      fontSize: 13,
      textAlign: 'center',
    },
    children,
  })
}

function Chip({ active, children, onClick }: {
  active: boolean
  children: ReactNode
  onClick: () => void
}): ReactElement {
  return createElement('button', {
    type: 'button',
    'aria-pressed': active,
    onClick,
    style: {
      border: `1px solid ${active ? color.accent : color.border}`,
      borderRadius: 999,
      padding: '4px 9px',
      background: active ? color.raised : 'transparent',
      color: color.text,
      cursor: 'pointer',
      font: 'inherit',
      fontSize: 11,
      whiteSpace: 'nowrap',
    },
    children,
  })
}

function CapabilityGroup({ label, values, tone }: {
  label: string
  values: readonly string[]
  tone: 'required' | 'optional' | 'denied'
}): ReactElement {
  const toneColor = tone === 'denied' ? color.danger : tone === 'required' ? color.accent : color.muted
  return createElement('section', {
    style: { display: 'grid', gap: 7 },
    children: [
      createElement('div', {
        key: 'label',
        style: { color: toneColor, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' },
        children: `${label} · ${values.length}`,
      }),
      values.length === 0
        ? createElement('span', { key: 'empty', style: { color: color.muted, fontSize: 12 }, children: 'None' })
        : createElement('div', {
            key: 'values',
            style: { display: 'flex', flexWrap: 'wrap', gap: 5 },
            children: values.map(value => createElement(Pill, { key: value, children: value })),
          }),
    ],
  })
}

function RoleHubLauncher({ sessionId, sessions, wide, location, roomContext }: LauncherProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<NativeBridgeSnapshot>(EMPTY_SNAPSHOT)
  const [query, setQuery] = useState('')
  const [hubId, setHubId] = useState('all')
  const [tag, setTag] = useState('all')
  const [selectedKey, setSelectedKey] = useState<string>()
  const [roomId, setRoomId] = useState(roomContext?.roomId ?? '')
  const [label, setLabel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (!sessionId) {
      setSnapshot(EMPTY_SNAPSHOT)
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      const next = await loadRoleHubSnapshot(sessionId, signal)
      setSnapshot(next)
      setSelectedKey(current => (
        current && next.roles.some(role => roleKey(role) === current)
          ? current
          : next.roles[0] ? roleKey(next.roles[0]) : undefined
      ))
      if (!next.roomAvailable && !roomContext) setRoomId('')
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    if (!open || !sessionId) return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [open, refresh, sessionId])

  useEffect(() => {
    if (roomContext) setRoomId(roomContext.roomId)
  }, [roomContext?.roomId])

  const tags = useMemo(() => availableTags(snapshot.roles), [snapshot.roles])
  const filtered = useMemo(
    () => filterRoles(snapshot.roles, query, hubId, tag),
    [hubId, query, snapshot.roles, tag],
  )
  const selected = filtered.find(role => roleKey(role) === selectedKey) ?? filtered[0]

  const start = async (): Promise<void> => {
    if (!sessionId || !selected) return
    const live = sessions.binding(sessionId)?.session
    if (!live) throw new Error('The current Session is not materialized yet')
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await live.command(buildStartRoleCommand(selected, {
        ...(label.trim() ? { label } : {}),
        ...(roomId ? { roomId } : {}),
        ...(prompt.trim() ? { prompt } : {}),
      }))
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      if (!result.value.matched) throw new Error('The Host does not offer the /rolehub command')
      setNotice(roomId
        ? 'Role Session created and attached to the selected Room.'
        : 'Role Session created. It remains independent until you attach it to a Room.')
      setPrompt('')
      if (roomId && roomContext) roomContext.onAttached()
      await sessions.refreshSubagents(sessionId).catch(() => undefined)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    } finally {
      setBusy(false)
    }
  }

  const refreshHubs = async (): Promise<void> => {
    if (!sessionId) return
    const live = sessions.binding(sessionId)?.session
    if (!live) throw new Error('The current Session is not materialized yet')
    setLoading(true)
    setError(undefined)
    try {
      const result = await live.command('/rolehub refresh')
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      if (!result.value.matched) throw new Error('The Host does not offer the /rolehub command')
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    } finally {
      setLoading(false)
    }
  }

  const trigger = location === 'header'
    ? createElement(Button, {
        variant: 'toolbar',
        size: 'sm',
        icon: createElement(IconAgentPresetOutline16, { size: 16 }),
        'aria-label': 'Open RoleHub',
        id: 'rolehub-header-trigger',
        disabled: !sessionId,
        onClick: () => setOpen(true),
        children: 'RoleHub',
      })
    : location === 'footer' ? createElement(Tooltip, {
        label: 'Open RoleHub',
        side: 'right',
        delayMs: 500,
        disabled: wide ?? false,
        children: createElement(Button, {
          variant: 'toolbar',
          size: 'sm',
          icon: createElement(IconAgentPresetOutline16, { size: wide ? 16 : 18 }),
          'aria-label': 'Open RoleHub',
          id: 'rolehub-footer-trigger',
          disabled: !sessionId,
          onClick: () => setOpen(true),
          style: { width: wide ? '100%' : 36, justifyContent: wide ? 'flex-start' : 'center' },
          children: wide ? 'RoleHub' : undefined,
        }),
      }) : createElement(Button, {
        variant: 'outline',
        size: 'sm',
        icon: createElement(IconAgentPresetOutline16, { size: 14 }),
        'aria-label': `Choose a RoleHub role for ${roomContext?.roomName ?? 'this Room'}`,
        disabled: !sessionId || roomContext?.disabled,
        onClick: () => setOpen(true),
        children: 'Choose RoleHub role',
      })

  const browser = createElement('aside', {
    style: { ...cardStyle, flex: '1 1 250px', minWidth: 220, padding: 12, overflow: 'auto' },
    children: [
      createElement(Input, {
        key: 'search',
        value: query,
        icon: createElement(IconSearchOutline16, { size: 15 }),
        'aria-label': 'Search RoleHub roles',
        placeholder: 'Search roles, tags, capabilities…',
        onChange: event => setQuery(event.currentTarget.value),
      }),
      createElement('div', {
        key: 'hubs',
        'aria-label': 'Filter by Hub',
        style: { display: 'flex', gap: 5, overflowX: 'auto', padding: '10px 0 7px' },
        children: [
          createElement(Chip, { key: 'all', active: hubId === 'all', onClick: () => setHubId('all'), children: 'All Hubs' }),
          ...snapshot.hubs.map(hub => createElement(Chip, {
            key: hub.id,
            active: hubId === hub.id,
            onClick: () => setHubId(hub.id),
            children: hub.id,
          })),
        ],
      }),
      createElement('div', {
        key: 'tags',
        'aria-label': 'Filter by tag',
        style: { display: 'flex', gap: 5, overflowX: 'auto', paddingBottom: 10 },
        children: [
          createElement(Chip, { key: 'all', active: tag === 'all', onClick: () => setTag('all'), children: 'All tags' }),
          ...tags.map(value => createElement(Chip, {
            key: value,
            active: tag === value,
            onClick: () => setTag(value),
            children: `#${value}`,
          })),
        ],
      }),
      filtered.length === 0
        ? createElement(Empty, { key: 'empty', children: loading ? 'Loading RoleHub…' : 'No role matches these filters.' })
        : createElement('div', {
            key: 'roles',
            'data-rolehub-role-list': true,
            style: { display: 'grid', gap: 6 },
            children: filtered.map(role => {
              const active = selected ? roleKey(role) === roleKey(selected) : false
              return createElement('button', {
                key: roleKey(role),
                type: 'button',
                'aria-pressed': active,
                onClick: () => {
                  setSelectedKey(roleKey(role))
                  if (!label.trim()) setLabel(role.displayName)
                },
                style: {
                  display: 'grid',
                  gap: 4,
                  width: '100%',
                  padding: '10px 11px',
                  border: `1px solid ${active ? color.accent : 'transparent'}`,
                  borderRadius: 11,
                  background: active ? color.subtle : 'transparent',
                  color: color.text,
                  textAlign: 'left',
                  cursor: 'pointer',
                  font: 'inherit',
                },
                children: [
                  createElement('span', {
                    key: 'head',
                    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
                    children: [
                      createElement('strong', { key: 'name', style: { fontSize: 13 }, children: role.displayName }),
                      role.installed
                        ? createElement('span', {
                            key: 'installed',
                            title: 'Verified locally',
                            'aria-label': 'Verified locally',
                            children: createElement(IconCheckOutline16, { size: 14 }),
                          })
                        : null,
                    ],
                  }),
                  createElement('span', {
                    key: 'meta',
                    style: { color: color.muted, fontSize: 11 },
                    children: `${role.hubId} · v${role.version} · ${role.trust}`,
                  }),
                ],
              })
            }),
          }),
    ],
  })

  const detail = selected ? createElement('section', {
    style: { ...cardStyle, flex: '2 1 390px', minWidth: 0, padding: 16, overflow: 'auto' },
    children: [
      createElement('header', {
        key: 'header',
        style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
        children: [
          createElement('div', {
            key: 'identity',
            style: { minWidth: 0 },
            children: [
              createElement('div', {
                key: 'eyebrow',
                style: { color: color.accent, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' },
                children: `${selected.hubId} / ${selected.publisher}`,
              }),
              createElement('h3', {
                key: 'name',
                style: { margin: '4px 0 0', fontSize: 20, lineHeight: 1.2 },
                children: selected.displayName,
              }),
              createElement('p', {
                key: 'description',
                style: { margin: '7px 0 0', color: color.muted, fontSize: 13, lineHeight: 1.5 },
                children: selected.description,
              }),
            ],
          }),
          createElement(Button, {
            key: 'refresh',
            variant: 'toolbar',
            size: 'sm',
            icon: createElement(IconRefreshOutline16, { size: 14 }),
            'aria-label': 'Refresh RoleHub',
            title: 'Refresh RoleHub',
            disabled: loading,
            onClick: () => void refreshHubs().catch(() => undefined),
          }),
        ],
      }),
      createElement('div', {
        key: 'tags',
        style: { display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 12 },
        children: selected.tags.map(value => createElement(Pill, { key: value, children: `#${value}` })),
      }),
      createElement('div', {
        key: 'digest',
        'data-rolehub-digest-lock': true,
        title: selected.bundleDigest,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          marginTop: 14,
          padding: '9px 10px',
          borderRadius: 10,
          background: color.subtle,
          color: color.muted,
          fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
          fontSize: 11,
        },
        children: [
          createElement(IconCheckOutline16, { key: 'icon', size: 14 }),
          createElement('span', {
            key: 'copy',
            children: `Bundle locked · sha256:${shortDigest(selected.bundleDigest)}`,
          }),
        ],
      }),
      createElement('div', {
        key: 'capabilities',
        style: { display: 'grid', gap: 13, marginTop: 17 },
        children: [
          createElement(CapabilityGroup, { key: 'required', label: 'Required', values: selected.capabilities.required, tone: 'required' }),
          createElement(CapabilityGroup, { key: 'optional', label: 'Optional', values: selected.capabilities.optional, tone: 'optional' }),
          createElement(CapabilityGroup, { key: 'denied', label: 'Denied', values: selected.capabilities.denied, tone: 'denied' }),
        ],
      }),
      createElement('div', {
        key: 'start',
        style: { display: 'grid', gap: 9, marginTop: 18, paddingTop: 16, borderTop: `1px solid ${color.border}` },
        children: [
          createElement('strong', {
            key: 'title',
            style: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 13 },
            children: [createElement(IconSkillOutline16, { key: 'icon', size: 15 }), 'Create a role-scoped Session'],
          }),
          createElement(Input, {
            key: 'label',
            value: label,
            'aria-label': 'Role Session label',
            placeholder: selected.displayName,
            onChange: event => setLabel(event.currentTarget.value),
          }),
          createElement('textarea', {
            key: 'prompt',
            value: prompt,
            'aria-label': 'Initial role prompt',
            placeholder: 'Initial task (optional)',
            rows: 3,
            onChange: (event: { currentTarget: { value: string } }) => setPrompt(event.currentTarget.value),
            style: {
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              border: `1px solid ${color.border}`,
              borderRadius: 10,
              padding: '9px 11px',
              background: color.panel,
              color: color.text,
              font: 'inherit',
              fontSize: 13,
            },
          }),
          roomContext ? createElement('div', {
            key: 'room-context',
            style: { padding: '9px 10px', borderRadius: 9, background: color.subtle, color: color.muted, fontSize: 12 },
            children: `Attach to Room · ${roomContext.roomName}`,
          }) : snapshot.roomAvailable ? createElement('label', {
            key: 'room',
            style: { display: 'grid', gap: 5, color: color.muted, fontSize: 11 },
            children: [
              'Room (optional)',
              createElement('select', {
                value: roomId,
                'aria-label': 'Attach role Session to Room',
                onChange: (event: { currentTarget: { value: string } }) => setRoomId(event.currentTarget.value),
                style: {
                  minHeight: 36,
                  border: `1px solid ${color.border}`,
                  borderRadius: 10,
                  padding: '0 10px',
                  background: color.panel,
                  color: color.text,
                  font: 'inherit',
                },
                children: [
                  createElement('option', { key: 'none', value: '', children: 'No Room — independent Session' }),
                  ...snapshot.rooms.filter(room => room.status !== 'closed').map(room => createElement('option', {
                    key: room.id,
                    value: room.id,
                    children: room.name,
                  })),
                ],
              }),
            ],
          }) : createElement('div', {
            key: 'room-unavailable',
            style: { padding: '8px 10px', borderRadius: 9, background: color.subtle, color: color.muted, fontSize: 11 },
            children: 'Agent Team Room is optional and is not loaded. This role will start as an independent child Session.',
          }),
          createElement(Button, {
            key: 'submit',
            variant: 'primary',
            disabled: busy || !sessionId,
            onClick: () => void start().catch(() => undefined),
            children: busy ? 'Starting…' : roomId ? 'Start and attach to Room' : 'Start role Session',
          }),
        ],
      }),
    ],
  }) : createElement(Empty, { children: loading ? 'Loading RoleHub…' : 'Select a role to inspect its locked bundle and capabilities.' })

  return createElement('span', {
    children: [
      trigger,
      createElement(Modal, {
        key: 'modal',
        open,
        onClose: () => setOpen(false),
        title: 'RoleHub',
        description: 'Discover a role, inspect its requested capabilities, then create a separate verified Session.',
        children: createElement('div', {
          style: { width: '100%', color: color.text },
          children: [
            error ? createElement('div', {
              key: 'error',
              role: 'alert',
              style: { marginBottom: 10, padding: '9px 11px', borderRadius: 10, background: '#fff0f0', color: color.danger, fontSize: 12 },
              children: error,
            }) : null,
            notice ? createElement('div', {
              key: 'notice',
              role: 'status',
              style: { marginBottom: 10, padding: '9px 11px', borderRadius: 10, background: color.subtle, color: color.success, fontSize: 12 },
              children: notice,
            }) : null,
            createElement('div', {
              key: 'layout',
              style: { display: 'flex', flexWrap: 'wrap', gap: 12, minHeight: 470, maxHeight: 'min(74vh, 760px)' },
              children: [browser, detail],
            }),
          ],
        }),
      }),
    ],
  })
}

/** Required DSH services: official additive slots and the native Session runtime. */
export const inject = ['slots', 'sessions']

/** Add RoleHub controls without replacing a DSH root, sidebar, conversation, or details surface. */
export function apply(ctx: ClientContext): void {
  const sessions = ctx.get('sessions') as unknown as ISessions

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: ROLEHUB_HEADER_ENTRY_ID,
    order: 30,
  }, (props: RoleHubHeaderActionProps) => createElement(RoleHubLauncher, {
    sessionId: props.sessionId,
    sessions,
    location: 'header',
  })))

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: ROLEHUB_FOOTER_ENTRY_ID,
    order: 30,
  }, (props: RoleHubFooterActionProps) => {
    const state = props.useSessions(value => value)
    return createElement(RoleHubLauncher, {
      sessionId: state.current,
      sessions,
      wide: props.wide,
      location: 'footer',
    })
  }))

  ctx.slots.inject('agent-team-room.invite.provider', () => ctx.slots.register({
    name: 'agent-team-room.invite.provider',
    id: ROLEHUB_ROOM_INVITE_ENTRY_ID,
    order: 10,
  }, (props: RoleHubRoomInviteProps) => createElement(RoleHubLauncher, {
    sessionId: props.sessionId as SessionId,
    sessions,
    location: 'room',
    roomContext: {
      roomId: props.roomId,
      roomName: props.roomName,
      disabled: props.disabled,
      onAttached: props.onAttached,
    },
  })))
}
