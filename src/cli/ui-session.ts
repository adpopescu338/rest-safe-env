import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getPrfSaltBase64,
  hasRegisteredCredentialMaterial,
  readCredentialSummary,
  registerCredentialAndMasterKey,
  updateCredentialSignCount,
  unwrapMasterKey,
} from './credential-store'
import { decryptEnvValue, encryptEnvValue } from './env-crypto'
import {
  decodeEnvValue,
  ENCRYPTED_PREFIX,
  parseEnvFile,
  serializeEnvDocument,
  type EnvDocument,
} from './env-parser'
import type {
  EditableEntry,
  DecryptEnvValueRequest,
  DecryptEnvValueResponse,
  EnvEntry as ApiEnvEntry,
  GetEnvResponse,
  HealthResponse,
  RegisterRequestResponse,
  RegisterResponse,
  RegisterResponseRequest,
  SaveEnvRequest,
  SaveEnvResponse,
  ShareSnapshotEntry,
  ShareSnapshotResponse,
  UnlockRequestResponse,
  UnlockResponse,
  UnlockResponseRequest,
  RunApproveResponse,
  RunContextResponse,
  RunDenyResponse,
} from '../shared/protocol'

type SessionMode = 'view' | 'run' | 'import'

type ViewSessionOptions = {
  mode: 'view'
  port: number
  envFilePath: string
  envFileContent: string | null
  timeoutMs?: number
}

type ImportSessionOptions = {
  mode: 'import'
  port: number
  envFilePath: string
  envFileContent: string | null
  timeoutMs?: number
}

type RunSessionOptions = {
  mode: 'run'
  port: number
  commandDisplay: string
  envFilePath: string
  encryptedEntryCount: number
  timeoutMs?: number
}

type StartUiSessionOptions = ViewSessionOptions | RunSessionOptions | ImportSessionOptions

export type RunSessionResult = {
  mode: 'run'
  approved: boolean
  unlockedMasterKey: Buffer | null
}

type ViewSessionResult = {
  mode: 'view' | 'import'
}

export type StartUiSessionResult = ViewSessionResult | RunSessionResult

type RequestContext = {
  mode: SessionMode
  port: number
  token: string
  sessionId: string
  pageHtml: string
  onConnected: () => void
  onSessionComplete: () => void
  onRunDecision: ((approved: boolean) => void) | null
  viewState: ViewSessionState | null
  runState: RunSessionState | null
  pendingRegistration: PendingRegistration | null
  pendingUnlock: PendingUnlock | null
  hasRegisteredCredentialMaterial: boolean
  unlockedMasterKey: Buffer | null
  connected: boolean
  lastHeartbeatAt: number | null
  activeStreamCount: number
  disconnectTimer: NodeJS.Timeout | null
  sessionCompleted: boolean
}

type ViewSessionState = {
  envFilePath: string
  document: EnvDocument
}

type PendingRegistration = {
  challenge: Buffer
  expiresAt: number
  rpId: string
  expectedOrigin: string
}

type PendingUnlock = {
  challenge: Buffer
  expiresAt: number
  rpId: string
  expectedOrigin: string
  credentialId: string
}

type RunSessionState = {
  commandDisplay: string
  envFilePath: string
  encryptedEntryCount: number
  requiresUnlock: boolean
  decided: boolean
}

class SessionApiError extends Error {
  statusCode: number
  errorCode: string

  constructor(statusCode: number, errorCode: string, message: string) {
    super(message)
    this.statusCode = statusCode
    this.errorCode = errorCode
  }
}

const DEFAULT_CONNECT_TIMEOUT_MS = 60_000
const LOOPBACK_BIND_HOST = '127.0.0.1'
const WEBAUTHN_RP_HOST = 'localhost'
const SESSION_HEARTBEAT_TIMEOUT_MS = 3_000
const SESSION_HEARTBEAT_CHECK_INTERVAL_MS = 1_500
const SESSION_STREAM_DISCONNECT_GRACE_MS = 750
const SESSION_STREAM_KEEPALIVE_MS = 1_000

