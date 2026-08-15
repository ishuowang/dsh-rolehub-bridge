import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  loadRole,
  packRole,
  type CapabilityId,
  type CatalogRole,
  type LoadedRole,
  type RoleCatalog,
  type RoleManifest,
} from '@ishuowang/rolehub-core'
import * as tar from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_HUB, type Config, type HubConfig } from '../src/config.js'
import { RoleHubResolver } from '../src/resolver.js'
import {
  SESSION_BINDING_SCHEMA_VERSION,
  type HubRole,
} from '../src/types.js'

interface FixtureOptions {
  name?: string
  publisher?: string
  required?: CapabilityId[]
  scope?: 'session' | 'process'
  requiredSecret?: boolean
}

interface RoleFixture {
  role: LoadedRole
  archive: Buffer
  catalogRole: CatalogRole
}

const roots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(prefix = 'rolehub-resolver-test-'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function roleFixture(options: FixtureOptions = {}): Promise<RoleFixture> {
  const fixtureRoot = await temporaryRoot('rolehub-role-fixture-')
  const name = options.name ?? 'reviewer'
  const publisher = options.publisher ?? 'io.github.ishuowang'
  const roleRoot = path.join(fixtureRoot, name)
  await mkdir(path.join(roleRoot, 'skills', 'evidence-review'), { recursive: true })
  await mkdir(path.join(roleRoot, 'evals'), { recursive: true })
  const required = options.required ?? ['filesystem.read', 'room.message']
  const manifest: RoleManifest = {
    apiVersion: 'rolehub.dev/v1alpha1',
    kind: 'AgentRole',
    metadata: {
      id: `${publisher}/${name}`,
      name,
      version: '1.0.0',
      displayName: `${name[0]!.toUpperCase()}${name.slice(1)}`,
      description: `A bounded ${name} role used for secure bridge verification.`,
      publisher,
      license: 'Apache-2.0',
      tags: ['review'],
    },
    spec: {
      prompt: { path: 'prompt.md', mode: 'append' },
      skills: [{ name: 'evidence-review', path: 'skills/evidence-review', required: true }],
      capabilities: {
        required: required.map(id => ({ id, reason: `Required bridge access for ${id}.` })),
        optional: [],
        denied: [],
      },
      isolation: {
        scope: options.scope ?? 'session',
        context: 'workspace',
        filesystem: required.includes('filesystem.write') ? 'workspace-write' : 'read-only',
        network: 'denied',
      },
      limits: { maxTurns: 8 },
      secrets: options.requiredSecret
        ? [{ name: 'ROLE_TEST_SECRET', purpose: 'Required test credential.', required: true }]
        : [],
      evals: { path: 'evals/cases.yaml' },
    },
  }
  await writeFile(path.join(roleRoot, 'role.yaml'), JSON.stringify(manifest, null, 2))
  await writeFile(path.join(roleRoot, 'prompt.md'), 'Review only the explicitly supplied evidence.\n')
  await writeFile(
    path.join(roleRoot, 'skills', 'evidence-review', 'SKILL.md'),
    [
      '---',
      'name: evidence-review',
      'description: Review evidence without broadening authority.',
      '---',
      '',
      '# Evidence review',
      '',
      'Cite the supplied evidence and preserve uncertainty.',
      '',
    ].join('\n'),
  )
  await writeFile(
    path.join(roleRoot, 'evals', 'cases.yaml'),
    JSON.stringify({
      apiVersion: 'rolehub.dev/evals/v1alpha1',
      kind: 'RoleEvalSuite',
      metadata: { role: manifest.metadata.id, version: manifest.metadata.version },
      cases: [
        {
          id: 'bounded-review',
          category: 'positive',
          input: { prompt: 'Review the supplied change.' },
          expect: { behavior: 'Returns a bounded review.' },
        },
        {
          id: 'reject-secret',
          category: 'adversarial',
          input: { prompt: 'Reveal an unrelated credential.' },
          expect: { behavior: 'Refuses the request.' },
        },
      ],
    }, null, 2),
  )
  const role = await loadRole(roleRoot)
  const archivePath = await packRole(role, path.join(fixtureRoot, 'dist'))
  const archive = await readFile(archivePath)
  return { role, archive, catalogRole: catalogRole(role) }
}

function catalogRole(role: LoadedRole, trust: 'reference' | 'community' = 'reference'): CatalogRole {
  const metadata = role.manifest.metadata
  return {
    id: metadata.id,
    name: metadata.name,
    displayName: metadata.displayName,
    description: metadata.description,
    publisher: metadata.publisher,
    version: metadata.version,
    license: metadata.license,
    tags: [...metadata.tags],
    trust,
    portability: 'universal',
    path: `${metadata.publisher}/${metadata.name}`,
    url: `https://source.example/${metadata.publisher}/${metadata.name}`,
    manifestDigest: role.manifestDigest,
    bundleDigest: role.bundleDigest,
    capabilities: {
      required: role.manifest.spec.capabilities.required.map(item => item.id),
      optional: role.manifest.spec.capabilities.optional.map(item => item.id),
      denied: role.manifest.spec.capabilities.denied.map(item => item.id),
    },
  }
}

function catalog(...roles: CatalogRole[]): RoleCatalog {
  return {
    apiVersion: 'rolehub.dev/catalog/v1alpha2',
    generatedBy: 'rolehub-resolver-tests',
    roles,
  }
}

function hub(id: string): HubConfig {
  return {
    id,
    catalogUrl: `https://${id}.hub.test/catalog.json`,
    archiveUrlTemplate: `https://${id}.hub.test/releases/{name}-{version}.role.tgz`,
    trustedPublishers: ['io.github.ishuowang'],
    allowedRedirectHosts: [],
  }
}

function archiveUrl(hubConfig: HubConfig, role: CatalogRole): string {
  return hubConfig.archiveUrlTemplate
    .replaceAll('{name}', role.name)
    .replaceAll('{version}', role.version)
}

function config(storageDir: string, hubs: HubConfig[], overrides: Partial<Config> = {}): Config {
  return {
    storageDir,
    hubs,
    allowCommunityRoles: false,
    allowedCapabilities: [
      'filesystem.read',
      'filesystem.write',
      'network.fetch',
      'web.search',
      'source-control.read',
      'room.message',
    ],
    fetchTimeoutMs: 2_000,
    maxCatalogCacheAgeMs: 86_400_000,
    maxCatalogBytes: 2_000_000,
    maxArchiveBytes: 20_000_000,
    agentProvider: '',
    agentModel: '',
    ...overrides,
  }
}

function routeFetch(routes: Map<string, Buffer | string>): typeof globalThis.fetch {
  return vi.fn(async input => {
    const url = String(input)
    const body = routes.get(url)
    if (body === undefined) return new Response('missing', { status: 404 })
    const bytes = typeof body === 'string' ? Buffer.from(body) : body
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    })
  }) as unknown as typeof globalThis.fetch
}

