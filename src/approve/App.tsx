import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type {
  DecryptEnvValueRequest,
  DecryptEnvValueResponse,
  EditableEntry,
  EnvEntry,
  GetEnvResponse,
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
} from '../shared/protocol'
import {
  buildEncryptedShareBlob,
  decryptShareBlob,
  generateImportSessionKey,
  type ImportSessionKey,
} from './share-crypto'
import Button from '../ui/Button'
import './App.css'

type SaveAttemptResult = {
  ok: boolean
  errorCode?: string
  message?: string
}

type DecryptAttemptResult = {
  ok: boolean
  value?: string
  errorCode?: string
  message?: string
}

type ShareSnapshotResult = {
  ok: boolean
  entries?: ShareSnapshotEntry[]
  errorCode?: string
  message?: string
}

type EditorPairEntry = {
  type: 'pair'
  key: string
  value: string
  encrypt: boolean
  sourceIndex: number | null
  preserveEncrypted: boolean
  preservePlainRaw: boolean
}

type EditorCommentEntry = {
  type: 'comment'
  text: string
  sourceIndex: number | null
}

type EditorBlankEntry = {
  type: 'blank'
  sourceIndex: number | null
}

type EditorEntry = EditorPairEntry | EditorCommentEntry | EditorBlankEntry

