# rest-safe-env VS Code extension

This extension adds a right-click Explorer action for `.env` files:

- `View with rest-safe-env`

It runs this command in the integrated terminal:

```bash
rse view <selected-file>
```

## What is `rse`?

`rse` is the CLI for **rest-safe-env**, a tool that encrypts selected `.env` values at rest and unlocks them only after explicit local browser approval.

- GitHub: https://github.com/adpopescu338/rest-safe-env
- npm: https://www.npmjs.com/package/rest-safe-env

## Requirement

This extension expects `rse` to already be installed and available on your `PATH`.

Install with npm:

```bash
npm install -g rest-safe-env
```

Or install with Homebrew:

```bash
brew tap adpopescu338/tap
brew install rest-safe-env
```

## Local development

```bash
cd vscode-extension
npm install
npm run devhost
```

## Package VSIX

```bash
cd vscode-extension
npm run package:vsix
```

## Publish to Marketplace

```bash
cd vscode-extension
npx @vscode/vsce login adpopescu338
npm run publish
```
