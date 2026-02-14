# rest-safe-env Technical Details

This document covers architecture, security model, development workflow, and packaging/distribution.

## Runtime Requirements

- Node.js 20+
- Browser with:
  - WebAuthn (`PublicKeyCredential`)
  - User verification support (biometric/passkey/platform authenticator)
  - PRF extension support (`prf` / `hmac-secret` path)
- Local loopback networking available (`127.0.0.1`)
- WebAuthn origin/RP checks served on `http://localhost:<port>`

If PRF is unavailable, plaintext editing can still work, but encrypted operations fail with explicit errors.

## Developer Setup

```bash
yarn install
yarn build
yarn lint
```

Useful scripts from `package.json`:

- `yarn dev` - Vite dev mode
- `yarn build` - TS build + UI build + CLI bundle
- `yarn lint` - ESLint
- `yarn test:parser` - parser round-trip fixtures
- `yarn demo-tsx` / `yarn demo-node` - demo run flows
- `yarn link-rse` / `yarn relink-rse` - local global linking

## CLI Commands

- `rse view [envFilePath]`
- `rse import [envFilePath]`
- `rse run [envFilePath] -- <command...>`
- `rse config port [port]`
- `rse cleanup`

Path behavior:

- missing path => `./.env`
- directory path => `<dir>/.env`

## Architecture

- CLI entry: `src/cli/index.ts`
- Local UI session server: `src/cli/ui-session.ts`
- Single HTML entrypoint: `session.html`
- Session router: `src/session/App.tsx` (`view`, `import`, `run`)
- View/import UI: `src/approve/App.tsx`
- Run approval UI: `src/manage/App.tsx`
- Shared API types: `src/shared/protocol.ts`

### Session Modes

- `view`: edit `.env`
- `import`: receive encrypted blob and load entries for save
- `run`: approve/deny decryption for child command execution

### Session Lifecycle

- Token-gated session URL and token-checked APIs
- Browser launch preference:
  - Chromium app mode (`--app=<url>`)
  - new-window fallback
  - normal open fallback
- Long-lived stream endpoint (`/api/session/stream`) + ping/beacon fallback
- Closing run window is treated as deny

## Env Parser and Data Model

Parser goals:

- preserve line order
- preserve comments/blank lines
- preserve duplicate keys
- preserve raw values when unchanged (including quotes)

Entry model includes:

- `pair`
- `comment`
- `blank`

Quoted values are decoded for UI/runtime behavior while raw formatting can be preserved on no-op edits.

## Security and Crypto Model

### At-Rest Value Encryption

- Prefix: `enc:v1:`
- Cipher: AES-256-GCM
- Nonce: random 12 bytes per value
- AAD: `rse:v1:<KEY_NAME>`
- Cipher payload layout: `[version][nonce][ciphertext][tag]` (base64 encoded)

### Master Key and Unlock

- One local master key per install
- Master key stored wrapped
- KEK derived from WebAuthn PRF output
- Unlock verifies WebAuthn challenge/origin/type/RP hash/UV/signature/sign counter
- Decryption performed server-side (Node), not browser-side

### Local State Paths

Stored in app config directory:

- macOS: `~/Library/Application Support/rest-safe-env/`
- Linux: `~/.config/rest-safe-env/` (or `$XDG_CONFIG_HOME/rest-safe-env/`)
- Windows: `%APPDATA%/rest-safe-env/`

Main files:

- `config.json`
- `credential.json`
- `wrapped-master-key.json`

## Share / Import Protocol

Goal: CLI remains stateless for transfer key agreement; browser session handles ephemeral key material.

- Receiver (`rse import`) generates ephemeral browser ECDH key pair
- Receiver sends public key to sender
- Sender (`rse view`) generates encrypted share blob from all lines + metadata
- Receiver pastes blob, decrypts in browser, loads into editor
- Receiver saves; encrypted-marked entries are re-encrypted with receiver's local registration/unlock mechanism

Current envelope:

- ECDH: P-256
- KDF: HKDF-SHA256
- Cipher: AES-256-GCM
- Armored prefixes:
  - public key: `rse-import-pub:v1:`
  - share blob: `rse-share:v1:`

## Packaging and Distribution

### npm package metadata

`package.json` includes:

- `repository`, `homepage`, `bugs`
- `bin: { "rse": "bin/rse.js" }`
- `files` allowlist (`bin`, `dist`, `LICENSE`, `README.md`)
- `prepack` hook to build `dist` before publish

### Publish flow (npm)

1. Ensure package is publishable (`private` must be `false` before publishing).
2. Bump version.
3. Publish:

```bash
npm publish
```

After publish, users can install globally:

```bash
npm install -g rest-safe-env
```

### Homebrew custom tap

Formula generator script:

```bash
yarn brew:formula
```

Options:

- `--version <x.y.z>`
- `--output <path>`
- `--tap-dir <local tap clone path>`
- `--formula-name <name.rb>`
- `--alias <alias>`

Example (sync directly into local tap clone and create alias `rse`):

```bash
yarn brew:formula -- --tap-dir ../homebrew-tap
```

Expected tap files:

- `Formula/rest-safe-env.rb`
- `Aliases/rse`

Install for users:

```bash
brew tap adpopescu338/tap
brew install rest-safe-env
# or
brew install rse
```

## Repo Layout

- `src/cli` - CLI, local server, credential/crypto integration
- `src/session` - mode router for UI
- `src/approve` - view/import editor UI
- `src/manage` - run approval UI
- `src/shared` - API types
- `demo/` - runnable demo files
- `tests/` - parser fixture tests

## Scope Notes

- Focused on local dev protection for secrets at rest
- Not a defense against full machine compromise
- Future hardening can include app-layer encrypted localhost transport
