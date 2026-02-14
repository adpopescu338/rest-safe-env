import type { ShareSnapshotEntry } from '../shared/protocol'

type SharePayload = {
  version: 1
  createdAt: string
  entries: ShareSnapshotEntry[]
}

type ShareEnvelope = {
  version: 1
  algorithm: 'P256-HKDF-SHA256-AES256GCM'
  senderPublicKey: string
  salt: string
  iv: string
  ciphertext: string
}

const PUBLIC_KEY_PREFIX = 'rse-import-pub:v1:'
const SHARE_BLOB_PREFIX = 'rse-share:v1:'

export type ImportSessionKey = {
  privateKey: CryptoKey
  publicKeyText: string
}

export async function generateImportSessionKey(): Promise<ImportSessionKey> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true,
    ['deriveBits']
  )

  const publicKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey)
  return {
    privateKey: keyPair.privateKey,
    publicKeyText: `${PUBLIC_KEY_PREFIX}${base64UrlEncode(new Uint8Array(publicKeyRaw))}`,
  }
}

export async function buildEncryptedShareBlob(
  receiverPublicKeyText: string,
  entries: ShareSnapshotEntry[]
): Promise<string> {
  const receiverPublicKey = await importReceiverPublicKey(receiverPublicKeyText)

  const senderEphemeralKeyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true,
    ['deriveBits']
  )

  const senderPublicKeyRaw = await crypto.subtle.exportKey('raw', senderEphemeralKeyPair.publicKey)
  const sharedSecret = await crypto.subtle.deriveBits(
    {
      name: 'ECDH',
      public: receiverPublicKey,
    },
    senderEphemeralKeyPair.privateKey,
    256
  )

  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const aesKey = await deriveAesKey(sharedSecret, salt)
  const payload: SharePayload = {
    version: 1,
    createdAt: new Date().toISOString(),
    entries,
  }

  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
    },
    aesKey,
    plaintext
  )

  const envelope: ShareEnvelope = {
    version: 1,
    algorithm: 'P256-HKDF-SHA256-AES256GCM',
    senderPublicKey: base64UrlEncode(new Uint8Array(senderPublicKeyRaw)),
    salt: base64UrlEncode(salt),
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(new Uint8Array(encrypted)),
  }

  const serializedEnvelope = new TextEncoder().encode(JSON.stringify(envelope))
  return `${SHARE_BLOB_PREFIX}${base64UrlEncode(serializedEnvelope)}`
}

export async function decryptShareBlob(
  blobText: string,
  receiverPrivateKey: CryptoKey
): Promise<ShareSnapshotEntry[]> {
  const trimmedBlob = blobText.trim()
  if (!trimmedBlob.startsWith(SHARE_BLOB_PREFIX)) {
    throw new Error('Invalid share blob prefix.')
  }

  const encodedEnvelope = trimmedBlob.slice(SHARE_BLOB_PREFIX.length)
  const envelopeBytes = base64UrlDecode(encodedEnvelope)
  const envelopeJson = new TextDecoder().decode(envelopeBytes)
  const envelope = JSON.parse(envelopeJson) as ShareEnvelope

  if (envelope.version !== 1 || envelope.algorithm !== 'P256-HKDF-SHA256-AES256GCM') {
    throw new Error('Unsupported share blob version.')
  }

  const senderPublicKeyBytes = base64UrlDecode(envelope.senderPublicKey)
  const senderPublicKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(senderPublicKeyBytes),
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    false,
    []
  )

  const sharedSecret = await crypto.subtle.deriveBits(
    {
      name: 'ECDH',
      public: senderPublicKey,
    },
    receiverPrivateKey,
    256
  )

  const salt = base64UrlDecode(envelope.salt)
  const iv = base64UrlDecode(envelope.iv)
  const ciphertext = base64UrlDecode(envelope.ciphertext)
  const aesKey = await deriveAesKey(sharedSecret, salt)

  let decrypted: ArrayBuffer
  try {
    decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(iv),
      },
      aesKey,
      toArrayBuffer(ciphertext)
    )
  } catch {
    throw new Error('Failed to decrypt share blob.')
  }

  const payloadJson = new TextDecoder().decode(decrypted)
  const payload = JSON.parse(payloadJson) as SharePayload
  validateSharePayload(payload)
  return payload.entries
}

function validateSharePayload(payload: SharePayload): void {
  if (!payload || payload.version !== 1 || !Array.isArray(payload.entries)) {
    throw new Error('Invalid share payload.')
  }

  for (const entry of payload.entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string') {
      throw new Error('Invalid shared entry.')
    }

    if (entry.type === 'blank') {
      continue
    }

    if (entry.type === 'comment') {
      if (typeof entry.text !== 'string') {
        throw new Error('Invalid shared comment entry.')
      }
      continue
    }

    if (
      entry.type === 'pair' &&
      typeof entry.key === 'string' &&
      typeof entry.value === 'string' &&
      typeof entry.encrypt === 'boolean'
    ) {
      continue
    }

    throw new Error('Invalid shared pair entry.')
  }
}

async function importReceiverPublicKey(publicKeyText: string): Promise<CryptoKey> {
  const trimmed = publicKeyText.trim()
  const encodedKey = trimmed.startsWith(PUBLIC_KEY_PREFIX)
    ? trimmed.slice(PUBLIC_KEY_PREFIX.length)
    : trimmed

  const publicKeyBytes = base64UrlDecode(encodedKey)
  if (publicKeyBytes.byteLength !== 65) {
    throw new Error('Receiver public key is not valid.')
  }

  return crypto.subtle.importKey(
    'raw',
    toArrayBuffer(publicKeyBytes),
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    false,
    []
  )
}

async function deriveAesKey(sharedSecret: ArrayBuffer, salt: Uint8Array): Promise<CryptoKey> {
  const hkdfMaterial = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(new TextEncoder().encode('rest-safe-env-share-v1')),
    },
    hkdfMaterial,
    {
      name: 'AES-GCM',
      length: 256,
    },
    false,
    ['encrypt', 'decrypt']
  )
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index])
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  let binary: string

  try {
    binary = atob(normalized + padding)
  } catch {
    throw new Error('Invalid base64url value.')
  }

  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