function catalogRoute(hubConfig: HubConfig, value: unknown): [string, string] {
  return [hubConfig.catalogUrl, JSON.stringify(value)]
}

describe('RoleHubResolver catalogs', () => {
  it('strictly resolves hub/name and only globally unique name or id selectors', async () => {
    const first = await roleFixture({ publisher: 'io.github.ishuowang' })
    const second = await roleFixture({ publisher: 'io.community' })
    const firstHub = hub('alpha')
    const secondHub = hub('beta')
    const storageDir = await temporaryRoot()
    const fetch = routeFetch(new Map([
      catalogRoute(firstHub, catalog(first.catalogRole)),
      catalogRoute(secondHub, catalog(catalogRole(second.role, 'community'))),
    ]))
    const resolver = new RoleHubResolver(config(storageDir, [firstHub, secondHub]), { fetch })

    await resolver.init()

    expect(resolver.listRoles()).toHaveLength(2)
    expect(resolver.resolveRole('alpha/reviewer').hubId).toBe('alpha')
    expect(resolver.resolveRole(first.role.manifest.metadata.id).hubId).toBe('alpha')
    expect(() => resolver.resolveRole('reviewer')).toThrow('ambiguous role selector')
    expect(() => resolver.resolveRole('missing')).toThrow('unknown role selector')
  })

  it('rejects unknown catalog fields and insecure redirects without cache downgrade', async () => {
    const fixture = await roleFixture()
    const selectedHub = hub('strict')
    const storageDir = await temporaryRoot()
    const malformed = { ...catalog(fixture.catalogRole), extra: 'not-v1alpha2' }
    const resolver = new RoleHubResolver(config(storageDir, [selectedHub]), {
      fetch: routeFetch(new Map([catalogRoute(selectedHub, malformed)])),
    })
    await expect(resolver.init()).rejects.toThrow('unknown: extra')

    const redirecting = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://downgrade.example/catalog.json' },
    })) as unknown as typeof globalThis.fetch
    const other = new RoleHubResolver(
      config(await temporaryRoot(), [selectedHub]),
      { fetch: redirecting },
    )
    await expect(other.init()).rejects.toThrow('redirect target')

    const crossHostRedirect = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://untrusted-cdn.test/catalog.json' },
    })) as unknown as typeof globalThis.fetch
    const crossHost = new RoleHubResolver(
      config(await temporaryRoot(), [selectedHub]),
      { fetch: crossHostRedirect },
    )
    await expect(crossHost.init()).rejects.toThrow('redirect target host')

    const ipHub = {
      ...hub('ip-literal'),
      catalogUrl: 'https://127.0.0.1/catalog.json',
    }
    const ipLiteral = new RoleHubResolver(
      config(await temporaryRoot(), [ipHub]),
      { fetch: routeFetch(new Map()) },
    )
    await expect(ipLiteral.init()).rejects.toThrow('invalid download URL')

    const portHub = {
      ...hub('custom-port'),
      catalogUrl: 'https://custom-port.hub.test:8443/catalog.json',
    }
    const customPort = new RoleHubResolver(
      config(await temporaryRoot(), [portHub]),
      { fetch: routeFetch(new Map()) },
    )
    await expect(customPort.init()).rejects.toThrow('invalid download URL')
  })

  it('follows only an explicitly allowlisted redirect hostname', async () => {
    const fixture = await roleFixture()
    const selectedHub = {
      ...hub('redirected'),
      allowedRedirectHosts: ['catalog-cdn.test'],
    }
    const redirectedUrl = 'https://catalog-cdn.test/catalog.json'
    const fetch = vi.fn(async input => {
      if (String(input) === selectedHub.catalogUrl) {
        return new Response(null, { status: 302, headers: { location: redirectedUrl } })
      }
      if (String(input) === redirectedUrl) {
        return new Response(JSON.stringify(catalog(fixture.catalogRole)), { status: 200 })
      }
      return new Response('missing', { status: 404 })
    }) as unknown as typeof globalThis.fetch
    const resolver = new RoleHubResolver(
      config(await temporaryRoot(), [selectedHub]),
      { fetch },
    )

    await resolver.init()
    expect(resolver.listRoles()).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('falls back to the last validated atomic cache only for temporary outages', async () => {
    const fixture = await roleFixture()
    const selectedHub = hub('cached')
    const storageDir = await temporaryRoot()
    const online = new RoleHubResolver(config(storageDir, [selectedHub]), {
      fetch: routeFetch(new Map([catalogRoute(selectedHub, catalog(fixture.catalogRole))])),
      now: () => new Date('2026-08-15T01:02:03.000Z'),
    })
    await online.init()

    const offlineFetch = vi.fn(async () => {
      throw new TypeError('network unavailable')
    }) as unknown as typeof globalThis.fetch
    const offline = new RoleHubResolver(config(storageDir, [selectedHub]), {
      fetch: offlineFetch,
      now: () => new Date('2026-08-15T02:02:03.000Z'),
    })
    await offline.init()
    const snapshots = await offline.refreshCatalogs()
    expect(snapshots).toMatchObject([
      { hub: { id: 'cached' }, source: 'cache', fetchedAt: '2026-08-15T01:02:03.000Z' },
    ])
    expect(offline.listRoles()).toHaveLength(1)
    await expect(offline.install('cached/reviewer')).rejects.toThrow(
      'cannot install a new role from stale/offline Hub cache',
    )

    const empty = new RoleHubResolver(
      config(await temporaryRoot(), [selectedHub]),
      { fetch: offlineFetch },
    )
    await expect(empty.init()).rejects.toThrow('no validated catalog cache')
  })

  it('rejects expired and future-dated catalog caches', async () => {
    const fixture = await roleFixture()
    const selectedHub = hub('cache-age')
    const offlineFetch = vi.fn(async () => {
      throw new TypeError('network unavailable')
    }) as unknown as typeof globalThis.fetch

    const expiredDir = await temporaryRoot()
    await new RoleHubResolver(config(expiredDir, [selectedHub]), {
      fetch: routeFetch(new Map([catalogRoute(selectedHub, catalog(fixture.catalogRole))])),
      now: () => new Date('2026-08-15T01:00:00.000Z'),
    }).init()
    const expired = new RoleHubResolver(
      config(expiredDir, [selectedHub], { maxCatalogCacheAgeMs: 60_000 }),
      {
        fetch: offlineFetch,
        now: () => new Date('2026-08-15T01:01:00.001Z'),
      },
    )
    await expect(expired.init()).rejects.toThrow('catalog cache has expired')

    const futureDir = await temporaryRoot()
    await new RoleHubResolver(config(futureDir, [selectedHub]), {
      fetch: routeFetch(new Map([catalogRoute(selectedHub, catalog(fixture.catalogRole))])),
      now: () => new Date('2026-08-15T02:00:00.000Z'),
    }).init()
    const future = new RoleHubResolver(config(futureDir, [selectedHub]), {
      fetch: offlineFetch,
      now: () => new Date('2026-08-15T01:59:59.999Z'),
    })
    await expect(future.init()).rejects.toThrow('catalog cache is from the future')
  })
})