export async function startUiSession(options: StartUiSessionOptions): Promise<StartUiSessionResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const sessionId = randomBytes(16).toString('hex')
  const token = randomBytes(16).toString('hex')
  const pageHtml = await loadSessionHtml(options.mode)
  const hasCredentialMaterial = await hasRegisteredCredentialMaterial()
  const viewState =
    options.mode === 'view' || options.mode === 'import'
      ? {
          envFilePath: options.envFilePath,
          document: createInitialDocument(options.envFileContent),
        }
      : null
  const runState =
    options.mode === 'run'
      ? {
          commandDisplay: options.commandDisplay,
          envFilePath: options.envFilePath,
          encryptedEntryCount: options.encryptedEntryCount,
          requiresUnlock: options.encryptedEntryCount > 0,
          decided: false,
        }
      : null

  let markConnected = () => {}
  const connectedPromise = new Promise<void>((resolve) => {
    markConnected = resolve
  })

  let markSessionDone = () => {}
  const sessionDonePromise = new Promise<void>((resolve) => {
    markSessionDone = resolve
  })

  let resolveRunDecision: ((approved: boolean) => void) | null = null
  const runDecisionPromise =
    options.mode === 'run'
      ? new Promise<boolean>((resolve) => {
          resolveRunDecision = resolve
        })
      : null

  let sessionCompleted = false
  const context: RequestContext = {
    mode: options.mode,
    port: options.port,
    token,
    sessionId,
    pageHtml,
    onConnected: markConnected,
    onSessionComplete: () => {
      if (sessionCompleted) {
        return
      }

      sessionCompleted = true
      context.sessionCompleted = true
      markSessionDone()
    },
    onRunDecision: resolveRunDecision,
    viewState,
    runState,
    pendingRegistration: null,
    pendingUnlock: null,
    hasRegisteredCredentialMaterial: hasCredentialMaterial,
    unlockedMasterKey: null,
    connected: false,
    lastHeartbeatAt: null,
    activeStreamCount: 0,
    disconnectTimer: null,
    sessionCompleted: false,
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response, context)
  })
  const heartbeatMonitor = setInterval(() => {
    if (
      !context.connected ||
      context.sessionCompleted ||
      context.lastHeartbeatAt === null ||
      context.activeStreamCount > 0
    ) {
      return
    }

    if (Date.now() - context.lastHeartbeatAt > SESSION_HEARTBEAT_TIMEOUT_MS) {
      completeSessionFromWindowClose(context)
    }
  }, SESSION_HEARTBEAT_CHECK_INTERVAL_MS)

  try {
    await listenOnFixedPort(server, options.port)
    const url = `http://${WEBAUTHN_RP_HOST}:${options.port}/?session=${sessionId}&token=${token}&mode=${options.mode}`
    console.log(`[rse] open this URL if browser did not launch automatically: ${url}`)

    await openBrowser(url)
    await waitForConnection(connectedPromise, timeoutMs)

    if (options.mode !== 'run') {
      await sessionDonePromise
      return { mode: options.mode }
    }

    const approved = await (runDecisionPromise ?? Promise.resolve(false))
    await sessionDonePromise

    const masterKeyForCaller = context.unlockedMasterKey
      ? Buffer.from(context.unlockedMasterKey)
      : null
    wipeMasterKey(context.unlockedMasterKey)
    context.unlockedMasterKey = null

    return {
      mode: 'run',
      approved,
      unlockedMasterKey: masterKeyForCaller,
    }
  } finally {
    clearInterval(heartbeatMonitor)
    if (context.disconnectTimer) {
      clearTimeout(context.disconnectTimer)
      context.disconnectTimer = null
    }
    wipeMasterKey(context.unlockedMasterKey)
    context.unlockedMasterKey = null
    await closeServer(server)
  }
}

async function loadSessionHtml(mode: SessionMode): Promise<string> {
  const distHtmlPath = path.resolve(getCliDistDirPath(), 'session.html')

  try {
    return await readFile(distHtmlPath, 'utf8')
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return renderFallbackPage(mode)
    }

    throw error
  }
}

function getCliDistDirPath(): string {
  const cliFilePath = fileURLToPath(import.meta.url)
  return path.dirname(cliFilePath)
}

async function tryServeStaticDistAsset(pathname: string, response: ServerResponse): Promise<boolean> {
  const decodedPath = decodeURIComponent(pathname)
  if (!decodedPath.startsWith('/')) {
    return false
  }

  const relativePath = decodedPath.slice(1)
  if (!relativePath || relativePath.includes('\0')) {
    return false
  }

  const distDirPath = getCliDistDirPath()
  const candidatePath = path.resolve(distDirPath, relativePath)
  const normalizedDistPrefix = `${distDirPath}${path.sep}`
  if (!candidatePath.startsWith(normalizedDistPrefix)) {
    return false
  }

  try {
    const content = await readFile(candidatePath)
    response.writeHead(200, {
      'Content-Type': getContentTypeForPath(candidatePath),
    })
    response.end(content)
    return true
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return false
    }

    throw error
  }
}

function getContentTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.js' || extension === '.mjs') {
    return 'text/javascript; charset=utf-8'
  }

  if (extension === '.css') {
    return 'text/css; charset=utf-8'
  }

  if (extension === '.svg') {
    return 'image/svg+xml'
  }

  if (extension === '.json') {
    return 'application/json; charset=utf-8'
  }

  if (extension === '.html') {
    return 'text/html; charset=utf-8'
  }

  return 'application/octet-stream'
}

function renderFallbackPage(mode: SessionMode): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>rest-safe-env</title>
</head>
<body>
  <main style="font-family: ui-sans-serif, system-ui, sans-serif; padding: 2rem;">
    <h1>rest-safe-env</h1>
    <p>mode: ${escapeHtml(mode)}</p>
    <p>Built UI not found. Run <code>yarn build</code> and retry.</p>
  </main>
