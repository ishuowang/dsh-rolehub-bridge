import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { compatibility as dsharnessCompatibility } from '@ishuowang/rolehub-compat-dsharness'
import {
  CAPABILITY_IDS,
  buildBundleLock,
  loadRole,
  type CapabilityId,
  type CatalogRole,
  type LoadedRole,
  type RoleCatalog,
} from '@ishuowang/rolehub-core'
import * as tar from 'tar'

import {
  assertConfig,
  resolveStorageDir,
  type Config,
  type HubConfig,
} from './config.js'
import {
  assertEffectivePolicy,
  createEffectivePolicy,
  HOST_SUPPORTED_CAPABILITIES,
} from './policy.js'
import { RoleHubStorage } from './storage.js'
import {
  DEPLOYMENT_SCHEMA_VERSION,
  ROLEHUB_PROVIDER_PREFIX,
  type HubCatalogSnapshot,
  type HubRole,
  type LoadedRoleDeployment,
  type RoleDeploymentRecord,
  type RoleSessionBinding,
  type RoleView,
} from './types.js'

const CATALOG_API_VERSION = 'rolehub.dev/catalog/v1alpha2'
const CATALOG_CACHE_SCHEMA_VERSION = 1
const MAX_REDIRECTS = 5
const MAX_ARCHIVE_ENTRIES = 512
const MAX_EXPANDED_ARCHIVE_BYTES = 64 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/u
const PORTABLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const PUBLISHER = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

interface ResolverOptions {
  fetch?: typeof globalThis.fetch
  now?: () => Date
}

interface CatalogCacheReceipt {
  schemaVersion: typeof CATALOG_CACHE_SCHEMA_VERSION
  hub: HubConfig
  fetchedAt: string
  catalog: RoleCatalog
}

interface ArchiveEntry {
  path: string
  type: 'File' | 'Directory'
  size: number
}

/**
 * Resolves untrusted, multi-Hub metadata into digest-pinned local deployments.
 * Network catalogs are never authoritative for grants; they only select bytes
 * that must subsequently pass RoleHub core validation and Host policy.
 */
export class RoleHubResolver {
  private readonly storage: RoleHubStorage
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly now: () => Date
  private snapshots = new Map<string, HubCatalogSnapshot>()
  private deployments = new Map<string, LoadedRoleDeployment>()
  private sessionBindings = new Map<string, RoleSessionBinding>()
  private operationQueue: Promise<void> = Promise.resolve()
  private sessionWriteQueue: Promise<void> = Promise.resolve()
  private initialized = false

  constructor(
    private readonly config: Config,
    options: ResolverOptions = {},
  ) {
    assertConfig(config)
    this.storage = new RoleHubStorage(resolveStorageDir(config.storageDir))
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.now = options.now ?? (() => new Date())
  }

  async init(): Promise<void> {
    await this.storage.init()
    await this.loadDeployments()
    const bindings = await this.storage.listSessionBindings()
    for (const binding of bindings) {
      const deployment = this.deployments.get(binding.roleBundleDigest)
      if (!deployment || deployment.record.providerName !== binding.providerName) {
        throw new Error(
          `rolehub-bridge: Session ${binding.sessionId} references an unverified deployment`,
        )
      }
    }
    this.sessionBindings = new Map(bindings.map(binding => [binding.sessionId, binding]))
    await this.refreshCatalogs()
    this.initialized = true
  }

  /** Refresh every configured Hub, falling back only for temporary availability failures. */
  async refreshCatalogs(signal?: AbortSignal): Promise<HubCatalogSnapshot[]> {
    return this.enqueueOperation(() => this.refreshCatalogsUnlocked(signal))
  }

  private async refreshCatalogsUnlocked(signal?: AbortSignal): Promise<HubCatalogSnapshot[]> {
    signal?.throwIfAborted()
    const refreshed = await Promise.all(
      this.config.hubs.map(hub => this.refreshOneHub(hub, signal)),
    )
    signal?.throwIfAborted()
    this.snapshots = new Map(refreshed.map(snapshot => [snapshot.hub.id, snapshot]))
    return refreshed.map(copySnapshot)
  }

  listRoles(): RoleView[] {
    this.assertReady()
    return [...this.snapshots.values()]
      .flatMap(snapshot => snapshot.roles)
      .sort(compareHubRoles)
      .map(role => ({
        hubId: role.hubId,
        id: role.id,
        name: role.name,
        displayName: role.displayName,
        description: role.description,
        publisher: role.publisher,
        version: role.version,
        license: role.license,
        tags: [...role.tags],
        trust: role.trust,
        manifestDigest: role.manifestDigest,
        bundleDigest: role.bundleDigest,
        capabilities: copyCapabilities(role.capabilities),
        installed: this.deployments.has(role.bundleDigest),
      }))
  }

  resolveRole(selector: string): HubRole {
    this.assertReady()
    const value = selector.trim()
    if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error('rolehub-bridge: role selector must be non-empty printable text')
    }
    const slash = value.indexOf('/')
    if (slash > 0 && slash === value.lastIndexOf('/')) {
      const hubId = value.slice(0, slash)
      const roleName = value.slice(slash + 1)
      const snapshot = this.snapshots.get(hubId)
      if (snapshot) {
        const matches = snapshot.roles.filter(role => role.name === roleName)
        if (matches.length === 1) return copyHubRole(matches[0]!)
        if (matches.length > 1) ambiguousSelector(value)
      }
    }