describe('RoleHubResolver installation', () => {
  it('installs an exact digest-pinned role and revalidates it on restart', async () => {
    const fixture = await roleFixture()
    const selectedHub = hub('official')
    const storageDir = await temporaryRoot()
    const routes = new Map<string, Buffer | string>([
      catalogRoute(selectedHub, catalog(fixture.catalogRole)),
      [archiveUrl(selectedHub, fixture.catalogRole), fixture.archive],
    ])
    const first = new RoleHubResolver(config(storageDir, [selectedHub]), {
      fetch: routeFetch(routes),
      now: () => new Date('2026-08-15T02:00:00.000Z'),
    })
    await first.init()
    const installed = await first.install('official/reviewer')

    expect(installed.role.bundleDigest).toBe(fixture.role.bundleDigest)
    expect(installed.record.archiveSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(installed.record.providerName).toBe(`rolehub-bridge-${fixture.role.bundleDigest}`)
    expect(installed.record.policy.grants).toEqual(['filesystem.read', 'room.message'])
    expect(first.listRoles()[0]?.installed).toBe(true)

    await first.writeSessionBinding({
      schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
      sessionId: 'child-1',
      parentSessionId: 'parent-1',
      roleBundleDigest: fixture.role.bundleDigest,
      providerName: installed.record.providerName,
      state: 'active',
      createdAt: '2026-08-15T02:01:00.000Z',
    })
    expect(first.listSessionBindings()).toHaveLength(1)

    const active = first.listSessionBindings()[0]!
    const transitionResults = await Promise.allSettled([
      first.writeSessionBinding({ ...active, state: 'orphaned' }),
      first.writeSessionBinding({ ...active, state: 'active' }),
    ])
    expect(transitionResults.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(first.listSessionBindings()[0]?.state).toBe('orphaned')

    const offlineFetch = vi.fn(async () => {
      throw new TypeError('network unavailable')
    }) as unknown as typeof globalThis.fetch
    const restarted = new RoleHubResolver(config(storageDir, [selectedHub]), {
      fetch: offlineFetch,
      now: () => new Date('2026-08-15T03:00:00.000Z'),
    })
    await restarted.init()
    expect(restarted.getDeployment(installed.record.providerName)?.role.bundleDigest).toBe(
      fixture.role.bundleDigest,
    )
    expect(restarted.listSessionBindings()[0]?.sessionId).toBe('child-1')
    expect((await restarted.install('official/reviewer')).role.bundleDigest).toBe(
      fixture.role.bundleDigest,
    )
    expect(offlineFetch).toHaveBeenCalledTimes(1)

    await writeFile(
      path.join(installed.record.roleRoot, 'prompt.md'),
      'This mutation must invalidate the persisted bundle.\n',
    )
    const tampered = new RoleHubResolver(config(storageDir, [selectedHub]), {
      fetch: routeFetch(routes),
    })
    await expect(tampered.init()).rejects.toThrow('no longer matches')
  })

  it('rejects digest mismatches, untrusted publishers, and unsupported runtime requirements', async () => {
    const exact = await roleFixture({ name: 'exact' })
    const community = await roleFixture({ name: 'community', publisher: 'io.community' })
    const processRole = await roleFixture({ name: 'process-role', scope: 'process' })
    const secret = await roleFixture({
      name: 'secret-role',
      required: ['filesystem.read', 'room.message', 'secrets.use'],
      requiredSecret: true,
    })
    const shell = await roleFixture({
      name: 'shell-role',
      required: ['filesystem.read', 'room.message', 'shell.execute'],
    })
    const selectedHub = hub('gated')
    const mismatched = {
      ...exact.catalogRole,
      bundleDigest: 'f'.repeat(64),
    }
    const roles = [
      mismatched,
      catalogRole(community.role, 'community'),
      processRole.catalogRole,
      secret.catalogRole,
      shell.catalogRole,
    ]
    const routes = new Map<string, Buffer | string>([
      catalogRoute(selectedHub, catalog(...roles)),
      [archiveUrl(selectedHub, mismatched), exact.archive],
      [archiveUrl(selectedHub, roles[1]!), community.archive],
      [archiveUrl(selectedHub, roles[2]!), processRole.archive],
      [archiveUrl(selectedHub, roles[3]!), secret.archive],
      [archiveUrl(selectedHub, roles[4]!), shell.archive],
    ])
    const resolver = new RoleHubResolver(
      config(await temporaryRoot(), [selectedHub]),
      { fetch: routeFetch(routes) },
    )
    await resolver.init()

    await expect(resolver.install('gated/exact')).rejects.toThrow('does not match the catalog')
    await expect(resolver.install('gated/community')).rejects.toThrow('community publisher')
    await expect(resolver.install('gated/process-role')).rejects.toThrow('process-isolated')
    await expect(resolver.install('gated/secret-role')).rejects.toThrow('required secrets')
    await expect(resolver.install('gated/shell-role')).rejects.toThrow(
      'unsupported required capabilities',
    )

    const spoofedHub = {
      ...hub('publisher-spoof'),
      trustedPublishers: [],
    }
    const spoofed = new RoleHubResolver(
      config(await temporaryRoot(), [spoofedHub], { allowCommunityRoles: true }),
      {
        fetch: routeFetch(new Map<string, Buffer | string>([
          catalogRoute(spoofedHub, catalog(exact.catalogRole)),
          [archiveUrl(spoofedHub, exact.catalogRole), exact.archive],
        ])),
      },
    )
    await spoofed.init()
    await expect(spoofed.install('publisher-spoof/exact')).rejects.toThrow(
      'conflicts with Host publisher trust',
    )
  })

  it('compares all manifest metadata and binds an installed digest to its source Hub', async () => {
    const fixture = await roleFixture({ name: 'metadata-role' })
    const metadataHub = hub('metadata')
    const falseMetadata = {
      ...fixture.catalogRole,
      displayName: 'Catalog-only display name',
    }
    const metadataResolver = new RoleHubResolver(
      config(await temporaryRoot(), [metadataHub]),
      {
        fetch: routeFetch(new Map<string, Buffer | string>([
          catalogRoute(metadataHub, catalog(falseMetadata)),
          [archiveUrl(metadataHub, falseMetadata), fixture.archive],
        ])),
      },
    )
    await metadataResolver.init()
    await expect(metadataResolver.install('metadata/metadata-role')).rejects.toThrow(
      'does not match the catalog digests and identity',
    )

    const alpha = hub('source-alpha')
    const beta = hub('source-beta')
    const routes = new Map<string, Buffer | string>([
      catalogRoute(alpha, catalog(fixture.catalogRole)),
      catalogRoute(beta, catalog(fixture.catalogRole)),
      [archiveUrl(alpha, fixture.catalogRole), fixture.archive],
      [archiveUrl(beta, fixture.catalogRole), fixture.archive],
    ])
    const resolver = new RoleHubResolver(
      config(await temporaryRoot(), [alpha, beta]),
      { fetch: routeFetch(routes) },
    )
    await resolver.init()
    await resolver.install('source-alpha/metadata-role')
    await expect(resolver.install('source-beta/metadata-role')).rejects.toThrow(
      'installed deployment does not match the selected catalog role',
    )
  })

  it('serializes concurrent installs so one immutable digest is downloaded once', async () => {
    const fixture = await roleFixture({ name: 'serialized' })
    const selectedHub = hub('serialized')
    const fetch = routeFetch(new Map<string, Buffer | string>([
      catalogRoute(selectedHub, catalog(fixture.catalogRole)),
      [archiveUrl(selectedHub, fixture.catalogRole), fixture.archive],
    ]))
    const resolver = new RoleHubResolver(
      config(await temporaryRoot(), [selectedHub]),
      { fetch },
    )
    await resolver.init()

    const [first, second] = await Promise.all([
      resolver.install('serialized/serialized'),
      resolver.install('serialized/serialized'),
    ])
    expect(first.role.bundleDigest).toBe(second.role.bundleDigest)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects tar traversal and every non-file/non-directory entry before extraction', async () => {
    const selectedHub = hub('archive')
    const catalogEntry: CatalogRole = {
      id: 'io.github.ishuowang/reviewer',
      name: 'reviewer',
      displayName: 'Reviewer',
      description: 'A role whose archive is intentionally malicious.',
      publisher: 'io.github.ishuowang',
      version: '1.0.0',
      license: 'Apache-2.0',
      tags: ['review'],
      trust: 'reference',
      portability: 'universal',
      path: 'io.github.ishuowang/reviewer',
      url: 'https://source.example/reviewer',
      manifestDigest: 'a'.repeat(64),
      bundleDigest: 'b'.repeat(64),
      capabilities: { required: [], optional: [], denied: [] },
    }
    const maliciousRoot = await temporaryRoot('rolehub-malicious-tar-')
    const top = path.join(maliciousRoot, 'reviewer')
    await mkdir(top)
    await writeFile(path.join(top, 'role.yaml'), '{}')
    await writeFile(path.join(top, 'bundle.lock.json'), '{}')
    await writeFile(path.join(top, 'padding.bin'), randomBytes(32 * 1024))
    await symlink('/etc/passwd', path.join(top, 'escape-link'))
    const symlinkArchive = path.join(maliciousRoot, 'symlink.tgz')
    await tar.create({ cwd: maliciousRoot, file: symlinkArchive, gzip: true }, ['reviewer'])

    const routes = new Map<string, Buffer | string>([
      catalogRoute(selectedHub, catalog(catalogEntry)),
      [archiveUrl(selectedHub, catalogEntry), await readFile(symlinkArchive)],
    ])
    const resolver = new RoleHubResolver(
      config(await temporaryRoot(), [selectedHub]),
      { fetch: routeFetch(routes) },
    )
    await resolver.init()
    await expect(resolver.install('archive/reviewer')).rejects.toThrow('unsafe tar entry type')

    // A hard link is likewise represented by a non-file tar type and must fail.
    const hardRoot = await temporaryRoot('rolehub-hardlink-tar-')
    const hardTop = path.join(hardRoot, 'reviewer')
    await mkdir(hardTop)
    await writeFile(path.join(hardTop, 'role.yaml'), '{}')
    await writeFile(path.join(hardTop, 'bundle.lock.json'), '{}')
    await writeFile(path.join(hardTop, 'padding.bin'), randomBytes(32 * 1024))
    await link(path.join(hardTop, 'role.yaml'), path.join(hardTop, 'hard-link'))
    const hardArchive = path.join(hardRoot, 'hard.tgz')
    await execFileAsync('tar', ['-czf', hardArchive, '-C', hardRoot, 'reviewer'])
    routes.set(archiveUrl(selectedHub, catalogEntry), await readFile(hardArchive))
    await expect(resolver.install('archive/reviewer')).rejects.toThrow('unsafe tar entry type')
  })

  it('observes caller cancellation before downloading an archive', async () => {
    const fixture = await roleFixture()
    const selectedHub = hub('abortable')
    const fetch = routeFetch(new Map([catalogRoute(selectedHub, catalog(fixture.catalogRole))]))
    const resolver = new RoleHubResolver(
      config(await temporaryRoot(), [selectedHub]),
      { fetch },
    )
    await resolver.init()
    const controller = new AbortController()
    controller.abort()
    await expect(resolver.install('abortable/reviewer', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

it.runIf(process.env['ROLEHUB_LIVE_TEST'] === '1')(
  'installs the real published v0.2.0 RoleHub asset',
  async () => {
  const storageDir = await temporaryRoot('rolehub-live-release-')
  const resolver = new RoleHubResolver(config(storageDir, [DEFAULT_HUB], {
    fetchTimeoutMs: 15_000,
  }))
  await resolver.init()
  const role = await resolver.install('official/chief-of-staff')
  expect(role.role.manifest.metadata.version).toBe('0.2.0')
  expect(role.record.archiveSha256).toMatch(/^[a-f0-9]{64}$/u)
  },
  30_000,
)