</body>
</html>`
}

async function listenOnFixedPort(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }

    const onListening = () => {
      server.off('error', onError)
      resolve()
    }

    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, LOOPBACK_BIND_HOST)
  }).catch((error: unknown) => {
    if (isAddressInUseError(error)) {
      throw new Error(
        `Configured UI port ${port} is already in use. Set a new one with: rse config port <newPort>.`
      )
    }

    throw error
  })
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext
): Promise<void> {
  const host = request.headers.host ?? WEBAUTHN_RP_HOST
  const url = new URL(request.url ?? '/', `http://${host}`)

  if (url.pathname === '/api/health') {
    handleHealthRequest(request, response, context)
    return
  }

  if (url.pathname === '/api/session/ping') {
    handleSessionPingRequest(request, response, context)
    return
  }

  if (url.pathname === '/api/session/closed') {
    handleSessionClosedRequest(request, response, context, url)
    return
  }

  if (url.pathname === '/api/session/stream') {
    handleSessionStreamRequest(request, response, context, url)
    return
  }

  if (url.pathname === '/api/env') {
    await handleEnvRequest(request, response, context)
    return
  }

  if (url.pathname === '/api/env/decrypt') {
    await handleDecryptEnvRequest(request, response, context)
    return
  }

  if (url.pathname === '/api/share/snapshot') {
    await handleShareSnapshotRequest(request, response, context)
    return
  }

  if (url.pathname === '/api/register/request') {
    handleRegisterRequest(request, response, context)
    return
  }

  if (url.pathname === '/api/register/response') {
    await handleRegisterResponse(request, response, context)
    return
  }

  if (url.pathname === '/api/unlock/request') {
    await handleUnlockRequest(request, response, context)
    return
  }

  if (url.pathname === '/api/unlock/response') {
    await handleUnlockResponse(request, response, context)
    return
  }

  if (url.pathname === '/api/run/context') {
    handleRunContextRequest(request, response, context)
    return
  }

  if (url.pathname === '/api/run/approve') {
    handleRunApproveRequest(request, response, context)
    return
  }

  if (url.pathname === '/api/run/deny') {
    handleRunDenyRequest(request, response, context)
    return
  }

  if (url.pathname === '/') {
    const session = url.searchParams.get('session')
    const token = url.searchParams.get('token')
    const mode = url.searchParams.get('mode')

    if (session !== context.sessionId || token !== context.token || mode !== context.mode) {
      respondJson(response, 403, { ok: false, error: 'forbidden' })
      return
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(context.pageHtml)
    return
  }

  if (url.pathname === '/favicon.ico') {
    response.writeHead(204)
    response.end()
    return
  }

  if (request.method === 'GET') {
    const served = await tryServeStaticDistAsset(url.pathname, response)
    if (served) {
      return
    }
  }

  respondJson(response, 404, { ok: false, error: 'not_found' })
}

function handleHealthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext
): void {
  if (request.method !== 'GET') {
    respondJson(response, 405, { ok: false, error: 'method_not_allowed' })
    return
  }

  if (!hasValidToken(request, context.token)) {
    respondJson(response, 403, { ok: false, error: 'forbidden' })
    return
  }

  markSessionConnected(context)

  const body: HealthResponse = { ok: true }
  respondJson(response, 200, body)
}

function handleSessionPingRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext
): void {
  if (request.method !== 'POST') {
    respondJson(response, 405, { ok: false, error: 'method_not_allowed' })
    return
  }

  if (!hasValidToken(request, context.token)) {
    respondJson(response, 403, { ok: false, error: 'forbidden' })
    return
  }

  markSessionConnected(context)
  respondJson(response, 200, { ok: true })
}

function handleSessionStreamRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
  url: URL
): void {
  if (request.method !== 'GET') {
    respondJson(response, 405, { ok: false, error: 'method_not_allowed' })
    return
  }

  const tokenFromQuery = url.searchParams.get('token')
  if (tokenFromQuery !== context.token) {
    respondJson(response, 403, { ok: false, error: 'forbidden' })
    return
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
  response.flushHeaders()
  response.write('event: connected\ndata: ok\n\n')

  markSessionConnected(context)
  context.activeStreamCount += 1

  request.socket.setNoDelay(true)

  const keepAliveId = setInterval(() => {
    if (!response.writableEnded && !response.destroyed) {
      response.write(': keepalive\n\n')
    }
  }, SESSION_STREAM_KEEPALIVE_MS)

  let closed = false
  const onClose = () => {
    if (closed) {
      return
    }

    closed = true
    clearInterval(keepAliveId)
    context.activeStreamCount = Math.max(0, context.activeStreamCount - 1)
    scheduleDisconnectCheck(context)
  }

  response.on('close', onClose)
  response.on('error', onClose)
  request.on('close', onClose)
  request.socket.on('close', onClose)
  request.socket.on('end', onClose)
}

function handleSessionClosedRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
  url: URL
): void {
  if (request.method !== 'POST' && request.method !== 'GET') {
    respondJson(response, 405, { ok: false, error: 'method_not_allowed' })
    return
  }

  const tokenFromQuery = url.searchParams.get('token')
  if (!hasValidToken(request, context.token) && tokenFromQuery !== context.token) {
    respondJson(response, 403, { ok: false, error: 'forbidden' })
    return
  }

  completeSessionFromWindowClose(context)
  respondJson(response, 200, { ok: true })
}

function markSessionConnected(context: RequestContext): void {
  if (context.disconnectTimer) {
    clearTimeout(context.disconnectTimer)
    context.disconnectTimer = null
  }

  context.connected = true
  context.lastHeartbeatAt = Date.now()
  context.onConnected()
}

function scheduleDisconnectCheck(context: RequestContext): void {
  if (context.sessionCompleted || context.activeStreamCount > 0) {
    return
  }

  if (context.disconnectTimer) {
    clearTimeout(context.disconnectTimer)
  }

  context.disconnectTimer = setTimeout(() => {
    context.disconnectTimer = null

    if (context.activeStreamCount > 0 || context.sessionCompleted) {
      return
    }

    completeSessionFromWindowClose(context)
  }, SESSION_STREAM_DISCONNECT_GRACE_MS)
}

