import type {
  CapabilityId,
  CatalogRole,
  LoadedRole,
  RoleCatalog,
} from '@ishuowang/rolehub-core'
import type { LoadedEffectivePolicy } from '@ishuowang/rolehub-compat-sdk'

import type { HubConfig } from './config.js'

export const DEPLOYMENT_SCHEMA_VERSION = 1
export const SESSION_BINDING_SCHEMA_VERSION = 1
export const ROLEHUB_PROVIDER_PREFIX = 'rolehub-bridge-'

export interface HubRole extends CatalogRole {
  hubId: string
  archiveUrl: string
}

export interface HubCatalogSnapshot {
  hub: HubConfig
  catalog: RoleCatalog
  roles: HubRole[]
  /** Whether this process fetched the catalog or recovered the last validated snapshot. */
  source: 'network' | 'cache'
  /** Time of the successful network fetch; cache fallback never rewrites it. */
  fetchedAt: string
}

/** Durable, prompt-free installation receipt. Role content remains inside `roleRoot`. */
export interface RoleDeploymentRecord {
  schemaVersion: typeof DEPLOYMENT_SCHEMA_VERSION
  hubId: string
  catalogUrl: string
  archiveUrl: string
  archiveSha256: string
  roleRoot: string
  role: {
    id: string
    name: string
    displayName: string
    description: string
    publisher: string
    version: string
    tags: string[]
    trust: 'reference' | 'community'
    manifestDigest: string
    bundleDigest: string
  }
  providerName: string
  policy: LoadedEffectivePolicy
  bindings: Record<string, string[]>
  installedAt: string
}

export interface LoadedRoleDeployment {
  record: RoleDeploymentRecord
  role: LoadedRole
}

/** Durable audit join; no prompts, transcripts, secrets, or Room messages. */
export interface RoleSessionBinding {
  schemaVersion: typeof SESSION_BINDING_SCHEMA_VERSION
  sessionId: string
  parentSessionId: string
  roleBundleDigest: string
  providerName: string
  roomId?: string
  roomMemberId?: string
  state: 'active' | 'orphaned' | 'revoked'
  createdAt: string
}

export interface RoleView {
  hubId: string
  id: string
  name: string
  displayName: string
  description: string
  publisher: string
  version: string
  license: string
  tags: string[]
  trust: 'reference' | 'community'
  manifestDigest: string
  bundleDigest: string
  capabilities: {
    required: string[]
    optional: string[]
    denied: string[]
  }
  installed: boolean
}

export interface RoomView {
  id: string
  name: string
  status?: string
}

export interface StartRoleInput {
  selector: string
  prompt?: string
  label?: string
  roomId?: string
}

export interface StartRoleResult {
  childId: string
  messageId: string
  role: RoleView
  policyDigest: string
  room?: {
    id: string
    memberId: string
  }
}

export interface BridgeSnapshot {
  hubs: Array<{ id: string; catalogUrl: string }>
  roles: RoleView[]
  rooms: RoomView[]
  roomAvailable: boolean
}

export const HOST_TOOL_BINDINGS: Readonly<Partial<Record<CapabilityId, readonly string[]>>> = {
  'filesystem.read': ['glob', 'grep', 'read', 'read_image'],
  'filesystem.write': ['edit', 'write'],
  'network.fetch': ['web_fetch'],
  'web.search': ['web_search'],
  'source-control.read': ['rolehub_git_read'],
  'room.message': [],
}