    const matches = [...this.snapshots.values()]
      .flatMap(snapshot => snapshot.roles)
      .filter(role => role.name === value || role.id === value)
    if (matches.length === 0) throw new Error(`rolehub-bridge: unknown role selector "${value}"`)
    if (matches.length > 1) ambiguousSelector(value)
    return copyHubRole(matches[0]!)
  }

  async install(
    selectorOrRole: string | HubRole,
    signal?: AbortSignal,
  ): Promise<LoadedRoleDeployment> {
    return this.enqueueOperation(() => this.installUnlocked(selectorOrRole, signal))
  }

  private async installUnlocked(
    selectorOrRole: string | HubRole,
    signal?: AbortSignal,
  ): Promise<LoadedRoleDeployment> {
    this.assertReady()
    signal?.throwIfAborted()
    const selected = this.canonicalRole(selectorOrRole)
    const alreadyInstalled = this.deployments.get(selected.bundleDigest)
    if (alreadyInstalled) {
      this.assertDeploymentAgainstCatalog(alreadyInstalled, selected)
      return alreadyInstalled
    }

    const snapshot = this.requireSnapshot(selected.hubId)
    if (snapshot.source === 'cache') {
      throw new Error(
        `rolehub-bridge: cannot install a new role from stale/offline Hub cache ${selected.hubId}`,
      )
    }

    const staging = await this.storage.createInstallStaging()
    try {
      const archive = await fetchBounded(
        selected.archiveUrl,
        this.config.maxArchiveBytes,
        this.config.fetchTimeoutMs,
        this.fetchImpl,
        snapshot.hub.allowedRedirectHosts,
        signal,
      )
      signal?.throwIfAborted()
      const archiveSha256 = createHash('sha256').update(archive).digest('hex')
      const archivePath = path.join(staging, 'role.tgz')
      await writePrivateFile(archivePath, archive)
      const extractionRoot = path.join(staging, 'extracted')
      await mkdir(extractionRoot, { mode: 0o700 })
      const topLevel = await inspectArchive(
        archivePath,
        selected.name,
        this.config.maxArchiveBytes,
      )
      await extractArchive(archivePath, extractionRoot, topLevel)
      signal?.throwIfAborted()

      const stagedRoleRoot = path.join(extractionRoot, topLevel)
      const stagedRole = await loadRole(stagedRoleRoot)
      await this.verifyLoadedRole(stagedRole, selected)
      await verifyBundleLock(stagedRoleRoot, stagedRole)
      const effective = this.authorizeRole(stagedRole, selected)
      signal?.throwIfAborted()

      const installedRoot = await this.storage.commitRoleRoot(
        stagedRoleRoot,
        stagedRole.bundleDigest,
      )
      const installedRole = await loadRole(installedRoot)
      await this.verifyLoadedRole(installedRole, selected)
      await verifyBundleLock(installedRoot, installedRole)

      const record: RoleDeploymentRecord = {
        schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
        hubId: selected.hubId,
        catalogUrl: this.requireSnapshot(selected.hubId).hub.catalogUrl,
        archiveUrl: selected.archiveUrl,
        archiveSha256,
        roleRoot: installedRoot,
        role: {
          id: installedRole.manifest.metadata.id,
          name: installedRole.manifest.metadata.name,
          displayName: installedRole.manifest.metadata.displayName,
          description: installedRole.manifest.metadata.description,
          publisher: installedRole.manifest.metadata.publisher,
          version: installedRole.manifest.metadata.version,
          tags: [...installedRole.manifest.metadata.tags],
          trust: selected.trust,
          manifestDigest: installedRole.manifestDigest,
          bundleDigest: installedRole.bundleDigest,
        },
        providerName: providerName(installedRole.bundleDigest),
        policy: effective.policy,
        bindings: effective.bindings,
        installedAt: this.now().toISOString(),
      }
      await this.storage.writeDeploymentRecord(record)
      const deployment = { record, role: installedRole }
      this.deployments.set(installedRole.bundleDigest, deployment)
      return deployment
    } finally {
      await this.storage.removeStaging(staging)
    }
  }

  /** Reload and fully revalidate every persisted role. Called during init and safe to repeat. */
  async loadDeployments(): Promise<LoadedRoleDeployment[]> {
    await this.storage.init()
    const records = await this.storage.listDeploymentRecords()
    const loaded = new Map<string, LoadedRoleDeployment>()
    for (const record of records) {
      const expectedRoot = this.storage.roleRoot(record.role.bundleDigest)
      if (record.roleRoot !== expectedRoot) {
        throw new Error('rolehub-bridge: deployment roleRoot escapes the managed role store')
      }
      assertCredentialFreeHttps(record.catalogUrl, 'deployment catalog URL')
      assertCredentialFreeHttps(record.archiveUrl, 'deployment archive URL')
      if (record.providerName !== providerName(record.role.bundleDigest)) {
        throw new Error('rolehub-bridge: deployment provider name does not match its bundle digest')
      }
      const role = await loadRole(expectedRoot)
      this.verifyDeploymentRecord(record, role)
      await verifyBundleLock(expectedRoot, role)
      this.authorizePersistedRole(record, role)
      if (loaded.has(role.bundleDigest)) {
        throw new Error(`rolehub-bridge: duplicate deployment ${role.bundleDigest}`)
      }
      loaded.set(role.bundleDigest, { record, role })
    }
    this.deployments = loaded
    return [...loaded.values()]
  }

  getDeployment(bundleDigestOrProviderName: string): LoadedRoleDeployment | undefined {
    const direct = this.deployments.get(bundleDigestOrProviderName)
    if (direct) return direct
    for (const deployment of this.deployments.values()) {
      if (deployment.record.providerName === bundleDigestOrProviderName) {
        return deployment
      }
    }
    return undefined
  }

  async writeSessionBinding(binding: RoleSessionBinding): Promise<void> {
    const requested = structuredClone(binding)
    const operation = this.sessionWriteQueue.then(async () => {
      this.assertReady()
      const deployment = this.deployments.get(requested.roleBundleDigest)
      if (!deployment || deployment.record.providerName !== requested.providerName) {
        throw new Error('rolehub-bridge: Session binding must reference a verified deployment')
      }
      const existing = this.sessionBindings.get(requested.sessionId)
      if (existing) assertSafeSessionTransition(existing, requested)
      await this.storage.writeSessionBinding(requested)
      this.sessionBindings.set(requested.sessionId, requested)
    })
    this.sessionWriteQueue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  listSessionBindings(): RoleSessionBinding[] {
    this.assertReady()
    return [...this.sessionBindings.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt, 'en'))
      .map(binding => structuredClone(binding))
  }

  private async refreshOneHub(
    hub: HubConfig,
    signal?: AbortSignal,
  ): Promise<HubCatalogSnapshot> {
    try {
      const bytes = await fetchBounded(
        hub.catalogUrl,
        this.config.maxCatalogBytes,
        this.config.fetchTimeoutMs,
        this.fetchImpl,
        hub.allowedRedirectHosts,
        signal,
      )
      const catalog = parseCatalogBytes(bytes, hub.id)
      const fetchedAt = this.now().toISOString()
      const receipt: CatalogCacheReceipt = {
        schemaVersion: CATALOG_CACHE_SCHEMA_VERSION,
        hub: structuredClone(hub),
        fetchedAt,
        catalog,
      }
      await this.storage.writeCatalogCache(hub.id, receipt)
      return makeSnapshot(hub, catalog, fetchedAt, 'network')
    } catch (error) {
      if (!(error instanceof HubUnavailableError) || signal?.aborted) throw error
      const cached = await this.storage.readCatalogCache(hub.id)
      if (cached === undefined) {
        throw new Error(
          `rolehub-bridge: Hub ${hub.id} is unavailable and has no validated catalog cache`,
          { cause: error },
        )
      }
      return parseCatalogCache(
        cached,
        hub,
        this.now(),
        this.config.maxCatalogCacheAgeMs,
      )
    }
  }

  private canonicalRole(selectorOrRole: string | HubRole): HubRole {
    if (typeof selectorOrRole === 'string') return this.resolveRole(selectorOrRole)
    const snapshot = this.requireSnapshot(selectorOrRole.hubId)
    const match = snapshot.roles.find(role =>
      role.id === selectorOrRole.id &&
      role.name === selectorOrRole.name &&
      role.version === selectorOrRole.version &&
      role.manifestDigest === selectorOrRole.manifestDigest &&
      role.bundleDigest === selectorOrRole.bundleDigest,
    )
    if (!match) throw new Error('rolehub-bridge: role object is not from a current validated Hub')
    return copyHubRole(match)
  }

  private requireSnapshot(hubId: string): HubCatalogSnapshot {
    const snapshot = this.snapshots.get(hubId)
    if (!snapshot) throw new Error(`rolehub-bridge: Hub ${hubId} is not initialized`)
    return snapshot
  }

  private verifyLoadedRole(role: LoadedRole, catalog: HubRole): void {
    const metadata = role.manifest.metadata
    if (
      metadata.id !== catalog.id ||
      metadata.name !== catalog.name ||
      metadata.displayName !== catalog.displayName ||
      metadata.description !== catalog.description ||
      metadata.publisher !== catalog.publisher ||
      metadata.version !== catalog.version ||
      metadata.license !== catalog.license ||
      !sameStrings(metadata.tags, catalog.tags) ||
      role.manifestDigest !== catalog.manifestDigest ||
      role.bundleDigest !== catalog.bundleDigest
    ) {
      throw new Error('rolehub-bridge: downloaded role does not match the catalog digests and identity')
    }
    for (const kind of ['required', 'optional', 'denied'] as const) {
      const manifestCapabilities = role.manifest.spec.capabilities[kind].map(item => item.id)
      if (!sameStrings(manifestCapabilities, catalog.capabilities[kind])) {
        throw new Error(`rolehub-bridge: catalog ${kind} capabilities do not match role.yaml`)
      }
    }
  }

  private authorizeRole(role: LoadedRole, catalog: HubRole) {
    const selectedHub = this.requireSnapshot(catalog.hubId).hub
    const trusted = selectedHub.trustedPublishers.includes(role.manifest.metadata.publisher)
    const effectiveTrust = trusted ? 'reference' : 'community'
    if (catalog.trust !== effectiveTrust) {
      throw new Error(
        `rolehub-bridge: catalog trust for ${catalog.id} conflicts with Host publisher trust`,
      )
    }
    if (!trusted && !this.config.allowCommunityRoles) {
      throw new Error(`rolehub-bridge: community publisher ${catalog.publisher} is not allowed`)
    }
    assertRoleRuntimeConstraints(role, this.config.allowedCapabilities)
    const effective = createEffectivePolicy(role, this.config.allowedCapabilities)
    // The compatibility layer is the final fail-closed check for DSH-specific
    // enforcement gaps (for example approval-required network access).
    const plan = dsharnessCompatibility.plan(role, {
      mode: 'strict',
      scope: 'session',
      policy: effective.policy,
      bindings: effective.bindings,
    })
    if (!plan.runnable) {
      throw new Error('rolehub-bridge: DSH compatibility refused this role deployment')
    }
    return effective
  }

  private verifyDeploymentRecord(record: RoleDeploymentRecord, role: LoadedRole): void {
    const metadata = role.manifest.metadata
    if (
      record.role.id !== metadata.id ||
      record.role.name !== metadata.name ||
      record.role.displayName !== metadata.displayName ||
      record.role.description !== metadata.description ||
      record.role.publisher !== metadata.publisher ||
      record.role.version !== metadata.version ||
      !sameStrings(record.role.tags, metadata.tags) ||
      record.role.manifestDigest !== role.manifestDigest ||
      record.role.bundleDigest !== role.bundleDigest
    ) {
      throw new Error('rolehub-bridge: persisted deployment no longer matches its role bundle')
    }
  }

  private authorizePersistedRole(record: RoleDeploymentRecord, role: LoadedRole): void {
    const configuredHub = this.config.hubs.find(hub => hub.id === record.hubId)
    if (!configuredHub) {
      throw new Error(`rolehub-bridge: deployment Hub ${record.hubId} is no longer configured`)
    }
    if (
      credentialFreeHttpsUrl(record.catalogUrl, 'deployment catalog URL').href !==
      credentialFreeHttpsUrl(configuredHub.catalogUrl, 'configured catalog URL').href
    ) {
      throw new Error('rolehub-bridge: deployment catalog URL differs from current Hub settings')
    }
    const expectedArchiveUrl = archiveUrl(configuredHub, record.role)
    if (record.archiveUrl !== expectedArchiveUrl) {
      throw new Error('rolehub-bridge: deployment archive URL differs from current Hub settings')
    }
    const trusted = configuredHub.trustedPublishers.includes(role.manifest.metadata.publisher)
    const effectiveTrust = trusted ? 'reference' : 'community'
    if (record.role.trust !== effectiveTrust || (!trusted && !this.config.allowCommunityRoles)) {
      throw new Error('rolehub-bridge: persisted deployment is no longer trusted by Host policy')
    }
    assertRoleRuntimeConstraints(role, this.config.allowedCapabilities)
    assertEffectivePolicy(role, record.policy, record.bindings)
    const expected = createEffectivePolicy(role, this.config.allowedCapabilities)
    if (
      expected.policy.policyDigest !== record.policy.policyDigest ||
      !isDeepStrictEqual(expected.bindings, record.bindings)
    ) {
      throw new Error('rolehub-bridge: persisted deployment differs from current Host policy')
    }
    const plan = dsharnessCompatibility.plan(role, {
      mode: 'strict',
      scope: 'session',
      policy: record.policy,
      bindings: record.bindings,
    })
    if (!plan.runnable) {
      throw new Error('rolehub-bridge: persisted role is no longer runnable through DSH')
    }
  }

  private assertDeploymentAgainstCatalog(
    deployment: LoadedRoleDeployment,
    catalog: HubRole,
  ): void {
    this.verifyLoadedRole(deployment.role, catalog)
    if (
      deployment.record.hubId !== catalog.hubId ||
      deployment.record.archiveUrl !== catalog.archiveUrl ||
      deployment.record.role.trust !== catalog.trust
    ) {
      throw new Error('rolehub-bridge: installed deployment does not match the selected catalog role')
    }
    this.authorizePersistedRole(deployment.record, deployment.role)
  }

  private assertReady(): void {
    if (!this.initialized && this.snapshots.size === 0) {
      throw new Error('rolehub-bridge: resolver is not initialized')
    }
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation)
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

class HubUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HubUnavailableError'
  }
}

async function fetchBounded(
  input: string,
  maximumBytes: number,
  timeoutMs: number,
  fetchImpl: typeof globalThis.fetch,
  allowedRedirectHosts: readonly string[],
  callerSignal?: AbortSignal,
): Promise<Buffer> {
  let url = credentialFreeHttpsUrl(input, 'download URL')
  const allowedHosts = new Set([url.hostname, ...allowedRedirectHosts])
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('rolehub-bridge: download timed out'))
  }, timeoutMs)
  const abortFromCaller = () => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted) abortFromCaller()
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    for (let redirects = 0; ; redirects += 1) {
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { accept: 'application/json, application/gzip, application/octet-stream' },
        })
      } catch (error) {
        if (callerSignal?.aborted) throw callerSignal.reason ?? error
        throw new HubUnavailableError(
          timedOut
            ? `rolehub-bridge: download timed out after ${timeoutMs}ms`
            : `rolehub-bridge: Hub request failed for ${url.hostname}`,
          { cause: error },
        )
      }
      if (response.url) {
        assertAllowedDownloadTarget(
          credentialFreeHttpsUrl(response.url, 'redirect response URL'),
          allowedHosts,
          'redirect response URL',
        )
      }
      if (isRedirect(response.status)) {
        await response.body?.cancel().catch(() => undefined)
        if (redirects >= MAX_REDIRECTS) {
          throw new Error('rolehub-bridge: download exceeded the redirect limit')
        }
        const location = response.headers.get('location')
        if (!location) throw new Error('rolehub-bridge: redirect response omitted Location')
        url = credentialFreeHttpsUrl(new URL(location, url).href, 'redirect target')
        assertAllowedDownloadTarget(url, allowedHosts, 'redirect target')
        continue
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          throw new HubUnavailableError(
            `rolehub-bridge: Hub returned temporary HTTP ${response.status}`,
          )
        }
        throw new Error(`rolehub-bridge: Hub returned HTTP ${response.status}`)
      }

      const finalUrl = response.url || url.href
      assertAllowedDownloadTarget(
        credentialFreeHttpsUrl(finalUrl, 'final response URL'),
        allowedHosts,
        'final response URL',
      )
      const declared = response.headers.get('content-length')
      if (declared !== null) {
        if (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes) {
          await response.body?.cancel().catch(() => undefined)
          throw new Error(`rolehub-bridge: download exceeds ${maximumBytes} bytes`)
        }
      }
      if (!response.body) throw new Error('rolehub-bridge: Hub response has no body')
      const chunks: Buffer[] = []
      let total = 0
      const reader = response.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > maximumBytes) {
            controller.abort(new Error('rolehub-bridge: bounded download exceeded'))
            throw new Error(`rolehub-bridge: download exceeds ${maximumBytes} bytes`)
          }
          chunks.push(Buffer.from(value))
        }
      } catch (error) {
        if (callerSignal?.aborted) throw callerSignal.reason ?? error
        if (timedOut) {
          throw new HubUnavailableError(
            `rolehub-bridge: download timed out after ${timeoutMs}ms`,
            { cause: error },
          )
        }
        if (
          error instanceof Error &&
          error.message.startsWith('rolehub-bridge: download exceeds')
        ) {
          throw error
        }
        throw new HubUnavailableError('rolehub-bridge: Hub response body was interrupted', {
          cause: error,
        })
      } finally {
        reader.releaseLock()
      }
      return Buffer.concat(chunks, total)
    }
  } finally {
    clearTimeout(timeout)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
}

