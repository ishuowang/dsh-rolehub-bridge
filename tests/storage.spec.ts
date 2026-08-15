import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { RoleHubStorage, parseDeploymentRecord, parseSessionBinding } from '../src/storage.js'
import {
  DEPLOYMENT_SCHEMA_VERSION,
  SESSION_BINDING_SCHEMA_VERSION,
  type RoleDeploymentRecord,
  type RoleSessionBinding,
} from '../src/types.js'

const roots: string[] = []
const BUNDLE_DIGEST = 'b'.repeat(64)
const MANIFEST_DIGEST = 'a'.repeat(64)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function storage(): Promise<RoleHubStorage> {
  const root = await mkdtemp(path.join(tmpdir(), 'rolehub-storage-test-'))
  roots.push(root)
  const result = new RoleHubStorage(root)
  await result.init()
  return result
}

function deployment(roleRoot = '/private/roles/reviewer'): RoleDeploymentRecord {
  return {
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    hubId: 'official',
    catalogUrl: 'https://roles.example/catalog.json',
    archiveUrl: 'https://roles.example/reviewer-1.0.0.role.tgz',
    archiveSha256: 'c'.repeat(64),
    roleRoot,
    role: {
      id: 'io.github.ishuowang/reviewer',
      name: 'reviewer',
      displayName: 'Reviewer',
      description: 'Reviews a bounded set of repository changes.',
      publisher: 'io.github.ishuowang',
      version: '1.0.0',
      tags: ['review'],
      trust: 'reference',
      manifestDigest: MANIFEST_DIGEST,
      bundleDigest: BUNDLE_DIGEST,
    },
    providerName: `rolehub-bridge-${BUNDLE_DIGEST}`,
    policy: {
      apiVersion: 'rolehub.dev/policy/v1alpha1',
      kind: 'EffectiveRolePolicy',
      role: { id: 'io.github.ishuowang/reviewer', bundleDigest: BUNDLE_DIGEST },
      compatibility: 'dsharness',
      grants: ['filesystem.read', 'room.message'],
      enforcement: {
        filesystem: 'tool-policy',
        network: 'none',
        approvals: 'none',
        room: 'broker',
        process: 'shared',
        configuration: 'isolated',
      },
      policyDigest: 'd'.repeat(64),
    },
    bindings: {
      'filesystem.read': ['glob', 'grep', 'read', 'read_image'],
      'room.message': [],
    },
    installedAt: '2026-08-15T00:00:00.000Z',
  }
}

function binding(state: RoleSessionBinding['state'] = 'active'): RoleSessionBinding {
  return {
    schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
    sessionId: 'child/session:1',
    parentSessionId: 'parent-1',
    roleBundleDigest: BUNDLE_DIGEST,
    providerName: `rolehub-bridge-${BUNDLE_DIGEST}`,
    roomId: 'room-1',
    roomMemberId: 'member-1',
    state,
    createdAt: '2026-08-15T00:00:00.000Z',
  }
}