async function handleEnvRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext
): Promise<void> {
  if ((context.mode !== 'view' && context.mode !== 'import') || !context.viewState) {
    respondJson(response, 404, { ok: false, error: 'not_found' })
    return
  }

  if (!hasValidToken(request, context.token)) {
    respondJson(response, 403, { ok: false, error: 'forbidden' })
    return
  }

  if (request.method === 'GET') {
    const body: GetEnvResponse = {
      entries: toApiEntries(context.viewState.document),
    }
    respondJson(response, 200, body)
    return
  }

  if (request.method !== 'POST') {
    respondJson(response, 405, { ok: false, error: 'method_not_allowed' })
    return
  }

  try {
    const payload = await readJsonBody<SaveEnvRequest>(request)
    if (!payload || !Array.isArray(payload.entries)) {
      respondJson(response, 400, { ok: false, error: 'invalid_payload' })
      return
    }

    context.viewState.document = applyEditableEntries(
      context.viewState.document,
      payload.entries,
      context.hasRegisteredCredentialMaterial,
      context.unlockedMasterKey
    )

    const output = serializeEnvDocument(context.viewState.document)
    await writeFile(context.viewState.envFilePath, output, 'utf8')

    wipeMasterKey(context.unlockedMasterKey)
    context.unlockedMasterKey = null

    const body: SaveEnvResponse = { ok: true }
    respondJson(response, 200, body)
    context.onSessionComplete()
    return
  } catch (error) {
    if (error instanceof SessionApiError) {
      respondJson(response, error.statusCode, { ok: false, error: error.errorCode, message: error.message })
      return
    }

    const message = error instanceof Error ? error.message : 'failed_to_save'
    respondJson(response, 400, { ok: false, error: 'save_failed', message })
  }
}

async function handleDecryptEnvRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext
): Promise<void> {
  if (request.method !== 'POST') {
    respondJson(response, 405, { ok: false, error: 'method_not_allowed' })
    return
  }

  if (context.mode !== 'view' || !context.viewState) {
    respondJson(response, 404, { ok: false, error: 'not_found' })
    return
  }

  if (!hasValidToken(request, context.token)) {
    respondJson(response, 403, { ok: false, error: 'forbidden' })
    return
  }

  if (!context.hasRegisteredCredentialMaterial) {
    respondJson(response, 409, {
      ok: false,
      error: 'registration_required',
      message: 'WebAuthn registration is required before decrypting values.',
    })
    return
  }

  if (!context.unlockedMasterKey) {
    respondJson(response, 409, {
      ok: false,
      error: 'unlock_required',
      message: 'Unlock required before decrypting values.',
    })
    return
  }

  try {
    const payload = await readJsonBody<DecryptEnvValueRequest>(request)
    if (
      !payload ||
      !Number.isInteger(payload.sourceIndex) ||
      payload.sourceIndex < 0 ||
      typeof payload.key !== 'string' ||
      payload.key.length === 0
    ) {
      throw new SessionApiError(400, 'invalid_payload', 'sourceIndex and key are required.')
    }

    const sourceEntry = context.viewState.document.entries[payload.sourceIndex]
    if (
      !sourceEntry ||
      sourceEntry.type !== 'pair' ||
      sourceEntry.key !== payload.key ||
      !sourceEntry.rawValue.startsWith(ENCRYPTED_PREFIX)
    ) {
      throw new SessionApiError(404, 'entry_not_found', 'Encrypted entry was not found.')
    }

    const body: DecryptEnvValueResponse = {
      value: decryptEnvValue(sourceEntry.rawValue, sourceEntry.key, context.unlockedMasterKey),
    }
    respondJson(response, 200, body)
  } catch (error) {
    if (error instanceof SessionApiError) {
      respondJson(response, error.statusCode, { ok: false, error: error.errorCode, message: error.message })
      return
    }

    const message = error instanceof Error ? error.message : 'decrypt_failed'
    respondJson(response, 400, { ok: false, error: 'decrypt_failed', message })
  }
}

async function handleShareSnapshotRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext
): Promise<void> {
  if (request.method !== 'POST') {
    respondJson(response, 405, { ok: false, error: 'method_not_allowed' })
    return
  }

  if (context.mode !== 'view' || !context.viewState) {
    respondJson(response, 404, { ok: false, error: 'not_found' })
    return
  }

  if (!hasValidToken(request, context.token)) {
    respondJson(response, 403, { ok: false, error: 'forbidden' })
    return
  }

  try {
    const entries = buildShareSnapshotEntries(
      context.viewState.document,
      context.hasRegisteredCredentialMaterial,
      context.unlockedMasterKey
    )
    const body: ShareSnapshotResponse = { entries }
    respondJson(response, 200, body)
  } catch (error) {
    if (error instanceof SessionApiError) {
      respondJson(response, error.statusCode, { ok: false, error: error.errorCode, message: error.message })
      return
    }

    const message = error instanceof Error ? error.message : 'share_snapshot_failed'
    respondJson(response, 400, { ok: false, error: 'share_snapshot_failed', message })
  }
}

function handleRegisterRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext
): void {
  if (request.method !== 'POST') {
    respondJson(response, 405, { ok: false, error: 'method_not_allowed' })
    return
  }

  if (context.mode !== 'view' && context.mode !== 'import') {
    respondJson(response, 404, { ok: false, error: 'not_found' })
    return
  }

  if (!hasValidToken(request, context.token)) {
    respondJson(response, 403, { ok: false, error: 'forbidden' })
    return
  }

  if (context.hasRegisteredCredentialMaterial) {
    respondJson(response, 200, {
      ok: true,
      alreadyRegistered: true,
    })
    return
  }

  const challenge = randomBytes(32)
  const userId = randomBytes(16)
  const rpId = WEBAUTHN_RP_HOST
  const expectedOrigin = `http://${WEBAUTHN_RP_HOST}:${context.port}`

  context.pendingRegistration = {
    challenge,
    rpId,
    expectedOrigin,
    expiresAt: Date.now() + 60_000,
  }

  const body: RegisterRequestResponse = {
    challenge: challenge.toString('base64'),
    rpId,
    user: {
      id: userId.toString('base64'),
      name: 'local-user',
    },
    prfSalt: getPrfSaltBase64(),
  }

  respondJson(response, 200, body)
}