function parseCatalogBytes(bytes: Buffer, hubId: string): RoleCatalog {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`rolehub-bridge: Hub ${hubId} catalog is not valid UTF-8`)
  }
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new Error(`rolehub-bridge: Hub ${hubId} catalog is not valid JSON`)
  }
  return parseCatalog(value, hubId)
}

function parseCatalog(value: unknown, hubId: string): RoleCatalog {
  const root = object(value, `Hub ${hubId} catalog`)
  exactKeys(root, ['apiVersion', 'generatedBy', 'roles'], `Hub ${hubId} catalog`)
  if (root['apiVersion'] !== CATALOG_API_VERSION) {
    throw new Error(`rolehub-bridge: Hub ${hubId} must serve ${CATALOG_API_VERSION}`)
  }
  boundedString(root['generatedBy'], `Hub ${hubId} generatedBy`, 200)
  if (!Array.isArray(root['roles']) || root['roles'].length > 10_000) {
    invalid(`Hub ${hubId} roles`)
  }
  const roles = root['roles'].map((role, index) => parseCatalogRole(role, hubId, index))
  const names = new Set<string>()
  const identities = new Set<string>()
  for (const role of roles) {
    if (names.has(role.name)) {
      throw new Error(`rolehub-bridge: Hub ${hubId} has ambiguous role name ${role.name}`)
    }
    if (identities.has(role.id)) {
      throw new Error(`rolehub-bridge: Hub ${hubId} has ambiguous role id ${role.id}`)
    }
    names.add(role.name)
    identities.add(role.id)
  }
  return {
    apiVersion: CATALOG_API_VERSION,
    generatedBy: root['generatedBy'] as string,
    roles,
  }
}

