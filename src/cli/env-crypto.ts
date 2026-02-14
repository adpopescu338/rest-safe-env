import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { ENCRYPTED_PREFIX } from './env-parser'

const ENCRYPTION_PAYLOAD_VERSION = 0x01
const ENCRYPTION_NONCE_LENGTH = 12
const ENCRYPTION_TAG_LENGTH = 16

export function encryptEnvValue(value: string, keyName: string, masterKey: Buffer): string {
  assertMasterKey(masterKey)

  const nonce = randomBytes(ENCRYPTION_NONCE_LENGTH)
  const aad = Buffer.from(`rse:v1:${keyName}`, 'utf8')
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce)
  cipher.setAAD(aad)

  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  if (tag.length !== ENCRYPTION_TAG_LENGTH) {
    throw new Error('Invalid encryption tag length.')
  }

  const payload = Buffer.concat([
    Buffer.from([ENCRYPTION_PAYLOAD_VERSION]),
    nonce,
    ciphertext,
    tag,
  ])

  return `${ENCRYPTED_PREFIX}${payload.toString('base64')}`
}

export function decryptEnvValue(rawValue: string, keyName: string, masterKey: Buffer): string {
  assertMasterKey(masterKey)

  if (!rawValue.startsWith(ENCRYPTED_PREFIX)) {
    return rawValue
  }

  const encodedPayload = rawValue.slice(ENCRYPTED_PREFIX.length)
  const payload = Buffer.from(encodedPayload, 'base64')

  if (payload.length < 1 + ENCRYPTION_NONCE_LENGTH + ENCRYPTION_TAG_LENGTH) {
    throw new Error(`Invalid encrypted payload for key ${keyName}.`)
  }

  const version = payload[0]
  if (version !== ENCRYPTION_PAYLOAD_VERSION) {
    throw new Error(`Unsupported encrypted payload version for key ${keyName}.`)
  }

  const nonceStart = 1
  const nonceEnd = nonceStart + ENCRYPTION_NONCE_LENGTH
  const tagStart = payload.length - ENCRYPTION_TAG_LENGTH

  const nonce = payload.subarray(nonceStart, nonceEnd)
  const ciphertext = payload.subarray(nonceEnd, tagStart)
  const tag = payload.subarray(tagStart)

  const aad = Buffer.from(`rse:v1:${keyName}`, 'utf8')
  const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}

function assertMasterKey(masterKey: Buffer): void {
  if (masterKey.length !== 32) {
    throw new Error('Invalid master key length.')
  }
}