async function handleRegisterResponse(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext
): Promise<void> {
  if (request.method !== 'POST') {
    respondJson(response, 405, { ok: false, error: 'method_not_allowed' })
    return
  }

  if (context.mode !== 'view' && context.mode !== 'import') {
    respondJson(response, 404, { ok: false, error: 'not_found' })
    return
  }

  if (!hasValidToken(request, context.token)) {
    respondJson(response, 403, { ok: false, error: 'forbidden' })
    return
  }

  if (!context.pendingRegistration) {
    respondJson(response, 400, { ok: false, error: 'registration_not_requested' })
    return
  }

  try {
    const payload = await readJsonBody<RegisterResponseRequest>(request)
    validateRegisterResponsePayload(payload)

    if (Date.now() > context.pendingRegistration.expiresAt) {
      context.pendingRegistration = null
      throw new SessionApiError(400, 'registration_expired', 'Registration request expired.')
    }

    const clientData = parseClientData(payload.clientDataJSON)
    const expectedChallenge = toBase64Url(context.pendingRegistration.challenge)
    if (clientData.challenge !== expectedChallenge) {
      throw new SessionApiError(400, 'invalid_registration_challenge', 'Registration challenge mismatch.')
    }

    if (clientData.type !== 'webauthn.create') {
      throw new SessionApiError(400, 'invalid_registration_type', 'Unexpected WebAuthn clientData type.')
    }

    if (clientData.origin !== context.pendingRegistration.expectedOrigin) {
      throw new SessionApiError(400, 'invalid_registration_origin', 'Unexpected registration origin.')
    }

    const registrationResult = await registerCredentialAndMasterKey({
      credentialId: payload.id,
      rpId: context.pendingRegistration.rpId,
      publicKeySpki: payload.publicKeySpki,
      clientDataJSON: payload.clientDataJSON,
      attestationObject: payload.attestationObject,
      prfOutput: payload.prfOutput,
    })

    context.hasRegisteredCredentialMaterial = true
    context.unlockedMasterKey = registrationResult.masterKey
    context.pendingRegistration = null

    const body: RegisterResponse = { ok: true }
    respondJson(response, 200, body)
  } catch (error) {
    context.pendingRegistration = null

    if (error instanceof SessionApiError) {
      respondJson(response, error.statusCode, { ok: false, error: error.errorCode, message: error.message })
      return
    }

    const message = error instanceof Error ? error.message : 'registration_failed'
    respondJson(response, 400, { ok: false, error: 'registration_failed', message })
  }
}

async function handleUnlockRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext
): Promise<void> {
  if (request.method !== 'POST') {
    respondJson(response, 405, { ok: false, error: 'method_not_allowed' })
    return
  }

  if (!hasValidToken(request, context.token)) {
    respondJson(response, 403, { ok: false, error: 'forbidden' })
    return
  }

  if (context.unlockedMasterKey) {
    respondJson(response, 200, { ok: true, alreadyUnlocked: true })
    return
  }

  if (!context.hasRegisteredCredentialMaterial) {
    respondJson(response, 409, {
      ok: false,
      error: 'registration_required',
      message: 'WebAuthn registration is required before unlock.',
    })
    return
  }

  const credential = await readCredentialSummary()
  if (!credential) {
    respondJson(response, 409, {
      ok: false,
      error: 'registration_required',
      message: 'Credential material missing. Run registration again.',
    })
    return
  }

  const challenge = randomBytes(32)
  const expectedOrigin = `http://${WEBAUTHN_RP_HOST}:${context.port}`

  context.pendingUnlock = {
    challenge,
    expiresAt: Date.now() + 60_000,
    rpId: credential.rpId,
    expectedOrigin,
    credentialId: credential.credentialId,
  }

  const body: UnlockRequestResponse = {
    challenge: challenge.toString('base64'),
    credentialId: credential.credentialId,
    rpId: credential.rpId,
    timeoutMs: 60_000,
    prfSalt: getPrfSaltBase64(),
  }

  respondJson(response, 200, body)
}

async function handleUnlockResponse(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext
): Promise<void> {
  if (request.method !== 'POST') {
    respondJson(response, 405, { ok: false, error: 'method_not_allowed' })
    return
  }

  if (!hasValidToken(request, context.token)) {
    respondJson(response, 403, { ok: false, error: 'forbidden' })
    return
  }

  if (!context.pendingUnlock) {
    respondJson(response, 400, { ok: false, error: 'unlock_not_requested' })
    return
  }

  try {
    const payload = await readJsonBody<UnlockResponseRequest>(request)
    validateUnlockResponsePayload(payload)

    if (Date.now() > context.pendingUnlock.expiresAt) {
      context.pendingUnlock = null
      throw new SessionApiError(400, 'unlock_expired', 'Unlock request expired.')
    }

    if (payload.id !== context.pendingUnlock.credentialId) {
      throw new SessionApiError(400, 'invalid_unlock_credential', 'Credential mismatch for unlock.')
    }

    const clientData = parseClientData(payload.clientDataJSON)
    const expectedChallenge = toBase64Url(context.pendingUnlock.challenge)

    if (clientData.challenge !== expectedChallenge) {
      throw new SessionApiError(400, 'invalid_unlock_challenge', 'Unlock challenge mismatch.')
    }

    if (clientData.type !== 'webauthn.get') {
      throw new SessionApiError(400, 'invalid_unlock_type', 'Unexpected WebAuthn clientData type.')
    }

    if (clientData.origin !== context.pendingUnlock.expectedOrigin) {
      throw new SessionApiError(400, 'invalid_unlock_origin', 'Unexpected unlock origin.')
    }

    const credential = await readCredentialSummary()
    if (!credential) {
      throw new SessionApiError(400, 'credential_not_found', 'Credential material not found.')
    }

    if (credential.credentialId !== context.pendingUnlock.credentialId) {
      throw new SessionApiError(400, 'invalid_unlock_credential', 'Credential mismatch for unlock.')
    }

    const authenticatorData = decodeBase64(payload.authenticatorData)
    const signCount = verifyAuthenticatorData(authenticatorData, credential.rpId)

    const signatureVerified = verifyWebAuthnAssertionSignature(
      credential.publicKeySpki,
      authenticatorData,
      payload.clientDataJSON,
      payload.signature
    )
    if (!signatureVerified) {
      throw new SessionApiError(400, 'invalid_unlock_signature', 'Assertion signature verification failed.')
    }

    if (credential.signCount > 0 && signCount > 0 && signCount <= credential.signCount) {
      throw new SessionApiError(
        400,
        'sign_count_regression',
        'Authenticator sign counter did not increase; possible cloned credential.'
      )
    }

    if (signCount > credential.signCount) {
      await updateCredentialSignCount(signCount)
    }

    context.unlockedMasterKey = await unwrapMasterKey(credential, payload.prfOutput)
    context.pendingUnlock = null

    const body: UnlockResponse = { ok: true }
    respondJson(response, 200, body)
  } catch (error) {
    context.pendingUnlock = null

    if (error instanceof SessionApiError) {
      respondJson(response, error.statusCode, { ok: false, error: error.errorCode, message: error.message })
      return
    }

    const message = error instanceof Error ? error.message : 'unlock_failed'
    respondJson(response, 400, { ok: false, error: 'unlock_failed', message })
  }
}

function handleRunContextRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext
): void {
  if (request.method !== 'GET') {
    respondJson(response, 405, { ok: false, error: 'method_not_allowed' })
    return
  }

  if (context.mode !== 'run' || !context.runState) {
    respondJson(response, 404, { ok: false, error: 'not_found' })
    return
  }

  if (!hasValidToken(request, context.token)) {
    respondJson(response, 403, { ok: false, error: 'forbidden' })
    return
  }

  const body: RunContextResponse = {
    command: context.runState.commandDisplay,
    envFilePath: context.runState.envFilePath,
    encryptedEntryCount: context.runState.encryptedEntryCount,
    requiresUnlock: context.runState.requiresUnlock,
  }
  respondJson(response, 200, body)
}

function handleRunApproveRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext
): void {
  if (request.method !== 'POST') {
    respondJson(response, 405, { ok: false, error: 'method_not_allowed' })
    return
  }

  if (context.mode !== 'run' || !context.runState) {
    respondJson(response, 404, { ok: false, error: 'not_found' })
    return
  }

  if (!hasValidToken(request, context.token)) {
    respondJson(response, 403, { ok: false, error: 'forbidden' })
    return
  }

  if (context.runState.decided) {
    respondJson(response, 409, { ok: false, error: 'already_decided' })
    return
  }

  if (context.runState.requiresUnlock && !context.unlockedMasterKey) {
    respondJson(response, 409, {
      ok: false,
      error: 'unlock_required',
      message: 'Unlock is required before approving this run.',
    })
    return
  }

  context.runState.decided = true
  context.onRunDecision?.(true)
  context.onSessionComplete()

  const body: RunApproveResponse = { approved: true }
  respondJson(response, 200, body)
}

function handleRunDenyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext
): void {
  if (request.method !== 'POST') {
    respondJson(response, 405, { ok: false, error: 'method_not_allowed' })
    return
  }

  if (context.mode !== 'run' || !context.runState) {
    respondJson(response, 404, { ok: false, error: 'not_found' })
    return
  }

  if (!hasValidToken(request, context.token)) {
    respondJson(response, 403, { ok: false, error: 'forbidden' })
    return
  }

  if (!context.runState.decided) {
    context.runState.decided = true
    context.onRunDecision?.(false)
    context.onSessionComplete()
  }

  const body: RunDenyResponse = { approved: false }
  respondJson(response, 200, body)
}

function toApiEntries(document: EnvDocument): ApiEnvEntry[] {
  return document.entries.map((entry) => {
    if (entry.type === 'blank') {
      return { type: 'blank' }
    }

    if (entry.type === 'comment') {
      return { type: 'comment', text: entry.text }
    }

    if (entry.rawValue.startsWith(ENCRYPTED_PREFIX)) {
      return {
        type: 'pair',
        key: entry.key,
        value: { kind: 'encrypted' },
      }
    }

    return {
      type: 'pair',
      key: entry.key,
      value: { kind: 'plain', value: decodeEnvValue(entry.rawValue) },
    }
  })
}

function buildShareSnapshotEntries(
  document: EnvDocument,
  hasCredentialMaterial: boolean,
  unlockedMasterKey: Buffer | null
): ShareSnapshotEntry[] {
  return document.entries.map((entry) => {
    if (entry.type === 'blank') {
      return { type: 'blank' }
    }

    if (entry.type === 'comment') {
      return { type: 'comment', text: entry.text }
    }

    if (!entry.rawValue.startsWith(ENCRYPTED_PREFIX)) {
      return {
        type: 'pair',
        key: entry.key,
        value: decodeEnvValue(entry.rawValue),
        encrypt: false,
      }
    }

    if (!hasCredentialMaterial) {
      throw new SessionApiError(
        409,
        'registration_required',
        'WebAuthn registration is required before sharing encrypted values.'
      )
    }

    if (!unlockedMasterKey) {
      throw new SessionApiError(409, 'unlock_required', 'Unlock required before sharing encrypted values.')
    }

    return {
      type: 'pair',
      key: entry.key,
      value: decryptEnvValue(entry.rawValue, entry.key, unlockedMasterKey),
      encrypt: true,
    }
  })
}