function parseCatalogRole(value: unknown, hubId: string, index: number): CatalogRole {
  const label = `Hub ${hubId} role ${index + 1}`
  const role = object(value, label)
  exactKeys(
    role,
    [
      'id',
      'name',
      'displayName',
      'description',
      'publisher',
      'version',
      'license',
      'tags',
      'trust',
      'portability',
      'path',
      'url',
      'manifestDigest',
      'bundleDigest',
      'capabilities',
    ],
    label,
  )
  const name = patternString(role['name'], `${label}.name`, PORTABLE_NAME, 64)
  const publisher = patternString(role['publisher'], `${label}.publisher`, PUBLISHER, 96)
  const id = boundedString(role['id'], `${label}.id`, 160)
  if (id !== `${publisher}/${name}`) invalid(`${label}.id`)
  const version = patternString(role['version'], `${label}.version`, SEMVER, 128)
  const displayName = boundedString(role['displayName'], `${label}.displayName`, 80)
  const description = boundedString(role['description'], `${label}.description`, 240)
  const license = boundedString(role['license'], `${label}.license`, 64)
  const tags = stringArray(role['tags'], `${label}.tags`, 12)
  if (tags.length === 0 || tags.some(tag => !PORTABLE_NAME.test(tag) || tag.length > 64)) {
    invalid(`${label}.tags`)
  }
  if (role['trust'] !== 'reference' && role['trust'] !== 'community') invalid(`${label}.trust`)
  if (role['portability'] !== 'universal') invalid(`${label}.portability`)
  const rolePath = portablePath(role['path'], `${label}.path`)
  const sourceUrl = assertCredentialFreeHttps(role['url'], `${label}.url`)
  const manifestDigest = digest(role['manifestDigest'], `${label}.manifestDigest`)
  const bundleDigest = digest(role['bundleDigest'], `${label}.bundleDigest`)
  const capabilities = object(role['capabilities'], `${label}.capabilities`)
  exactKeys(capabilities, ['required', 'optional', 'denied'], `${label}.capabilities`)
  const required = capabilityArray(capabilities['required'], `${label}.capabilities.required`)
  const optional = capabilityArray(capabilities['optional'], `${label}.capabilities.optional`)
  const denied = capabilityArray(capabilities['denied'], `${label}.capabilities.denied`)
  const all = [...required, ...optional, ...denied]
  if (new Set(all).size !== all.length) invalid(`${label}.capabilities overlap`)
  return {
    id,
    name,
    displayName,
    description,
    publisher,
    version,
    license,
    tags,
    trust: role['trust'],
    portability: 'universal',
    path: rolePath,
    url: sourceUrl,
    manifestDigest,
    bundleDigest,
    capabilities: { required, optional, denied },
  }
}