function App() {
  const searchParams = useMemo(() => new URLSearchParams(window.location.search), [])
  const token = useMemo(() => searchParams.get('token') ?? '', [searchParams])
  const sessionMode = useMemo(() => searchParams.get('mode') ?? 'view', [searchParams])
  const isImportMode = sessionMode === 'import'
  const [entries, setEntries] = useState<EditorEntry[]>([])
  const [initialEntries, setInitialEntries] = useState<EditorEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isSharing, setIsSharing] = useState(false)
  const [isSharePanelOpen, setIsSharePanelOpen] = useState(false)
  const [receiverPublicKeyInput, setReceiverPublicKeyInput] = useState('')
  const [shareBlobOutput, setShareBlobOutput] = useState('')
  const [unlockingEntryIndex, setUnlockingEntryIndex] = useState<number | null>(null)
  const [importSessionKey, setImportSessionKey] = useState<ImportSessionKey | null>(null)
  const [importBlobInput, setImportBlobInput] = useState('')
  const [isImporting, setIsImporting] = useState(false)
  const [hasImportedPayload, setHasImportedPayload] = useState(!isImportMode)
  const [statusText, setStatusText] = useState('')
  const [errorText, setErrorText] = useState('')
  const [snackbarText, setSnackbarText] = useState('')
  const snackbarTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (isImportMode) {
      setIsLoading(false)
      return
    }

    void loadEntries(token, setEntries, setInitialEntries, setErrorText, setIsLoading)
  }, [isImportMode, token])

  useEffect(() => {
    if (!isImportMode) {
      return
    }

    let cancelled = false

    void generateImportSessionKey()
      .then((sessionKey) => {
        if (cancelled) {
          return
        }

        setImportSessionKey(sessionKey)
      })
      .catch((error) => {
        if (cancelled) {
          return
        }

        const message = error instanceof Error ? error.message : 'Failed to generate import key.'
        setErrorText(message)
      })

    return () => {
      cancelled = true
    }
  }, [isImportMode])

  useEffect(() => {
    return () => {
      if (snackbarTimerRef.current !== null) {
        window.clearTimeout(snackbarTimerRef.current)
      }
    }
  }, [])

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

  const hasChanges = JSON.stringify(entries) !== JSON.stringify(initialEntries)

  function updateEntry(index: number, nextEntry: EditorEntry): void {
    setEntries((prev) => {
      const next = [...prev]
      next[index] = nextEntry
      return next
    })
  }

  function deleteEntry(index: number): void {
    setEntries((prev) => prev.filter((_, currentIndex) => currentIndex !== index))
    setStatusText('')
    setErrorText('')
  }

  function addPairEntry(): void {
    setEntries((prev) => [
      ...prev,
      {
        type: 'pair',
        key: 'NEW_KEY',
        value: '',
        encrypt: false,
        sourceIndex: null,
        preserveEncrypted: false,
        preservePlainRaw: false,
      },
    ])
    setStatusText('')
    setErrorText('')
  }

  function addCommentEntry(): void {
    setEntries((prev) => [...prev, { type: 'comment', text: '# new comment', sourceIndex: null }])
    setStatusText('')
    setErrorText('')
  }

  function addBlankEntry(): void {
    setEntries((prev) => [...prev, { type: 'blank', sourceIndex: null }])
    setStatusText('')
    setErrorText('')
  }

  function onRevert(): void {
    setEntries(cloneEditorEntries(initialEntries))
    setStatusText('Reverted unsaved changes.')
    setErrorText('')
  }

  async function onUnlockEncryptedValue(index: number): Promise<void> {
    if (!token) {
      return
    }

    const entry = entries[index]
    if (
      !entry ||
      entry.type !== 'pair' ||
      !entry.encrypt ||
      !entry.preserveEncrypted ||
      entry.sourceIndex === null
    ) {
      return
    }

    setUnlockingEntryIndex(index)
    setStatusText('Preparing decryption access...')
    setErrorText('')

    try {
      await ensureEncryptionReady(token)
      let decryptAttempt = await requestDecryptedValue(token, entry.sourceIndex, entry.key)
      if (
        !decryptAttempt.ok &&
        (decryptAttempt.errorCode === 'registration_required' ||
          decryptAttempt.errorCode === 'unlock_required')
      ) {
        await ensureEncryptionReady(token)
        decryptAttempt = await requestDecryptedValue(token, entry.sourceIndex, entry.key)
      }

      if (!decryptAttempt.ok || decryptAttempt.value === undefined) {
        throw new Error(decryptAttempt.message ?? decryptAttempt.errorCode ?? 'Failed to decrypt value.')
      }

      updateEntry(index, {
        ...entry,
        value: decryptAttempt.value,
        preserveEncrypted: false,
        preservePlainRaw: false,
      })
      setStatusText('Encrypted value unlocked and ready for editing.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to decrypt value.'
      setErrorText(message)
    } finally {
      setUnlockingEntryIndex(null)
    }
  }

  async function onSave(): Promise<void> {
    if (!hasChanges) {
      return
    }

    setIsSaving(true)
    setStatusText('')
    setErrorText('')

    try {
      const needsEncryptionSetup = hasPendingEncryptionOperation(entries)
      if (needsEncryptionSetup) {
        setStatusText('Preparing encryption access...')
        await ensureEncryptionReady(token)
      }

      let saveAttempt = await sendSaveRequest(token, entries)
      if (
        !saveAttempt.ok &&
        (saveAttempt.errorCode === 'registration_required' || saveAttempt.errorCode === 'unlock_required')
      ) {
        setStatusText('Preparing encryption access...')
        await ensureEncryptionReady(token)
        saveAttempt = await sendSaveRequest(token, entries)
      }

      if (!saveAttempt.ok) {
        throw new Error(saveAttempt.message ?? saveAttempt.errorCode ?? 'Save failed.')
      }

      const snapshot = cloneEditorEntries(entries)
      setInitialEntries(snapshot)
      setEntries(cloneEditorEntries(snapshot))
      setStatusText('Saved successfully.')
      attemptWindowClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Save failed.'
      setErrorText(message)
    } finally {
      setIsSaving(false)
    }
  }

  async function onShare(): Promise<void> {
    if (!token) {
      return
    }

    if (!receiverPublicKeyInput.trim()) {
      setErrorText('Receiver public key is required before sharing.')
      return
    }

    setIsSharing(true)
    setStatusText('Preparing share payload...')
    setErrorText('')

    try {
      let snapshotAttempt = await requestShareSnapshot(token)
      if (
        !snapshotAttempt.ok &&
        (snapshotAttempt.errorCode === 'registration_required' || snapshotAttempt.errorCode === 'unlock_required')
      ) {
        await ensureEncryptionReady(token)
        snapshotAttempt = await requestShareSnapshot(token)
      }

      if (!snapshotAttempt.ok || !snapshotAttempt.entries) {
        throw new Error(snapshotAttempt.message ?? snapshotAttempt.errorCode ?? 'Failed to create share payload.')
      }

      const shareBlob = await buildEncryptedShareBlob(receiverPublicKeyInput, snapshotAttempt.entries)
      setShareBlobOutput(shareBlob)
      setStatusText('Share blob generated. Send it to the receiver.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create share payload.'
      setErrorText(message)
    } finally {
      setIsSharing(false)
    }
  }

  async function onImportBlob(): Promise<void> {
    if (!isImportMode || !token) {
      return
    }

    if (!importSessionKey) {
      setErrorText('Import key is not ready yet.')
      return
    }

    if (!importBlobInput.trim()) {
      setErrorText('Paste encrypted share blob before importing.')
      return
    }

    setIsImporting(true)
    setStatusText('Decrypting shared payload...')
    setErrorText('')

    try {
      const importedSnapshotEntries = await decryptShareBlob(importBlobInput, importSessionKey.privateKey)
      const importedEditorEntries = importedSnapshotEntries.map(toEditorEntryFromSharedPayload)
      setEntries(importedEditorEntries)
      setInitialEntries([])
      setHasImportedPayload(true)
      setStatusText('Shared payload imported. Review and Save to write to env file.')
      setImportBlobInput('')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to import payload.'
      setErrorText(message)
    } finally {
      setIsImporting(false)
    }
  }

  function onCopyText(value: string, label: string): void {
    void copyToClipboard(value)
      .then(() => {
        setErrorText('')
        setSnackbarText(`${label} copied`)
        if (snackbarTimerRef.current !== null) {
          window.clearTimeout(snackbarTimerRef.current)
        }
        snackbarTimerRef.current = window.setTimeout(() => {
          setSnackbarText('')
          snackbarTimerRef.current = null
        }, 1200)
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to copy to clipboard.'
        setErrorText(message)
      })
  }

  const snackbarNode = snackbarText ? (
    <div className="copy-snackbar" role="status" aria-live="polite">
      {snackbarText}
    </div>
  ) : null

  if (isLoading) {
    return (
      <main className="editor-shell">
        <h1>rest-safe-env Editor</h1>
        <p>{isImportMode ? 'Preparing import session...' : 'Loading env entries...'}</p>
      </main>
    )
  }

  if (isImportMode && !hasImportedPayload) {
    return (
      <main className="editor-shell">
        <header className="editor-header">
          <h1>rest-safe-env Import</h1>
          <p>Send this public key to the sender, then paste the encrypted blob below.</p>
        </header>

        {errorText && <p className="error-text">{errorText}</p>}
        {statusText && <p className="status-text">{statusText}</p>}

        <section className="share-panel">
          <p className="share-label">Public key (send to sender)</p>
          <textarea className="share-textarea" value={importSessionKey?.publicKeyText ?? ''} readOnly rows={3} />
          <div className="share-actions">
            <Button
              type="button"
              disabled={!importSessionKey}
              onClick={() => {
                if (!importSessionKey) {
                  return
                }

                onCopyText(importSessionKey.publicKeyText, 'Public key')
              }}
            >
              Copy Public Key
            </Button>
          </div>
          <p className="share-label">Receiver command</p>
          <div className="code-with-action">
            <code>rse import</code>
            <Button
              type="button"
              onClick={() => {
                onCopyText('rse import', 'Command')
              }}
            >
              Copy
            </Button>
          </div>
          <p className="share-label">Encrypted blob</p>
          <textarea
            className="share-textarea"
            value={importBlobInput}
            onChange={(event) => setImportBlobInput(event.target.value)}
            placeholder="Paste the encrypted blob from sender..."
            rows={8}
          />
          <div className="share-actions">
            <Button type="button" disabled={isImporting || !importSessionKey} onClick={() => void onImportBlob()}>
              {isImporting ? 'Importing...' : 'Import Blob'}
            </Button>
          </div>
        </section>
        {snackbarNode}
      </main>
    )
  }

  return (
    <main className="editor-shell">
      <header className="editor-header">
        <h1>{isImportMode ? 'rest-safe-env Import Review' : 'rest-safe-env Editor'}</h1>
        <p>Edit plaintext values and unlock encrypted rows only when you need to modify them.</p>
      </header>

      {errorText && <p className="error-text">{errorText}</p>}
      {statusText && <p className="status-text">{statusText}</p>}

      <section className="entry-list" aria-label="env entries">
        {entries.map((entry, index) => {
          if (entry.type === 'blank') {
            return (
              <div className="entry-row blank-row" key={`blank-${index}`}>
                <span className="blank-label">(blank line)</span>
                <Button type="button" className="row-action" onClick={() => deleteEntry(index)}>
                  Delete
                </Button>
              </div>
            )
          }

          if (entry.type === 'comment') {
            return (
              <div className="entry-row" key={`comment-${index}`}>
                <label className="row-label">Comment</label>
                <input
                  className="text-input"
                  value={entry.text}
                  onChange={(event) =>
                    updateEntry(index, {
                      ...entry,
                      text: normalizeCommentText(event.target.value),
                    })
                  }
                />
                <Button type="button" className="row-action" onClick={() => deleteEntry(index)}>
                  Delete
                </Button>
              </div>
            )
          }

          const isMaskedEncrypted = entry.encrypt && entry.preserveEncrypted

          return (
            <div className="entry-row pair-row" key={`pair-${index}`}>
              <label className="row-label">Key</label>
              <input
                className="text-input key-input"
                value={entry.key}
                disabled={isMaskedEncrypted}
                onChange={(event) =>
                    updateEntry(index, {
                      ...entry,
                      key: event.target.value,
                      preservePlainRaw: false,
                    })
                  }
                />

              <label className="row-label">Value</label>
              <input
                className="text-input value-input"
                value={isMaskedEncrypted ? '•••••••• (encrypted)' : entry.value}
                disabled={isMaskedEncrypted}
                onChange={(event) =>
                    updateEntry(index, {
                      ...entry,
                      value: event.target.value,
                      preservePlainRaw: false,
                    })
                  }
                />

              <label className="encrypt-checkbox">
                <input
                  type="checkbox"
                  checked={entry.encrypt}
                  disabled={isMaskedEncrypted}
                  onChange={(event) =>
                    updateEntry(index, {
                      ...entry,
                      encrypt: event.target.checked,
                      preserveEncrypted: false,
                      preservePlainRaw: false,
                    })
                  }
                />
                Encrypt
              </label>

              {isMaskedEncrypted ? (
                <Button
                  type="button"
                  className="row-action unlock-action"
                  disabled={unlockingEntryIndex === index || isSaving}
                  onClick={() => void onUnlockEncryptedValue(index)}
                >
                  {unlockingEntryIndex === index ? 'Unlocking...' : 'Unlock'}
                </Button>
              ) : null}

              <Button type="button" className="row-action" onClick={() => deleteEntry(index)} disabled={isSaving}>
                Delete
              </Button>
            </div>
          )
        })}
      </section>

      <section className="add-actions">
        <Button type="button" onClick={addPairEntry} disabled={isSaving}>
          Add Pair
        </Button>
        <Button type="button" onClick={addCommentEntry} disabled={isSaving}>
          Add Comment
        </Button>
        <Button type="button" onClick={addBlankEntry} disabled={isSaving}>
          Add Blank
        </Button>
      </section>

      {!isImportMode && isSharePanelOpen ? (
        <section className="share-panel">
          <div className="share-actions">
            <p className="share-label">Share with another machine</p>
            <Button type="button" onClick={() => setIsSharePanelOpen(false)} disabled={isSharing}>
              Close
            </Button>
          </div>
          <p className="share-help">
            Ask receiver to run <code>rse import</code>, paste their public key below, then generate an encrypted share blob.
          </p>
          <div className="code-with-action">
            <code>rse import</code>
            <Button
              type="button"
              onClick={() => {
                onCopyText('rse import', 'Command')
              }}
            >
              Copy
            </Button>
          </div>
          <textarea
            className="share-textarea"
            value={receiverPublicKeyInput}
            onChange={(event) => {
              setReceiverPublicKeyInput(event.target.value)
              setShareBlobOutput('')
            }}
            placeholder="Paste receiver public key here..."
            rows={3}
          />
          <div className="share-actions">
            <Button type="button" disabled={isSharing || isSaving} onClick={() => void onShare()}>
              {isSharing ? 'Generating...' : 'Share'}
            </Button>
          </div>
          <textarea
            className="share-textarea"
            value={shareBlobOutput}
            readOnly
            placeholder="Encrypted blob will appear here."
            rows={8}
          />
          <div className="share-actions">
            <Button
              type="button"
              disabled={!shareBlobOutput}
              onClick={() => {
                if (!shareBlobOutput) {
                  return
                }
                onCopyText(shareBlobOutput, 'Share blob')
              }}
            >
              Copy Blob
            </Button>
          </div>
        </section>
      ) : null}

      <footer className="editor-actions">
        {!isImportMode ? (
          <Button
            type="button"
            onClick={() => setIsSharePanelOpen((prev) => !prev)}
            disabled={isSaving || isSharing}
          >
            {isSharePanelOpen ? 'Hide Share' : 'Share'}
          </Button>
        ) : null}
        <Button type="button" onClick={onRevert} disabled={!hasChanges || isSaving}>
          Revert
        </Button>
        <Button type="button" onClick={() => void onSave()} disabled={!hasChanges || isSaving}>
          {isSaving ? 'Saving...' : 'Save'}
        </Button>
      </footer>
      {snackbarNode}
    </main>
  )
}

async function loadEntries(
  token: string,
  setEntries: Dispatch<SetStateAction<EditorEntry[]>>,
  setInitialEntries: Dispatch<SetStateAction<EditorEntry[]>>,
  setErrorText: Dispatch<SetStateAction<string>>,
  setIsLoading: Dispatch<SetStateAction<boolean>>
): Promise<void> {
  try {
    if (!token) {
      throw new Error('Missing token in URL.')
    }

    const healthResponse = await fetch('/api/health', {
      headers: {
        'x-rse-token': token,
      },
    })

    if (!healthResponse.ok) {
      throw new Error(`Health check failed with status ${healthResponse.status}`)
    }

    const envResponse = await fetch('/api/env', {
      headers: {
        'x-rse-token': token,
      },
    })

    if (!envResponse.ok) {
      throw new Error(`Failed to load env entries with status ${envResponse.status}`)
    }

    const payload = (await envResponse.json()) as GetEnvResponse
    const editable = payload.entries.map(toEditorEntry)
    const snapshot = cloneEditorEntries(editable)

    setInitialEntries(snapshot)
    setEntries(cloneEditorEntries(snapshot))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load env entries.'
    setErrorText(message)
  } finally {
    setIsLoading(false)
  }
}

function toEditorEntry(entry: EnvEntry, index: number): EditorEntry {
  if (entry.type === 'blank') {
    return { type: 'blank', sourceIndex: index }
  }

  if (entry.type === 'comment') {
    return { type: 'comment', text: entry.text, sourceIndex: index }
  }

  if (entry.value.kind === 'encrypted') {
    return {
      type: 'pair',
      key: entry.key,
      value: '',
      encrypt: true,
      sourceIndex: index,
      preserveEncrypted: true,
      preservePlainRaw: false,
    }
  }

  return {
    type: 'pair',
    key: entry.key,
    value: entry.value.value,
    encrypt: false,
    sourceIndex: index,
    preserveEncrypted: false,
    preservePlainRaw: true,
  }
}

function cloneEditorEntries(entries: EditorEntry[]): EditorEntry[] {
  return entries.map((entry) => {
    if (entry.type === 'blank') {
      return { type: 'blank', sourceIndex: entry.sourceIndex }
    }

    if (entry.type === 'comment') {
      return {
        type: 'comment',
        text: entry.text,
        sourceIndex: entry.sourceIndex,
      }
    }

    return {
      type: 'pair',
      key: entry.key,
      value: entry.value,
      encrypt: entry.encrypt,
      sourceIndex: entry.sourceIndex,
      preserveEncrypted: entry.preserveEncrypted,
      preservePlainRaw: entry.preservePlainRaw,
    }
  })
}

function toSaveEntry(entry: EditorEntry): EditableEntry {
  if (entry.type === 'blank') {
    return { type: 'blank' }
  }

  if (entry.type === 'comment') {
    return { type: 'comment', text: entry.text }
  }

  return {
    type: 'pair',
    key: entry.key,
    value: entry.value,
    encrypt: entry.encrypt,
    sourceIndex: entry.sourceIndex ?? undefined,
    preserveEncrypted: entry.preserveEncrypted,
    preservePlainRaw: entry.preservePlainRaw,
  }
}

function toEditorEntryFromSharedPayload(entry: ShareSnapshotEntry): EditorEntry {
  if (entry.type === 'blank') {
    return { type: 'blank', sourceIndex: null }
  }

  if (entry.type === 'comment') {
    return { type: 'comment', text: entry.text, sourceIndex: null }
  }

  return {
    type: 'pair',
    key: entry.key,
    value: entry.value,
    encrypt: entry.encrypt,
    sourceIndex: null,
    preserveEncrypted: false,
    preservePlainRaw: false,
  }
}

async function sendSaveRequest(token: string, entries: EditorEntry[]): Promise<SaveAttemptResult> {
  const payload: SaveEnvRequest = { entries: entries.map(toSaveEntry) }
  const response = await fetch('/api/env', {
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

    return {
      ok: false,
      errorCode: errorBody?.error,
      message: errorBody?.message ?? errorBody?.error ?? `Save failed with status ${response.status}`,
    }
  }

  const parsed = (await response.json()) as SaveEnvResponse
  if (!parsed.ok) {
    return {
      ok: false,
      message: 'Save failed.',
    }
  }

  return { ok: true }
}

async function requestShareSnapshot(token: string): Promise<ShareSnapshotResult> {
  const response = await fetch('/api/share/snapshot', {
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
      message:
        errorBody?.message ?? errorBody?.error ?? `Share snapshot failed with status ${response.status}`,
    }
  }

  const parsed = (await response.json()) as ShareSnapshotResponse
  return { ok: true, entries: parsed.entries }
}

async function requestDecryptedValue(
  token: string,
  sourceIndex: number,
  key: string
): Promise<DecryptAttemptResult> {
  const payload: DecryptEnvValueRequest = { sourceIndex, key }
  const response = await fetch('/api/env/decrypt', {
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

    return {
      ok: false,
      errorCode: errorBody?.error,
      message: errorBody?.message ?? errorBody?.error ?? `Decrypt failed with status ${response.status}`,
    }
  }

  const parsed = (await response.json()) as DecryptEnvValueResponse
  return {
    ok: true,
    value: parsed.value,
  }
}

async function runRegistration(token: string): Promise<void> {
  if (!window.PublicKeyCredential || !navigator.credentials) {
    throw new Error('WebAuthn is not available in this browser.')
  }

  const requestResponse = await fetch('/api/register/request', {
    method: 'POST',
    headers: {
      'x-rse-token': token,
    },
  })

  if (!requestResponse.ok) {
    const errorBody = (await requestResponse.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null
    throw new Error(errorBody?.message ?? errorBody?.error ?? 'Failed to start registration.')
  }

  const requestBody = (await requestResponse.json()) as
    | RegisterRequestResponse
    | { ok: true; alreadyRegistered: true }

  if ('alreadyRegistered' in requestBody && requestBody.alreadyRegistered) {
    return
  }

  const registrationRequest = requestBody as RegisterRequestResponse

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: base64ToArrayBuffer(registrationRequest.challenge),
      rp: {
        name: 'rest-safe-env',
        id: registrationRequest.rpId,
      },
      user: {
        id: base64ToArrayBuffer(registrationRequest.user.id),
        name: registrationRequest.user.name,
        displayName: registrationRequest.user.name,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      timeout: 60000,
      authenticatorSelection: {
        userVerification: 'required',
      },
      attestation: 'none',
      extensions: {
        prf: {
          eval: {
            first: base64ToArrayBuffer(registrationRequest.prfSalt),
          },
        },
      },
    },
  })) as PublicKeyCredential | null

  if (!credential) {
    throw new Error('Registration was cancelled.')
  }

  const attestationResponse = credential.response as AuthenticatorAttestationResponse
  const extensionResults = credential.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } }
  }
  const prfOutput = extensionResults.prf?.results?.first

  const publicKeyBuffer = getRegistrationPublicKey(attestationResponse)

  const payload: RegisterResponseRequest = {
    id: credential.id,
    publicKeySpki: arrayBufferToBase64(publicKeyBuffer),
    clientDataJSON: arrayBufferToBase64(attestationResponse.clientDataJSON),
    attestationObject: arrayBufferToBase64(attestationResponse.attestationObject),
    prfOutput: prfOutput ? arrayBufferToBase64(prfOutput) : undefined,
  }

  const response = await fetch('/api/register/response', {
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
    throw new Error(errorBody?.message ?? errorBody?.error ?? 'Registration failed.')
  }

  const parsed = (await response.json()) as RegisterResponse
  if (!parsed.ok) {
    throw new Error('Registration failed.')
  }
}

