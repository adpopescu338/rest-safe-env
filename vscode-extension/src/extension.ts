import path from 'node:path'
import * as vscode from 'vscode'

const COMMAND_ID = 'restSafeEnv.viewEnv'
const TERMINAL_NAME = 'rest-safe-env'

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(COMMAND_ID, async (resource?: vscode.Uri) => {
    const selectedUri = resolveTargetUri(resource)
    if (!selectedUri) {
      void vscode.window.showWarningMessage(
        'No file selected. Right-click an .env file in Explorer and choose "View with rest-safe-env".'
      )
      return
    }

    if (selectedUri.scheme !== 'file') {
      void vscode.window.showErrorMessage('rest-safe-env only supports local files.')
      return
    }

    const filePath = selectedUri.fsPath
    const fileName = path.basename(filePath)
    if (!isEnvLikeFileName(fileName)) {
      const proceed = await vscode.window.showWarningMessage(
        `Selected file "${fileName}" does not look like an .env file. Continue anyway?`,
        { modal: false },
        'Continue'
      )
      if (proceed !== 'Continue') {
        return
      }
    }

    const command = `rse view ${quoteForShell(filePath)}`
    const terminal = getOrCreateTerminal(TERMINAL_NAME)
    terminal.show(true)
    terminal.sendText(command, true)
  })

  context.subscriptions.push(disposable)
}

export function deactivate(): void {}

function resolveTargetUri(resource?: vscode.Uri): vscode.Uri | undefined {
  if (resource) {
    return resource
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri
  return activeUri
}

function getOrCreateTerminal(name: string): vscode.Terminal {
  const existing = vscode.window.terminals.find((terminal) => terminal.name === name)
  if (existing) {
    return existing
  }

  return vscode.window.createTerminal({ name })
}

function isEnvLikeFileName(fileName: string): boolean {
  return fileName === '.env' || fileName.startsWith('.env.')
}

function quoteForShell(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '""')}"`
  }

  return `'${value.replace(/'/g, `'\\''`)}'`
}