function makeSnapshot(
  hub: HubConfig,
  catalog: RoleCatalog,
  fetchedAt: string,
  source: 'network' | 'cache',
): HubCatalogSnapshot {
  return {
    hub: structuredClone(hub),
    catalog: structuredClone(catalog),
    roles: catalog.roles.map(role => ({
      ...structuredClone(role),
      hubId: hub.id,
      archiveUrl: archiveUrl(hub, role),
    })),
    source,
    fetchedAt,
  }
}

function parseCatalogCache(
  value: unknown,
  configuredHub: HubConfig,
  now: Date,
  maximumAgeMs: number,
): HubCatalogSnapshot {
  const receipt = object(value, `Hub ${configuredHub.id} catalog cache`)
  exactKeys(
    receipt,
    ['schemaVersion', 'hub', 'fetchedAt', 'catalog'],
    `Hub ${configuredHub.id} catalog cache`,
  )
  if (receipt['schemaVersion'] !== CATALOG_CACHE_SCHEMA_VERSION) invalid('catalog cache version')
  const hub = parseCachedHub(receipt['hub'])
  if (!isDeepStrictEqual(hub, configuredHub)) {
    throw new Error(`rolehub-bridge: Hub ${configuredHub.id} cache belongs to different settings`)
  }
  const fetchedAt = isoDate(receipt['fetchedAt'], 'catalog cache fetchedAt')
  const nowMs = now.valueOf()
  const fetchedAtMs = new Date(fetchedAt).valueOf()
  if (!Number.isFinite(nowMs)) invalid('current time')
  const age = nowMs - fetchedAtMs
  if (age < 0) {
    throw new Error(`rolehub-bridge: Hub ${configuredHub.id} catalog cache is from the future`)
  }
  if (age > maximumAgeMs) {
    throw new Error(`rolehub-bridge: Hub ${configuredHub.id} catalog cache has expired`)
  }
  const catalog = parseCatalog(receipt['catalog'], configuredHub.id)
  return makeSnapshot(configuredHub, catalog, fetchedAt, 'cache')
}

function parseCachedHub(value: unknown): HubConfig {
  const hub = object(value, 'cached Hub')
  exactKeys(
    hub,
    [
      'id',
      'catalogUrl',
      'archiveUrlTemplate',
      'trustedPublishers',
      'allowedRedirectHosts',
    ],
    'cached Hub',
  )
  const id = patternString(hub['id'], 'cached Hub id', PORTABLE_NAME, 64)
  const catalogUrl = boundedString(hub['catalogUrl'], 'cached Hub catalogUrl', 8_192)
  assertCredentialFreeHttps(catalogUrl, 'cached Hub catalogUrl')
  const archiveUrlTemplate = boundedString(
    hub['archiveUrlTemplate'],
    'cached Hub archiveUrlTemplate',
    4_096,
  )
  assertCredentialFreeHttps(
    archiveUrlTemplate.replaceAll('{name}', 'role').replaceAll('{version}', '1.0.0'),
    'cached Hub archiveUrlTemplate',
  )
  if (!archiveUrlTemplate.includes('{name}') || !archiveUrlTemplate.includes('{version}')) {
    invalid('cached Hub archiveUrlTemplate placeholders')
  }
  const trustedPublishers = stringArray(hub['trustedPublishers'], 'cached Hub trustedPublishers', 128)
  if (trustedPublishers.some(publisher => !PUBLISHER.test(publisher) || publisher.length > 96)) {
    invalid('cached Hub trustedPublishers')
  }
  const allowedRedirectHosts = stringArray(
    hub['allowedRedirectHosts'],
    'cached Hub allowedRedirectHosts',
    128,
  )
  if (allowedRedirectHosts.some(hostname => !isSafeDnsHostname(hostname))) {
    invalid('cached Hub allowedRedirectHosts')
  }
  return { id, catalogUrl, archiveUrlTemplate, trustedPublishers, allowedRedirectHosts }
}

function archiveUrl(hub: HubConfig, role: Pick<CatalogRole, 'name' | 'version'>): string {
  const value = hub.archiveUrlTemplate
    .replaceAll('{name}', encodeURIComponent(role.name))
    .replaceAll('{version}', encodeURIComponent(role.version))
  return assertCredentialFreeHttps(value, `Hub ${hub.id} archive URL`)
}

