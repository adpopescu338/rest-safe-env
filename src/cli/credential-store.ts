import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getConfigDirPath } from './config'

const CREDENTIAL_FILE_NAME = 'credential.json'
const WRAPPED_MASTER_KEY_FILE_NAME = 'wrapped-master-key.json'
const MASTER_KEY_LENGTH = 32
const WRAP_NONCE_LENGTH = 12
const WRAP_AAD = Buffer.from('rse:master-key-wrap:v1')
const KEK_INFO = Buffer.from('rse:kek:v1')
const PRF_SALT_TEXT = 'rest-safe-env:master-key:v1'

type CredentialRecord = {
  version: 1
  credentialId: string
  rpId: string
  publicKeySpki: string
  signCount: number
  createdAt: string
  clientDataJSON: string
  attestationObject: string
}

type WrappedMasterKeyRecord = {
  version: 1
  createdAt: string
  prfSalt: string
  nonce: string
  ciphertext: string
  tag: string
}

export type RegisterCredentialInput = {
  credentialId: string
  rpId: string
  publicKeySpki: string
  clientDataJSON: string
  attestationObject: string
  prfOutput: string
}

export type RegisterCredentialResult = {
  prfSalt: string
  masterKey: Buffer
}

export async function hasRegisteredCredentialMaterial(): Promise<boolean> {
  const [credentialExists, wrappedMasterKeyExists] = await Promise.all([
    fileExists(getCredentialFilePath()),
    fileExists(getWrappedMasterKeyFilePath()),
  ])

  return credentialExists && wrappedMasterKeyExists
}

export async function registerCredentialAndMasterKey(
  input: RegisterCredentialInput
): Promise<RegisterCredentialResult> {
  await ensureConfigDirectory()

  const prfSalt = getPrfSaltBuffer()
  const prfOutput = decodeBase64(input.prfOutput)
  if (prfOutput.length === 0) {
    throw new Error('Invalid prfOutput: empty value.')
  }

  const kek = deriveKek(prfOutput)
  const masterKey = randomBytes(MASTER_KEY_LENGTH)
  const wrapResult = wrapMasterKey(masterKey, kek)

  const credentialRecord: CredentialRecord = {
    version: 1,
    credentialId: input.credentialId,
    rpId: input.rpId,
    publicKeySpki: input.publicKeySpki,
    signCount: 0,
    createdAt: new Date().toISOString(),
    clientDataJSON: input.clientDataJSON,
    attestationObject: input.attestationObject,
  }

  const wrappedMasterKeyRecord: WrappedMasterKeyRecord = {
    version: 1,
    createdAt: new Date().toISOString(),
    prfSalt: encodeBase64(prfSalt),
    nonce: encodeBase64(wrapResult.nonce),
    ciphertext: encodeBase64(wrapResult.ciphertext),
    tag: encodeBase64(wrapResult.tag),
  }

  await Promise.all([
    writeFile(
      getCredentialFilePath(),
      JSON.stringify(credentialRecord, null, 2) + '\n',
      'utf8'
    ),
    writeFile(
      getWrappedMasterKeyFilePath(),
      JSON.stringify(wrappedMasterKeyRecord, null, 2) + '\n',
      'utf8'
    ),
  ])

  const masterKeyForCaller = Buffer.from(masterKey)
  masterKey.fill(0)

  return {
    prfSalt: encodeBase64(prfSalt),
    masterKey: masterKeyForCaller,
  }
}

export function getPrfSaltBase64(): string {
  return encodeBase64(getPrfSaltBuffer())
}

export type CredentialSummary = {
  credentialId: string
  rpId: string
  publicKeySpki: string
  signCount: number
}

export async function readCredentialSummary(): Promise<CredentialSummary | null> {
  const record = await readCredentialRecord()
  if (!record) {
    return null
  }

  if (!record.publicKeySpki || typeof record.publicKeySpki !== 'string') {
    return null
  }

  const signCount = Number.isInteger(record.signCount) ? record.signCount : 0

  return {
    credentialId: record.credentialId,
    rpId: record.rpId,
    publicKeySpki: record.publicKeySpki,
    signCount,
  }
}

export async function updateCredentialSignCount(nextSignCount: number): Promise<void> {
  const record = await readCredentialRecord()
  if (!record) {
    throw new Error('Credential record not found.')
  }

  record.signCount = nextSignCount
  await writeFile(getCredentialFilePath(), JSON.stringify(record, null, 2) + '\n', 'utf8')
}

export async function unwrapMasterKeyFromPrfOutput(prfOutputBase64: string): Promise<Buffer> {
  const wrappedRecord = await readWrappedMasterKeyRecord()
  const prfOutput = decodeBase64(prfOutputBase64)
  if (prfOutput.length === 0) {
    throw new Error('Invalid prfOutput: empty value.')
  }

  const kek = deriveKek(prfOutput)
  const nonce = decodeBase64(wrappedRecord.nonce)
  const ciphertext = decodeBase64(wrappedRecord.ciphertext)
  const tag = decodeBase64(wrappedRecord.tag)

  const decipher = createDecipheriv('aes-256-gcm', kek, nonce)
  decipher.setAAD(WRAP_AAD)
  decipher.setAuthTag(tag)

  const masterKey = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  if (masterKey.length !== MASTER_KEY_LENGTH) {
    throw new Error('Invalid unwrapped master key length.')
  }

  return masterKey
}

async function ensureConfigDirectory(): Promise<void> {
  await mkdir(getConfigDirPath(), { recursive: true })
}

function getCredentialFilePath(): string {
  return path.join(getConfigDirPath(), CREDENTIAL_FILE_NAME)
}

function getWrappedMasterKeyFilePath(): string {
  return path.join(getConfigDirPath(), WRAPPED_MASTER_KEY_FILE_NAME)
}

function deriveKek(prfOutput: Buffer): Buffer {
  const derived = hkdfSync('sha256', prfOutput, Buffer.alloc(0), KEK_INFO, MASTER_KEY_LENGTH)
  return Buffer.from(derived)
}

function wrapMasterKey(masterKey: Buffer, kek: Buffer): {
  nonce: Buffer
  ciphertext: Buffer
  tag: Buffer
} {
  const nonce = randomBytes(WRAP_NONCE_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', kek, nonce)
  cipher.setAAD(WRAP_AAD)

  const ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final()])
  const tag = cipher.getAuthTag()

  return {
    nonce,
    ciphertext,
    tag,
  }
}

function getPrfSaltBuffer(): Buffer {
  return createHash('sha256').update(PRF_SALT_TEXT, 'utf8').digest()
}

function encodeBase64(value: Buffer): string {
  return value.toString('base64')
}

function decodeBase64(value: string): Buffer {
  return Buffer.from(value, 'base64')
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export async function readCredentialRecord(): Promise<CredentialRecord | null> {
  try {
    const raw = await readFile(getCredentialFilePath(), 'utf8')
    return JSON.parse(raw) as CredentialRecord
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }

    throw error
  }
}

async function readWrappedMasterKeyRecord(): Promise<WrappedMasterKeyRecord> {
  const raw = await readFile(getWrappedMasterKeyFilePath(), 'utf8')
  return JSON.parse(raw) as WrappedMasterKeyRecord
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