function applyEditableEntries(
  document: EnvDocument,
  entries: EditableEntry[],
  hasCredentialMaterial: boolean,
  unlockedMasterKey: Buffer | null
): EnvDocument {
  const nextEntries = entries.map((entry, index) => {
    if (entry.type === 'blank') {
      return { type: 'blank', whitespace: '' } as const
    }

    if (entry.type === 'comment') {
      return { type: 'comment', text: entry.text } as const
    }

    if (entry.encrypt) {
      const sourceIndex =
        Number.isInteger(entry.sourceIndex) && (entry.sourceIndex ?? -1) >= 0
          ? (entry.sourceIndex as number)
          : index
      const previousEntry = document.entries[sourceIndex]
      const canPreserveExistingCiphertext =
        entry.preserveEncrypted === true &&
        previousEntry &&
        previousEntry.type === 'pair' &&
        previousEntry.key === entry.key &&
        previousEntry.rawValue.startsWith(ENCRYPTED_PREFIX)

      if (canPreserveExistingCiphertext) {
        return {
          type: 'pair',
          key: entry.key,
          rawValue: previousEntry.rawValue,
          leadingWhitespace: '',
          spacingBeforeEquals: '',
          spacingAfterEquals: '',
          encrypted: true,
        } as const
      }

      if (!hasCredentialMaterial) {
        throw new SessionApiError(
          409,
          'registration_required',
          'WebAuthn registration is required before encrypting values.'
        )
      }

      if (!unlockedMasterKey) {
        throw new SessionApiError(409, 'unlock_required', 'Unlock required before encrypting values.')
      }

      return {
        type: 'pair',
        key: entry.key,
        rawValue: encryptEnvValue(decodeEnvValue(entry.value), entry.key, unlockedMasterKey),
        leadingWhitespace: '',
        spacingBeforeEquals: '',
        spacingAfterEquals: '',
        encrypted: true,
      } as const
    }

    const sourceIndex =
      Number.isInteger(entry.sourceIndex) && (entry.sourceIndex ?? -1) >= 0
        ? (entry.sourceIndex as number)
        : index
    const previousEntry = document.entries[sourceIndex]
    const canPreservePlainRaw =
      entry.preservePlainRaw === true &&
      previousEntry &&
      previousEntry.type === 'pair' &&
      previousEntry.key === entry.key &&
      !previousEntry.rawValue.startsWith(ENCRYPTED_PREFIX)

    return {
      type: 'pair',
      key: entry.key,
      rawValue: canPreservePlainRaw ? previousEntry.rawValue : entry.value,
      leadingWhitespace: '',
      spacingBeforeEquals: '',
      spacingAfterEquals: '',
      encrypted: false,
    } as const
  })

  return {
    ...document,
    entries: nextEntries,
  }
}

function hasValidToken(request: IncomingMessage, expectedToken: string): boolean {
  const tokenHeader = request.headers['x-rse-token']
  if (typeof tokenHeader !== 'string') {
    return false
  }

  return tokenHeader === expectedToken
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []

  await new Promise<void>((resolve, reject) => {
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })

    request.on('end', () => resolve())
    request.on('error', reject)
  })

  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text) as T
}

function respondJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function openBrowser(url: string): Promise<void> {
  if (process.env.RSE_SKIP_BROWSER_OPEN === '1') {
    return
  }

  const launchCommands = buildBrowserLaunchCommands(url)
  for (const launchCommand of launchCommands) {
    const launched = await tryLaunchDetachedProcess(launchCommand.cmd, launchCommand.args)
    if (launched) {
      return
    }
  }

  throw new Error('Failed to launch browser.')
}

type BrowserLaunchCommand = {
  cmd: string
  args: string[]
}

function buildBrowserLaunchCommands(url: string): BrowserLaunchCommand[] {
  if (process.platform === 'darwin') {
    return [
      { cmd: 'open', args: ['-na', 'Google Chrome', '--args', `--app=${url}`] },
      { cmd: 'open', args: ['-na', 'Microsoft Edge', '--args', `--app=${url}`] },
      { cmd: 'open', args: ['-na', 'Brave Browser', '--args', `--app=${url}`] },
      { cmd: 'open', args: ['-na', 'Google Chrome', '--args', '--new-window', url] },
      { cmd: 'open', args: ['-na', 'Microsoft Edge', '--args', '--new-window', url] },
      { cmd: 'open', args: ['-na', 'Brave Browser', '--args', '--new-window', url] },
      { cmd: 'open', args: ['-na', 'Firefox', '--args', '-new-window', url] },
      { cmd: 'open', args: ['-na', 'Safari', url] },
      { cmd: 'open', args: [url] },
    ]
  }

  if (process.platform === 'win32') {
    return [
      { cmd: 'cmd', args: ['/c', 'start', '', 'chrome', `--app=${url}`] },
      { cmd: 'cmd', args: ['/c', 'start', '', 'msedge', `--app=${url}`] },
      { cmd: 'cmd', args: ['/c', 'start', '', 'brave', `--app=${url}`] },
      { cmd: 'cmd', args: ['/c', 'start', '', 'chrome', '--new-window', url] },
      { cmd: 'cmd', args: ['/c', 'start', '', 'msedge', '--new-window', url] },
      { cmd: 'cmd', args: ['/c', 'start', '', 'brave', '--new-window', url] },
      { cmd: 'cmd', args: ['/c', 'start', '', 'firefox', '-new-window', url] },
      { cmd: 'cmd', args: ['/c', 'start', '', url] },
    ]
  }

  return [
    { cmd: 'google-chrome', args: [`--app=${url}`] },
    { cmd: 'chromium-browser', args: [`--app=${url}`] },
    { cmd: 'chromium', args: [`--app=${url}`] },
    { cmd: 'microsoft-edge', args: [`--app=${url}`] },
    { cmd: 'brave-browser', args: [`--app=${url}`] },
    { cmd: 'google-chrome', args: ['--new-window', url] },
    { cmd: 'chromium-browser', args: ['--new-window', url] },
    { cmd: 'chromium', args: ['--new-window', url] },
    { cmd: 'microsoft-edge', args: ['--new-window', url] },
    { cmd: 'brave-browser', args: ['--new-window', url] },
    { cmd: 'firefox', args: ['--new-window', url] },
    { cmd: 'xdg-open', args: [url] },
  ]
}