async function inspectArchive(
  archivePath: string,
  expectedTopLevel: string,
  compressedLimit: number,
): Promise<string> {
  const entries: ArchiveEntry[] = []
  const names = new Map<string, string>()
  let expandedBytes = 0
  const expandedLimit = Math.min(
    MAX_EXPANDED_ARCHIVE_BYTES,
    Math.max(16 * 1024 * 1024, compressedLimit * 4),
  )
  let validationError: Error | undefined
  await tar.list({
    file: archivePath,
    strict: true,
    preservePaths: false,
    maxDepth: 16,
    maxDecompressionRatio: 10,
    onReadEntry(entry) {
      if (validationError) {
        entry.resume()
        return
      }
      try {
        if (entries.length >= MAX_ARCHIVE_ENTRIES) {
          throw new Error(`rolehub-bridge: role archive exceeds ${MAX_ARCHIVE_ENTRIES} entries`)
        }
        const entryPath = safeArchivePath(entry.path)
        if (entry.type !== 'File' && entry.type !== 'Directory') {
          throw new Error(`rolehub-bridge: unsafe tar entry type ${entry.type}: ${entryPath}`)
        }
        const parts = entryPath.split('/')
        if (parts[0] !== expectedTopLevel) {
          throw new Error(
            'rolehub-bridge: role archive must contain one name-matching top-level directory',
          )
        }
        if (entry.type === 'File' && parts.length < 2) {
          throw new Error('rolehub-bridge: role archive cannot contain a top-level file')
        }
        const folded = entryPath.toLowerCase()
        const collision = names.get(folded)
        if (collision !== undefined) {
          throw new Error(
            `rolehub-bridge: duplicate or case-colliding tar paths: ${collision}, ${entryPath}`,
          )
        }
        names.set(folded, entryPath)
        if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
          throw new Error(`rolehub-bridge: invalid tar entry size: ${entryPath}`)
        }
        expandedBytes += entry.size
        if (expandedBytes > expandedLimit) {
          throw new Error(`rolehub-bridge: expanded role archive exceeds ${expandedLimit} bytes`)
        }
        entries.push({ path: entryPath, type: entry.type, size: entry.size })
      } catch (error) {
        validationError = asError(error)
        entry.resume()
      }
    },
  })
  if (validationError) throw validationError
  const files = new Set(entries.filter(entry => entry.type === 'File').map(entry => entry.path))
  if (!files.has(`${expectedTopLevel}/role.yaml`) || !files.has(`${expectedTopLevel}/bundle.lock.json`)) {
    throw new Error('rolehub-bridge: role archive requires role.yaml and bundle.lock.json')
  }
  for (const file of files) {
    const parts = file.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = parts.slice(0, index).join('/')
      if (files.has(ancestor)) {
        throw new Error(`rolehub-bridge: tar file/directory collision at ${ancestor}`)
      }
    }
  }
  return expectedTopLevel
}

async function extractArchive(
  archivePath: string,
  destination: string,
  topLevel: string,
): Promise<void> {
  let validationError: Error | undefined
  await tar.extract({
    file: archivePath,
    cwd: destination,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    noMtime: true,
    maxDepth: 16,
    maxDecompressionRatio: 10,
    filter(entryPath, entry) {
      let safe: string
      try {
        safe = safeArchivePath(entryPath)
      } catch (error) {
        validationError ??= asError(error)
        return false
      }
      if (!safe.startsWith(`${topLevel}/`) && safe !== topLevel) return false
      const entryType = 'type' in entry ? entry.type : undefined
      if (entryType !== 'File' && entryType !== 'Directory') {
        validationError ??= new Error(
          `rolehub-bridge: unsafe tar entry type ${String(entryType)}: ${safe}`,
        )
        return false
      }
      return true
    },
  })
  if (validationError) throw validationError
  const root = await lstat(path.join(destination, topLevel))
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error('rolehub-bridge: extracted role root is not a real directory')
  }
}

async function verifyBundleLock(roleRoot: string, role: LoadedRole): Promise<void> {
  const lockPath = path.join(roleRoot, 'bundle.lock.json')
  const stat = await lstat(lockPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) {
    throw new Error('rolehub-bridge: unsafe bundle.lock.json')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(lockPath, 'utf8')) as unknown
  } catch {
    throw new Error('rolehub-bridge: invalid bundle.lock.json')
  }
  const expected = await buildBundleLock(role)
  if (!isDeepStrictEqual(parsed, expected)) {
    throw new Error('rolehub-bridge: bundle.lock.json does not match the verified role files')
  }
}

function assertRoleRuntimeConstraints(
  role: LoadedRole,
  allowedCapabilities: readonly CapabilityId[],
): void {
  if (role.manifest.spec.isolation.scope === 'process') {
    throw new Error('rolehub-bridge: process-isolated roles are unsupported by this runtime')
  }
  if (role.manifest.spec.secrets.some(secret => secret.required)) {
    throw new Error('rolehub-bridge: roles with required secrets are unsupported')
  }
  const allowed = new Set(allowedCapabilities)
  const unsupported = role.manifest.spec.capabilities.required
    .map(request => request.id)
    .filter(capability => !HOST_SUPPORTED_CAPABILITIES.has(capability) || !allowed.has(capability))
  if (unsupported.length) {
    throw new Error(
      `rolehub-bridge: unsupported required capabilities: ${unsupported.join(', ')}`,
    )
  }
}

