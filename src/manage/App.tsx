import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import type {
  RunApproveResponse,
  RunContextResponse,
  RunDenyResponse,
  UnlockRequestResponse,
  UnlockResponse,
  UnlockResponseRequest,
} from '../shared/protocol'
import Button from '../ui/Button'
import './App.css'

type UnlockTicket =
  | { kind: 'already_unlocked' }
  | { kind: 'ticket'; data: UnlockRequestResponse }

function App() {
  const token = useMemo(() => new URLSearchParams(window.location.search).get('token') ?? '', [])
  const [context, setContext] = useState<RunContextResponse | null>(null)
  const [statusText, setStatusText] = useState(token ? 'Connecting...' : 'Missing token.')
  const [errorText, setErrorText] = useState('')
  const [isBusy, setIsBusy] = useState(false)

  useEffect(() => {
    if (!token) {
      return
    }

    void loadRunContext(token, setContext, setStatusText, setErrorText)
  }, [token])

  useEffect(() => {
    if (!token) {
      return
    }

    const closeSessionStream = openSessionStream(token, () => {
      attemptWindowClose()
    })
    const intervalId = window.setInterval(() => {
      void sendSessionPing(token).then((ok) => {
        if (!ok) {
          attemptWindowClose()
        }
      })
    }, 3000)

    const onPageHide = () => {
      notifySessionClosed(token)
    }

    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('beforeunload', onPageHide)

    return () => {
      closeSessionStream?.()
      window.clearInterval(intervalId)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('beforeunload', onPageHide)
    }
  }, [token])

  async function onApprove(): Promise<void> {
    if (!token || !context) {
      return
    }

    setIsBusy(true)
    setErrorText('')

    try {
      setStatusText('Preparing approval...')

      if (context.requiresUnlock) {
        await ensureUnlockReady(token)
      }

      let result = await approveRun(token)
      if (!result.ok && result.errorCode === 'unlock_required') {
        await ensureUnlockReady(token)
        result = await approveRun(token)
      }

      if (!result.ok) {
        throw new Error(result.message ?? result.errorCode ?? 'Approval failed.')
      }

      setStatusText('Approved. Command execution can continue.')
      attemptWindowClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Approval failed.'
      setErrorText(message)
      setStatusText('Approval failed.')
    } finally {
      setIsBusy(false)
    }
  }

  async function onDeny(): Promise<void> {
    if (!token) {
      return
    }

    setIsBusy(true)
    setErrorText('')

    try {
      const response = await fetch('/api/run/deny', {
        method: 'POST',
        headers: {
          'x-rse-token': token,
        },
      })

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as
          | { error?: string; message?: string }
          | null
        throw new Error(errorBody?.message ?? errorBody?.error ?? 'Deny failed.')
      }

      const parsed = (await response.json()) as RunDenyResponse
      if (parsed.approved !== false) {
        throw new Error('Deny failed.')
      }

      setStatusText('Denied. Command will not be executed.')
      attemptWindowClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Deny failed.'
      setErrorText(message)
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <main className="approval-shell">
      <h1>Approve Decryption</h1>
      {context ? (
        <>
          <p>
            Approve decryption of <code>{context.envFilePath}</code>
          </p>
          <p>
            for command <code>{context.command}</code>
          </p>
          <p>
            encrypted values detected: <strong>{context.encryptedEntryCount}</strong>
          </p>
        </>
      ) : (
        <p>Loading run context...</p>
      )}

      <p className="status-text">{statusText}</p>
      {errorText && <p className="error-text">{errorText}</p>}

      <div className="actions">
        <Button type="button" onClick={() => void onApprove()} disabled={isBusy || !context}>
          Approve
        </Button>
        <Button type="button" onClick={() => void onDeny()} disabled={isBusy}>
          Deny
        </Button>
      </div>
    </main>
  )
}

async function loadRunContext(
  token: string,
  setContext: Dispatch<SetStateAction<RunContextResponse | null>>,
  setStatusText: Dispatch<SetStateAction<string>>,
  setErrorText: Dispatch<SetStateAction<string>>
): Promise<void> {
  try {
    const healthResponse = await fetch('/api/health', {
      headers: {
        'x-rse-token': token,
      },
    })

    if (!healthResponse.ok) {
      throw new Error(`Health check failed with status ${healthResponse.status}`)
    }

    const runContextResponse = await fetch('/api/run/context', {
      headers: {
        'x-rse-token': token,
      },
    })

    if (!runContextResponse.ok) {
      throw new Error(`Failed to load run context with status ${runContextResponse.status}`)
    }

    const runContext = (await runContextResponse.json()) as RunContextResponse
    setContext(runContext)
    setStatusText('Awaiting decision...')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load run context.'
    setErrorText(message)
    setStatusText('Unable to continue.')
  }
}

async function approveRun(token: string): Promise<{ ok: boolean; errorCode?: string; message?: string }> {
  const response = await fetch('/api/run/approve', {
    method: 'POST',
    headers: {
      'x-rse-token': token,
    },
  })

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null

    return {
      ok: false,
      errorCode: errorBody?.error,
      message: errorBody?.message ?? errorBody?.error ?? `Approve failed with status ${response.status}`,
    }
  }

  const parsed = (await response.json()) as RunApproveResponse
  if (parsed.approved !== true) {
    return {
      ok: false,
      message: 'Approve failed.',
    }
  }

  return { ok: true }
}

