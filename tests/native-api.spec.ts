import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import {
  ROLEHUB_NATIVE_API_PREFIX,
  apply,
  inject,
  isSameSiteRead,
  nativeBridgeSnapshot,
} from '../src/native-api.js'
import type { BridgeSnapshot } from '../src/types.js'

interface RegisteredRoute {
  kind: 'prefix'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

function request(method: string, url: string, site?: string): IncomingMessage {
  return {
    method,
    url,
    headers: site ? { 'sec-fetch-site': site } : {},
  } as IncomingMessage
}

function response() {
  let status: number | undefined
  let headers: Record<string, string> | undefined
  let body: unknown
  const value = {
    writeHead: vi.fn((nextStatus: number, nextHeaders?: Record<string, string>) => {
      status = nextStatus
      headers = nextHeaders
      return value
    }),
    end: vi.fn((nextBody?: unknown) => {
      body = nextBody
      return value
    }),
  }
  return {
    value: value as unknown as ServerResponse,
    status: () => status,
    headers: () => headers,
    body: () => body,
  }
}

function snapshot(): BridgeSnapshot {
  return {
    hubs: [{ id: 'official', catalogUrl: 'https://roles.example/catalog.json' }],
    roles: [{
      hubId: 'official',
      id: 'io.example/reviewer',
      name: 'reviewer',
      displayName: 'Careful Reviewer',
      description: 'Reviews a bounded change and reports evidence.',
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
    }],
    rooms: [{ id: 'room-1', name: 'Review room', status: 'open' }],
    roomAvailable: true,
  }
}

function mount(options: { live?: boolean; fail?: boolean } = {}) {
  let route: RegisteredRoute | undefined
  const agent = { id: 'leader-1' }
  const agents = {
    get: vi.fn(() => options.live === false ? undefined : agent),
  }
  const roleHubBridge = {
    snapshot: vi.fn(() => {
      if (options.fail) throw new Error('/private/roles/reviewer: upstream token=secret')
      return snapshot()
    }),
  }
  const register = vi.fn((candidate: RegisteredRoute) => {
    route = candidate
    return () => undefined
  })
  const effect = vi.fn((callback: () => unknown) => callback())
  apply({ agents, roleHubBridge, webServer: { register }, effect } as unknown as Context)
  if (!route) throw new Error('native RoleHub route was not registered')
  return { route, agent, agents, roleHubBridge, register, effect }
}

describe('RoleHub native read API', () => {
  it('registers one read surface with explicit live-Agent dependencies', () => {
    const { route, register, effect } = mount()

    expect(inject).toEqual(['agents', 'roleHubBridge', 'webServer'])
    expect(register).toHaveBeenCalledOnce()
    expect(effect).toHaveBeenCalledOnce()
    expect(route).toMatchObject({ kind: 'prefix', path: '/rolehub-bridge/api' })
    expect(ROLEHUB_NATIVE_API_PREFIX).toBe('/rolehub-bridge/api/session/')
  })

  it.each([undefined, 'same-origin', 'same-site', 'none'])(
    'accepts same-site browser context %s',
    site => expect(isSameSiteRead(request('GET', '/', site))).toBe(true),
  )

  it.each(['cross-site', 'unknown'])(
    'rejects cross-site browser context %s',
    site => expect(isSameSiteRead(request('GET', '/', site))).toBe(false),
  )

  it('returns an allowlisted snapshot scoped to the exact live Agent', async () => {
    const { route, agent, agents, roleHubBridge } = mount()
    const res = response()

    await route.handler(
      request('GET', `${ROLEHUB_NATIVE_API_PREFIX}leader-1`, 'same-origin'),
      res.value,
    )

    expect(agents.get).toHaveBeenCalledExactlyOnceWith('leader-1')
    expect(roleHubBridge.snapshot).toHaveBeenCalledExactlyOnceWith(agent)
    expect(res.status()).toBe(200)
    expect(res.headers()).toMatchObject({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    })
    expect(JSON.parse(String(res.body()))).toEqual({
      ...snapshot(),
      hubs: [{ id: 'official' }],
    })
  })

  it('copies only browser-safe fields from bridge objects', () => {
    const projected = nativeBridgeSnapshot({
      ...snapshot(),
      hubs: [{
        id: 'official',
        catalogUrl: 'https://roles.example/catalog.json',
        token: 'PRIVATE_TOKEN',
      }],
      rooms: [{ id: 'room-1', name: 'Review room', status: 'open', topic: 'PRIVATE_TOPIC' }],
      roles: [{
        ...snapshot().roles[0]!,
        archiveUrl: 'https://roles.example/private.tgz',
        roleRoot: '/private/role/root',
      }],
    } as unknown as BridgeSnapshot)

    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE|archiveUrl|roleRoot|token|topic/u)
    expect(projected.hubs).toEqual([{ id: 'official' }])
    expect(projected.roles[0]?.bundleDigest).toBe('b'.repeat(64))
  })

  it('supports HEAD without exposing a response body', async () => {
    const { route, roleHubBridge } = mount()
    const res = response()

    await route.handler(request('HEAD', `${ROLEHUB_NATIVE_API_PREFIX}leader-1`, 'same-site'), res.value)

    expect(roleHubBridge.snapshot).toHaveBeenCalledOnce()
    expect(res.status()).toBe(200)
    expect(res.body()).toBeUndefined()
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'rejects mutation method %s before resolving a Session',
    async method => {
      const { route, agents, roleHubBridge } = mount()
      const res = response()

      await route.handler(request(method, `${ROLEHUB_NATIVE_API_PREFIX}leader-1`, 'same-origin'), res.value)

      expect(agents.get).not.toHaveBeenCalled()
      expect(roleHubBridge.snapshot).not.toHaveBeenCalled()
      expect(res.status()).toBe(405)
      expect(res.headers()).toEqual({ allow: 'GET, HEAD' })
    },
  )

  it('rejects cross-site reads before resolving a Session', async () => {
    const { route, agents } = mount()
    const res = response()

    await route.handler(request('GET', `${ROLEHUB_NATIVE_API_PREFIX}leader-1`, 'cross-site'), res.value)

    expect(agents.get).not.toHaveBeenCalled()
    expect(res.status()).toBe(403)
    expect(JSON.parse(String(res.body()))).toEqual({ error: 'cross_site_rolehub_read_denied' })
  })

  it('requires a live Agent before asking the bridge for scoped data', async () => {
    const { route, roleHubBridge } = mount({ live: false })
    const res = response()

    await route.handler(request('GET', `${ROLEHUB_NATIVE_API_PREFIX}cold-session`, 'same-origin'), res.value)

    expect(roleHubBridge.snapshot).not.toHaveBeenCalled()
    expect(res.status()).toBe(404)
    expect(JSON.parse(String(res.body()))).toEqual({ error: 'session_not_live' })
  })

  it('does not expose resolver diagnostics when a snapshot fails', async () => {
    const { route } = mount({ fail: true })
    const res = response()

    await route.handler(request('GET', `${ROLEHUB_NATIVE_API_PREFIX}leader-1`, 'same-origin'), res.value)

    expect(res.status()).toBe(503)
    expect(JSON.parse(String(res.body()))).toEqual({ error: 'rolehub_snapshot_unavailable' })
    expect(String(res.body())).not.toMatch(/private|token|secret/u)
  })

  it.each([
    ['/rolehub-bridge/api', 404, 'not_found'],
    [ROLEHUB_NATIVE_API_PREFIX, 404, 'not_found'],
    [`${ROLEHUB_NATIVE_API_PREFIX}leader-1/extra`, 404, 'not_found'],
    [`${ROLEHUB_NATIVE_API_PREFIX}%E0%A4%A`, 400, 'invalid_session_id'],
    [`${ROLEHUB_NATIVE_API_PREFIX}%00`, 400, 'invalid_session_id'],
  ])('rejects invalid route %s', async (url, expectedStatus, expectedError) => {
    const { route, roleHubBridge } = mount()
    const res = response()

    await route.handler(request('GET', url as string, 'same-origin'), res.value)

    expect(roleHubBridge.snapshot).not.toHaveBeenCalled()
    expect(res.status()).toBe(expectedStatus)
    expect(JSON.parse(String(res.body()))).toEqual({ error: expectedError })
  })
})
