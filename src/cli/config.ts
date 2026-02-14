import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const DEFAULT_UI_PORT = 47653
const MIN_PORT = 1024
const MAX_PORT = 65535

type PersistedConfig = {
  uiPort?: number
}

export type CliConfig = {
  uiPort: number
}

export function getConfigDirPath(): string {
  const overrideDir = process.env.RSE_CONFIG_DIR
  if (overrideDir) {
    return path.resolve(overrideDir)
  }

  const home = homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'rest-safe-env')
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData) {
      return path.join(appData, 'rest-safe-env')
    }

    return path.join(home, 'AppData', 'Roaming', 'rest-safe-env')
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, 'rest-safe-env')
  }

  return path.join(home, '.config', 'rest-safe-env')
}

export function getConfigFilePath(): string {
  return path.join(getConfigDirPath(), 'config.json')
}

export async function loadCliConfig(): Promise<CliConfig> {
  const configPath = getConfigFilePath()

  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw) as PersistedConfig
    const persistedPort = parsed.uiPort

    if (isValidPort(persistedPort)) {
      return { uiPort: persistedPort }
    }

    return { uiPort: DEFAULT_UI_PORT }
  } catch (error) {
    if (isMissingFileError(error)) {
      return { uiPort: DEFAULT_UI_PORT }
    }

    throw error
  }
}

export async function setUiPort(uiPort: number): Promise<CliConfig> {
  validatePort(uiPort)

  const dirPath = getConfigDirPath()
  const configPath = getConfigFilePath()

  await mkdir(dirPath, { recursive: true })
  await writeFile(configPath, JSON.stringify({ uiPort }, null, 2) + '\n', 'utf8')

  return { uiPort }
}

export async function clearCliState(): Promise<string> {
  const configDir = getConfigDirPath()
  await rm(configDir, { recursive: true, force: true })
  return configDir
}

export function parseAndValidatePort(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
    throw new Error(`Port must be an integer between ${MIN_PORT} and ${MAX_PORT}.`)
  }

  validatePort(parsed)
  return parsed
}

function validatePort(uiPort: number): void {
  if (!isValidPort(uiPort)) {
    throw new Error(`Port must be between ${MIN_PORT} and ${MAX_PORT}.`)
  }
}

function isValidPort(uiPort: unknown): uiPort is number {
  return typeof uiPort === 'number' && Number.isInteger(uiPort) && uiPort >= MIN_PORT && uiPort <= MAX_PORT
}

function isMissingFileError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return 'code' in error && error.code === 'ENOENT'
}