async function ensureUnlockReady(token: string): Promise<void> {
  const ticket = await requestUnlockTicket(token)
  if (ticket.kind === 'already_unlocked') {
    return
  }

  await runUnlock(token, ticket.data)
}

async function requestUnlockTicket(token: string): Promise<UnlockTicket> {
  const response = await fetch('/api/unlock/request', {
    method: 'POST',
    headers: {
      'x-rse-token': token,
    },
  })

  if (response.status === 409) {
    const errorBody = (await response.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null
    throw new Error(errorBody?.message ?? errorBody?.error ?? 'Unlock is not available.')
  }

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null
    throw new Error(errorBody?.message ?? errorBody?.error ?? 'Failed to request unlock.')
  }

  const body = (await response.json()) as UnlockRequestResponse | { ok: true; alreadyUnlocked: true }
  if ('alreadyUnlocked' in body && body.alreadyUnlocked) {
    return { kind: 'already_unlocked' }
  }

  return { kind: 'ticket', data: body as UnlockRequestResponse }
}

async function runUnlock(token: string, ticket: UnlockRequestResponse): Promise<void> {
  if (!window.PublicKeyCredential || !navigator.credentials) {
    throw new Error('WebAuthn is not available in this browser.')
  }

  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: base64ToArrayBuffer(ticket.challenge),
      timeout: ticket.timeoutMs,
      rpId: ticket.rpId,
      userVerification: 'required',
      allowCredentials: [
        {
          id: base64ToArrayBuffer(ticket.credentialId),
          type: 'public-key',
        },
      ],
      extensions: {
        prf: {
          eval: {
            first: base64ToArrayBuffer(ticket.prfSalt),
          },
        },
      },
    },
  })) as PublicKeyCredential | null

  if (!credential) {
    throw new Error('Unlock was cancelled.')
  }

  const assertionResponse = credential.response as AuthenticatorAssertionResponse
  const extensionResults = credential.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } }
  }

  const prfOutput = extensionResults.prf?.results?.first
  if (!prfOutput) {
    throw new Error('This authenticator does not support PRF output required by rest-safe-env.')
  }

  const payload: UnlockResponseRequest = {
    id: credential.id,
    clientDataJSON: arrayBufferToBase64(assertionResponse.clientDataJSON),
    authenticatorData: arrayBufferToBase64(assertionResponse.authenticatorData),
    signature: arrayBufferToBase64(assertionResponse.signature),
    userHandle: assertionResponse.userHandle
      ? arrayBufferToBase64(assertionResponse.userHandle)
      : undefined,
    prfOutput: arrayBufferToBase64(prfOutput),
  }

  const response = await fetch('/api/unlock/response', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-rse-token': token,
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null
    throw new Error(errorBody?.message ?? errorBody?.error ?? 'Unlock failed.')
  }

  const parsed = (await response.json()) as UnlockResponse
  if (!parsed.ok) {
    throw new Error('Unlock failed.')
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/')
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  const binary = atob(normalized + padding)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function arrayBufferToBase64(input: ArrayBuffer): string {
  const bytes = new Uint8Array(input)
  let binary = ''

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index])
  }

  return btoa(binary)
}

function attemptWindowClose(): void {
  window.setTimeout(() => {
    window.close()
  }, 120)
}

function openSessionStream(token: string, onDisconnect: () => void): (() => void) | null {
  if (typeof window.EventSource === 'undefined') {
    return null
  }

  const stream = new EventSource(`/api/session/stream?token=${encodeURIComponent(token)}`)
  let closed = false
  let checking = false

  stream.onerror = () => {
    if (closed || checking) {
      return
    }

    checking = true
    void isSessionServerAlive(token)
      .then((alive) => {
        if (!alive && !closed) {
          onDisconnect()
        }
      })
      .finally(() => {
        checking = false
      })
  }

  return () => {
    closed = true
    stream.close()
  }
}

async function isSessionServerAlive(token: string): Promise<boolean> {
  try {
    const response = await fetch('/api/health', {
      method: 'GET',
      headers: {
        'x-rse-token': token,
      },
      cache: 'no-store',
    })
    return response.ok
  } catch {
    return false
  }
}

async function sendSessionPing(token: string): Promise<boolean> {
  try {
    const response = await fetch('/api/session/ping', {
      method: 'POST',
      headers: {
        'x-rse-token': token,
      },
      keepalive: true,
    })
    return response.ok
  } catch {
    return false
  }
}

function notifySessionClosed(token: string): void {
  const closeUrl = `/api/session/closed?token=${encodeURIComponent(token)}`

  if (navigator.sendBeacon) {
    navigator.sendBeacon(closeUrl, 'closed')
    return
  }

  void fetch(closeUrl, {
    method: 'POST',
    keepalive: true,
  }).catch(() => null)
}

export default App
