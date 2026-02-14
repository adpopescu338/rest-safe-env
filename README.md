# rest-safe-env

`rest-safe-env` protects `.env` secrets at rest. It lets you encrypt selected values and only decrypts locally after explicit user approval in a browser UI.

## Purpose

This project is built to reduce two common risks:

1. Malware scanning plaintext `.env` files.
2. Accidental secret leakage to LLM tooling (for example by including `.env` content in context or allowing tool-driven `.env` reads).

## Features

- Env editor with full line-preserving behavior (order, comments, blank lines, duplicate keys).
- Per-value at-rest encryption for `.env` entries.
- Approval-gated `run` mode for commands that need encrypted values.
- Import/share flow between machines using an encrypted transfer blob.
- Local-only UI server with fixed configurable port.

## Installation

### npm (global)

```bash
npm install -g rest-safe-env
```

Then use:

```bash
rse --help
```

### Homebrew (custom tap)

```bash
brew tap adpopescu338/tap
brew install rest-safe-env
# alias also available:
brew install rse
```

## Usage

```bash
rse view [envFilePath]
rse import [envFilePath]
rse run [envFilePath] -- <command...>
rse config port [port]
rse cleanup
```

Notes:

- If `envFilePath` is omitted, `./.env` is used.
- If a directory is provided, `/.env` inside that directory is used.

## Technical Details

See `TECHNICAL.md` for architecture, crypto internals, development workflow, and packaging/release details.