type UnlockTicket =
  | { kind: 'already_unlocked' }
  | { kind: 'ticket'; data: UnlockRequestResponse }

async function ensureEncryptionReady(token: string): Promise<void> {
  const firstAttempt = await requestUnlockTicket(token)
  if (firstAttempt.kind === 'already_unlocked') {
    return
  }

  await runUnlock(token, firstAttempt.data)
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

    if (errorBody?.error === 'registration_required') {
      await runRegistration(token)
      return requestUnlockTicket(token)
    }

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

  const assertionCredential = (await navigator.credentials.get({
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

  if (!assertionCredential) {
    throw new Error('Unlock was cancelled.')
  }

  const assertionResponse = assertionCredential.response as AuthenticatorAssertionResponse
  const extensionResults = assertionCredential.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } }
  }

  const prfOutput = extensionResults.prf?.results?.first

  const payload: UnlockResponseRequest = {
    id: assertionCredential.id,
    clientDataJSON: arrayBufferToBase64(assertionResponse.clientDataJSON),
    authenticatorData: arrayBufferToBase64(assertionResponse.authenticatorData),
    signature: arrayBufferToBase64(assertionResponse.signature),
    userHandle: assertionResponse.userHandle
      ? arrayBufferToBase64(assertionResponse.userHandle)
      : undefined,
    prfOutput: prfOutput ? arrayBufferToBase64(prfOutput) : undefined,
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

function getRegistrationPublicKey(attestationResponse: AuthenticatorAttestationResponse): ArrayBuffer {
  const withPublicKey = attestationResponse as AuthenticatorAttestationResponse & {
    getPublicKey?: () => ArrayBuffer | null
  }

  const publicKey = withPublicKey.getPublicKey?.()
  if (!publicKey) {
    throw new Error('Authenticator did not provide a public key for server verification.')
  }

  return publicKey
}

function hasPendingEncryptionOperation(entries: EditorEntry[]): boolean {
  return entries.some(
    (entry) => entry.type === 'pair' && entry.encrypt && !entry.preserveEncrypted
  )
}

function normalizeCommentText(value: string): string {
  const leadingWhitespaceMatch = value.match(/^(\s*)(.*)$/)
  const leadingWhitespace = leadingWhitespaceMatch?.[1] ?? ''
  const remainder = leadingWhitespaceMatch?.[2] ?? value

  if (remainder.startsWith('#')) {
    return `${leadingWhitespace}${remainder}`
  }

  if (remainder.length === 0) {
    return `${leadingWhitespace}# `
  }

  return `${leadingWhitespace}# ${remainder}`
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

async function copyToClipboard(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard API is unavailable in this browser.')
  }

  await navigator.clipboard.writeText(value)
}

export default App
