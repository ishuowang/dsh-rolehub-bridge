/** Public role metadata exposed to the native browser client. */
export interface NativeRoleView {
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

export interface NativeRoomView {
  id: string
  name: string
  status?: string
}

/** Browser-safe projection returned by the same-origin native read API. */
export interface NativeBridgeSnapshot {
  hubs: Array<{ id: string }>
  roles: NativeRoleView[]
  rooms: NativeRoomView[]
  roomAvailable: boolean
}