async function tryLaunchDetachedProcess(cmd: string, args: string[]): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
    })

    let done = false
    const finalize = (result: boolean) => {
      if (done) {
        return
      }

      done = true
      resolve(result)
    }

    child.once('error', () => finalize(false))
    child.unref()

    // If spawn succeeds and no immediate error is emitted, consider launch successful.
    setTimeout(() => finalize(true), 120)
  })
}

function waitForConnection(connectedPromise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Timed out waiting for browser connection after ${timeoutMs}ms.`))
    }, timeoutMs)

    connectedPromise
      .then(() => {
        clearTimeout(timeoutId)
        resolve()
      })
      .catch((error) => {
        clearTimeout(timeoutId)
        reject(error)
      })
  })
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

function isAddressInUseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return 'code' in error && error.code === 'EADDRINUSE'
}

function isFileNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return 'code' in error && error.code === 'ENOENT'
}

function createInitialDocument(envFileContent: string | null): EnvDocument {
  if (envFileContent === null) {
    return {
      entries: [],
      newline: '\n',
      endsWithNewline: false,
    }
  }

  return parseEnvFile(envFileContent)
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

type ParsedClientData = {
  type: string
  challenge: string
  origin: string
}

function parseClientData(clientDataBase64: string): ParsedClientData {
  const text = Buffer.from(clientDataBase64, 'base64').toString('utf8')
  const parsed = JSON.parse(text) as ParsedClientData

  if (!parsed || typeof parsed.type !== 'string' || typeof parsed.challenge !== 'string' || typeof parsed.origin !== 'string') {
    throw new SessionApiError(400, 'invalid_client_data', 'Invalid clientDataJSON payload.')
  }

  return parsed
}

function validateRegisterResponsePayload(payload: RegisterResponseRequest): void {
  if (!payload || typeof payload !== 'object') {
    throw new SessionApiError(400, 'invalid_registration_payload', 'Invalid registration payload.')
  }

  if (
    !payload.id ||
    !payload.publicKeySpki ||
    !payload.clientDataJSON ||
    !payload.attestationObject
  ) {
    throw new SessionApiError(
      400,
      'invalid_registration_payload',
      'id, publicKeySpki, clientDataJSON, and attestationObject are required.'
    )
  }
}

function validateUnlockResponsePayload(payload: UnlockResponseRequest): void {
  if (!payload || typeof payload !== 'object') {
    throw new SessionApiError(400, 'invalid_unlock_payload', 'Invalid unlock payload.')
  }

  if (
    !payload.id ||
    !payload.clientDataJSON ||
    !payload.authenticatorData ||
    !payload.signature
  ) {
    throw new SessionApiError(
      400,
      'invalid_unlock_payload',
      'id, clientDataJSON, authenticatorData, and signature are required.'
    )
  }
}

function verifyAuthenticatorData(authenticatorData: Buffer, rpId: string): number {
  if (authenticatorData.length < 37) {
    throw new SessionApiError(400, 'invalid_authenticator_data', 'Authenticator data is too short.')
  }

  const expectedRpIdHash = createHash('sha256').update(rpId, 'utf8').digest()
  const rpIdHash = authenticatorData.subarray(0, 32)

  if (!timingSafeEqual(rpIdHash, expectedRpIdHash)) {
    throw new SessionApiError(400, 'invalid_rp_id_hash', 'Authenticator RP ID hash mismatch.')
  }

  const flags = authenticatorData[32]
  const userVerified = (flags & 0x04) !== 0
  if (!userVerified) {
    throw new SessionApiError(400, 'user_verification_required', 'User verification flag not present.')
  }

  return authenticatorData.readUInt32BE(33)
}

function verifyWebAuthnAssertionSignature(
  publicKeySpkiBase64: string,
  authenticatorData: Buffer,
  clientDataJSONBase64: string,
  signatureBase64: string
): boolean {
  const publicKey = createPublicKey({
    key: decodeBase64(publicKeySpkiBase64),
    format: 'der',
    type: 'spki',
  })

  const clientDataHash = createHash('sha256').update(decodeBase64(clientDataJSONBase64)).digest()
  const signedData = Buffer.concat([authenticatorData, clientDataHash])
  const signature = decodeBase64(signatureBase64)

  return verifySignature('sha256', signedData, publicKey, signature)
}

function decodeBase64(value: string): Buffer {
  return Buffer.from(value, 'base64')
}

function toBase64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function wipeMasterKey(masterKey: Buffer | null): void {
  if (!masterKey) {
    return
  }

  masterKey.fill(0)
}

function completeSessionFromWindowClose(context: RequestContext): void {
  if (context.sessionCompleted) {
    return
  }

  if (context.mode === 'run' && context.runState && !context.runState.decided) {
    context.runState.decided = true
    context.onRunDecision?.(false)
  }

  context.onSessionComplete()
}