describe('RoleHubStorage', () => {
  it('writes deployment and Session receipts atomically with private permissions', async () => {
    const store = await storage()
    const record = deployment(store.roleRoot(BUNDLE_DIGEST))
    await store.writeDeploymentRecord(record)
    await store.writeSessionBinding(binding())

    const deploymentPath = path.join(store.deploymentsDir, `${BUNDLE_DIGEST}.json`)
    const sessionName = createHash('sha256').update('child/session:1').digest('hex')
    const sessionPath = path.join(store.sessionsDir, `${sessionName}.json`)
    expect((await lstat(deploymentPath)).mode & 0o777).toBe(0o600)
    expect((await lstat(sessionPath)).mode & 0o777).toBe(0o600)
    expect(
      (await lstat(path.join(store.rootDir, '.dsh-rolehub-bridge-storage.json'))).mode & 0o777,
    ).toBe(0o600)
    expect((await lstat(store.deploymentsDir)).mode & 0o777).toBe(0o700)
    expect((await readdir(store.deploymentsDir)).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(await store.listDeploymentRecords()).toEqual([record])
    expect(await store.listSessionBindings()).toEqual([binding()])
  })

  it('rejects permissive or symlinked receipts instead of silently accepting them', async () => {
    const store = await storage()
    const record = deployment(store.roleRoot(BUNDLE_DIGEST))
    await store.writeDeploymentRecord(record)
    const deploymentPath = path.join(store.deploymentsDir, `${BUNDLE_DIGEST}.json`)
    await chmod(deploymentPath, 0o644)
    await expect(store.listDeploymentRecords()).rejects.toThrow('permissions must be 0600')

    const other = await storage()
    await symlink('/etc/passwd', path.join(other.sessionsDir, 'unsafe.json'))
    await expect(other.listSessionBindings()).rejects.toThrow('must be a regular file')
  })

  it('strictly rejects unknown fields, invalid dates, and invalid capability bindings', () => {
    expect(() => parseDeploymentRecord({ ...deployment(), surprise: true })).toThrow(
      'unknown: surprise',
    )
    expect(() => parseDeploymentRecord({
      ...deployment(),
      bindings: { 'filesystem.read': ['../../tool'] },
    })).toThrow('binding filesystem.read')
    expect(() => parseSessionBinding({ ...binding(), createdAt: 'tomorrow' })).toThrow(
      'createdAt',
    )
  })

  it('requires receipt filenames to be derived from immutable identities', async () => {
    const store = await storage()
    const record = deployment(store.roleRoot(BUNDLE_DIGEST))
    await store.writeDeploymentRecord(record)
    const original = path.join(store.deploymentsDir, `${BUNDLE_DIGEST}.json`)
    const renamed = path.join(store.deploymentsDir, `${'e'.repeat(64)}.json`)
    const { rename } = await import('node:fs/promises')
    await rename(original, renamed)
    await expect(store.listDeploymentRecords()).rejects.toThrow('filename does not match')
  })

  it('rejects dangerous roots before changing them', async () => {
    for (const dangerous of ['/', homedir(), tmpdir(), process.cwd()]) {
      await expect(new RoleHubStorage(dangerous).init()).rejects.toThrow(
        'refusing dangerous storage root',
      )
    }

    const dshHome = await mkdtemp(path.join(tmpdir(), 'rolehub-dangerous-dsh-home-'))
    roots.push(dshHome)
    const previous = process.env['DSH_HOME']
    process.env['DSH_HOME'] = dshHome
    try {
      await expect(new RoleHubStorage(dshHome).init()).rejects.toThrow(
        'refusing dangerous storage root',
      )
    } finally {
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }
  })

  it('does not chmod or claim an existing shared/non-empty directory', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'rolehub-shared-parent-'))
    roots.push(parent)
    const shared = path.join(parent, 'shared')
    await mkdir(shared, { mode: 0o755 })
    await chmod(shared, 0o755)
    await expect(new RoleHubStorage(shared).init()).rejects.toThrow(
      'permissions must be 0700',
    )
    expect((await lstat(shared)).mode & 0o777).toBe(0o755)

    const occupied = path.join(parent, 'occupied')
    await mkdir(occupied, { mode: 0o700 })
    await writeFile(path.join(occupied, 'user-data.txt'), 'do not claim this directory')
    await expect(new RoleHubStorage(occupied).init()).rejects.toThrow(
      'refusing non-empty unclaimed storage directory',
    )
    expect(await readdir(occupied)).toEqual(['user-data.txt'])
  })

  it('bounds receipt reads before parsing JSON', async () => {
    const store = await storage()
    const oversized = path.join(store.deploymentsDir, `${BUNDLE_DIGEST}.json`)
    await writeFile(oversized, ' '.repeat(1024 * 1024 + 1), { mode: 0o600 })
    await expect(store.listDeploymentRecords()).rejects.toThrow('receipt exceeds 1048576 bytes')
  })
})
