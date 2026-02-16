# Key Backup and Import Feature Plan (MVP)

## Goal
Add a simple recovery path for the local master key:

- `rse key backup`: user can safely export the current master key for manual storage.
- `rse key import`: user can replace local key material from a previously exported key.

This plan prioritizes a minimal flow with clear warnings over full key lifecycle management.

## What We Want to Achieve

1. Let users back up the master key outside the app.
2. Let users import a backed-up key on the same or another machine.
3. Keep local security model intact:
   - WebAuthn approval is still required.
   - Master key stays local.
   - Persisted key is wrapped at rest, never stored plaintext on disk by default.
4. Make replacement risks explicit when a key already exists.

## Non-Goals (MVP)

- No multi-key keyring.
- No automatic re-encryption of existing `.env` files.
- No tracking of all `.env` files previously encrypted.
- No direct API integration with external password managers.

## User Experience

## 1) Backup Flow (`rse key backup`)

1. User runs `rse key backup`.
2. Local browser UI opens.
3. If needed, user completes WebAuthn unlock.
4. UI reveals export string for the current master key.
5. User can:
   - Copy key string (for password manager paste).
   - Download key file (plain text).
6. UI warns:
   - Anyone with this key can decrypt encrypted values.
   - Prefer storing in a password manager or offline secure location.

### Export format

Use a portable, versioned format, for example:

- `rse-mk-v1:<base64url-encoded-32-byte-key>`

Optional hardening (recommended):

- Add checksum suffix to catch typos.

## 2) Import Flow (`rse key import`)

1. User runs `rse key import`.
2. UI opens with two input options:
   - Paste key string.
   - Upload key file.
3. If an existing local key is detected:
   - Show high-visibility warning about replacement impact.
   - Offer a shortcut to run backup first.
   - Require explicit confirmation before replace.
4. Validate key format and length.
5. If valid, re-wrap imported key with local WebAuthn-derived KEK and save.
6. Show success and next-step warning to verify critical `.env` files.

## Warning for Existing Encrypted Files

Because current encrypted entries do not carry key identity and the app does not track encrypted `.env` files globally, replacing the master key can make previously encrypted values undecryptable with the new key.

MVP behavior:

- Warn clearly before import when an existing key is present.
- Recommend backing up current key first.
- Explain rollback path: re-import previous key backup if needed.

## Technical Approach

## CLI

- Extend command parsing in `src/cli/index.ts`:
  - `rse key backup`
  - `rse key import`
- Add usage/help text for new key commands.

## Session/UI

- Add dedicated session mode(s) for key management (or one mode with operation type).
- New UI screens:
  - Backup screen: reveal/copy/download key.
  - Import screen: paste/upload/confirm replace.

## Backend API (local Node session)

- Backup endpoint:
  - Requires valid token and unlocked session.
  - Returns export-formatted key string.
- Import endpoint:
  - Requires valid token and confirmation when replacing existing key.
  - Validates imported key.
  - Wraps imported key for local storage and writes state files.

## Storage

- Continue using existing local state path and wrapped-key file model.
- On import, overwrite wrapped key material with imported key (wrapped under local KEK).

## Security Requirements

- Never log plaintext master key.
- Never include plaintext master key in error messages.
- Keep plaintext key in memory only as long as needed.
- Clear sensitive buffers after use where possible.
- Require explicit user action before revealing/exporting key.

## Delivery Plan

1. CLI plumbing
   - Add `key` subcommands and help output.
2. Backup path
   - Backend endpoint + UI reveal/copy/download.
3. Import path
   - Backend endpoint + UI paste/upload + replace confirmation.
4. Validation and safety
   - Format checks, clear warnings, buffer wiping.
5. Documentation and tests
   - Update root docs and add unit/integration coverage.

## Acceptance Criteria

1. User can export current master key via `rse key backup`.
2. User can import a valid backup key via `rse key import`.
3. Import requires explicit confirmation when replacing an existing key.
4. Post-import key is persisted wrapped and usable for decrypt/encrypt flows.
5. Warnings clearly describe risk to existing encrypted `.env` files.
