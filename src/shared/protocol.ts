export type PlainValue = {
  kind: 'plain'
  value: string
}

export type EncryptedValue = {
  kind: 'encrypted'
}

export type EnvEntry =
  | { type: 'pair'; key: string; value: PlainValue | EncryptedValue }
  | { type: 'comment'; text: string }
  | { type: 'blank' }

export type EditableEntry =
  | {
      type: 'pair'
      key: string
      value: string
      encrypt: boolean
      sourceIndex?: number
      preserveEncrypted?: boolean
      preservePlainRaw?: boolean
    }
  | { type: 'comment'; text: string }
  | { type: 'blank' }

export type GetEnvResponse = {
  entries: EnvEntry[]
}

export type SaveEnvRequest = {
  entries: EditableEntry[]
}

export type SaveEnvResponse = {
  ok: true
}

export type ShareSnapshotEntry =
  | { type: 'pair'; key: string; value: string; encrypt: boolean }
  | { type: 'comment'; text: string }
  | { type: 'blank' }

export type ShareSnapshotResponse = {
  entries: ShareSnapshotEntry[]
}

export type DecryptEnvValueRequest = {
  sourceIndex: number
  key: string
}

export type DecryptEnvValueResponse = {
  value: string
}

export type HealthResponse = {
  ok: true
}

export type RegisterRequestResponse = {
  challenge: string
  rpId: string
  user: {
    id: string
    name: string
  }
  prfSalt: string
}

export type RegisterResponseRequest = {
  id: string
  publicKeySpki: string
  clientDataJSON: string
  attestationObject: string
  prfOutput: string
}

export type RegisterResponse = {
  ok: true
}

export type UnlockRequestResponse = {
  challenge: string
  credentialId: string
  rpId: string
  timeoutMs: number
  prfSalt: string
}

export type UnlockResponseRequest = {
  id: string
  clientDataJSON: string
  authenticatorData: string
  signature: string
  userHandle?: string
  prfOutput: string
}

export type UnlockResponse = {
  ok: true
}

export type RunContextResponse = {
  command: string
  envFilePath: string
  encryptedEntryCount: number
  requiresUnlock: boolean
}

export type RunApproveResponse = {
  approved: true
}

export type RunDenyResponse = {
  approved: false
}