function assertSafeSessionTransition(
  previous: RoleSessionBinding,
  next: RoleSessionBinding,
): void {
  const sameIdentity =
    previous.schemaVersion === next.schemaVersion &&
    previous.sessionId === next.sessionId &&
    previous.parentSessionId === next.parentSessionId &&
    previous.roleBundleDigest === next.roleBundleDigest &&
    previous.providerName === next.providerName &&
    previous.roomId === next.roomId &&
    previous.roomMemberId === next.roomMemberId &&
    previous.createdAt === next.createdAt
  if (!sameIdentity) {
    throw new Error('rolehub-bridge: Session binding identity is immutable')
  }
  const allowed: Record<RoleSessionBinding['state'], RoleSessionBinding['state'][]> = {
    active: ['active', 'orphaned', 'revoked'],
    orphaned: ['orphaned', 'revoked'],
    revoked: ['revoked'],
  }
  if (!allowed[previous.state].includes(next.state)) {
    throw new Error(`rolehub-bridge: unsafe Session transition ${previous.state} -> ${next.state}`)
  }
}

function safeArchivePath(input: string): string {
  if (
    !input ||
    input.includes('\0') ||
    input.includes('\\') ||
    input.startsWith('/') ||
    /^[A-Za-z]:/u.test(input)
  ) {
    throw new Error(`rolehub-bridge: unsafe tar path ${JSON.stringify(input)}`)
  }
  const value = input.replace(/\/+$/u, '')
  const parts = value.split('/')
  if (!value || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`rolehub-bridge: unsafe tar path ${JSON.stringify(input)}`)
  }
  if (path.posix.normalize(value) !== value) {
    throw new Error(`rolehub-bridge: non-normalized tar path ${JSON.stringify(input)}`)
  }
  return value
}

function credentialFreeHttpsUrl(value: string, label: string): URL {
  if (typeof value !== 'string' || value.length > 8_192) invalid(label)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    invalid(label)
  }
  const hostname = stripIpv6Brackets(parsed.hostname)
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    isIP(hostname) !== 0 ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost')
  ) {
    invalid(label)
  }
  return parsed
}

function assertAllowedDownloadTarget(
  target: URL,
  allowedHosts: ReadonlySet<string>,
  label: string,
): void {
  if (!allowedHosts.has(target.hostname)) {
    throw new Error(`rolehub-bridge: ${label} host ${target.hostname} is not allowed`)
  }
}

function isSafeDnsHostname(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 253 ||
    value !== value.toLowerCase() ||
    isIP(value) !== 0 ||
    value === 'localhost' ||
    value.endsWith('.localhost')
  ) {
    return false
  }
  return value.split('.').every(label => (
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  ))
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

function assertCredentialFreeHttps(value: unknown, label: string): string {
  if (typeof value !== 'string') invalid(label)
  return credentialFreeHttpsUrl(value, label).href
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(label)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  const missing = keys.filter(key => !(key in value))
  if (unknown.length || missing.length) {
    throw new Error(
      `rolehub-bridge: invalid ${label} shape` +
        `${unknown.length ? `; unknown: ${unknown.join(', ')}` : ''}` +
        `${missing.length ? `; missing: ${missing.join(', ')}` : ''}`,
    )
  }
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    invalid(label)
  }
  return value
}

function patternString(
  value: unknown,
  label: string,
  pattern: RegExp,
  maximum: number,
): string {
  const result = boundedString(value, label, maximum)
  if (!pattern.test(result)) invalid(label)
  return result
}

function stringArray(value: unknown, label: string, maximum: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    !value.every(entry => typeof entry === 'string') ||
    new Set(value).size !== value.length
  ) {
    invalid(label)
  }
  return value as string[]
}

function capabilityArray(value: unknown, label: string): CapabilityId[] {
  const entries = stringArray(value, label, 32)
  if (entries.some(entry => !CAPABILITY_IDS.includes(entry as CapabilityId))) invalid(label)
  return entries as CapabilityId[]
}

function portablePath(value: unknown, label: string): string {
  const result = boundedString(value, label, 240)
  if (
    result === '.' ||
    result.startsWith('/') ||
    result.includes('\\') ||
    path.posix.normalize(result) !== result ||
    result === '..' ||
    result.startsWith('../')
  ) {
    invalid(label)
  }
  return result
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(label)
  return value
}

function isoDate(value: unknown, label: string): string {
  const result = boundedString(value, label, 64)
  const parsed = new Date(result)
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== result) invalid(label)
  return result
}

function providerName(bundleDigest: string): string {
  if (!SHA256.test(bundleDigest)) invalid('provider bundle digest')
  return `${ROLEHUB_PROVIDER_PREFIX}${bundleDigest}`
}

function copySnapshot(snapshot: HubCatalogSnapshot): HubCatalogSnapshot {
  return structuredClone(snapshot)
}

function copyHubRole(role: HubRole): HubRole {
  return structuredClone(role)
}

function copyCapabilities(capabilities: CatalogRole['capabilities']): CatalogRole['capabilities'] {
  return {
    required: [...capabilities.required],
    optional: [...capabilities.optional],
    denied: [...capabilities.denied],
  }
}

function compareHubRoles(left: HubRole, right: HubRole): number {
  return left.hubId.localeCompare(right.hubId, 'en') || left.name.localeCompare(right.name, 'en')
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function ambiguousSelector(selector: string): never {
  throw new Error(
    `rolehub-bridge: ambiguous role selector "${selector}"; use an explicit hub/name selector`,
  )
}

function invalid(label: string): never {
  throw new Error(`rolehub-bridge: invalid ${label}`)
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

async function writePrivateFile(destination: string, content: Buffer): Promise<void> {
  const handle = await open(
    destination,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  )
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
}
