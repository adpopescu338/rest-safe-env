import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  clearCliState,
  getConfigFilePath,
  loadCliConfig,
  parseAndValidatePort,
  setUiPort,
} from './config'
import {
  decodeEnvValue,
  ENCRYPTED_PREFIX,
  formatParsedEntriesForDebug,
  parseEnvFile,
  serializeEnvDocument,
  type EnvDocument,
} from './env-parser'
import { decryptEnvValue } from './env-crypto'
import { startUiSession } from './ui-session'

type ViewArgs = {
  type: 'view'
  envFilePathArg?: string
  verbose: boolean
}

type ImportArgs = {
  type: 'import'
  envFilePathArg?: string
  verbose: boolean
}

type RunArgs = {
  type: 'run'
  envFilePathArg?: string
  command: string[]
  verbose: boolean
}

type ConfigPortArgs = {
  type: 'config-port'
  portArg?: string
  verbose: boolean
}

type CleanupArgs = {
  type: 'cleanup'
  verbose: boolean
}

type HelpTopic = 'general' | 'view' | 'import' | 'run' | 'config' | 'cleanup'

type HelpArgs = {
  type: 'help'
  topic: HelpTopic
}

type VersionArgs = {
  type: 'version'
}

type ParsedCliArgs =
  | ViewArgs
  | ImportArgs
  | RunArgs
  | ConfigPortArgs
  | CleanupArgs
  | HelpArgs
  | VersionArgs

const HELP_FLAGS = new Set(['-h', '--help'])
const VERSION_FLAGS = new Set(['-v', '--version'])
const PACKAGE_JSON_PATH_CANDIDATES = [
  fileURLToPath(new URL('../package.json', import.meta.url)),
  fileURLToPath(new URL('../../package.json', import.meta.url)),
]

async function main(): Promise<void> {
  try {
    const args = parseCliArgs(process.argv.slice(2))

    if (args.type === 'help') {
      printUsage(args.topic)
      return
    }

    if (args.type === 'version') {
      console.log(await getCliVersion())
      return
    }

    if (args.type === 'view') {
      await handleViewCommand(args.envFilePathArg, args.verbose)
      return
    }

    if (args.type === 'import') {
      await handleImportCommand(args.envFilePathArg, args.verbose)
      return
    }

    if (args.type === 'run') {
      const exitCode = await handleRunCommand(args.envFilePathArg, args.command)
      process.exitCode = exitCode
      return
    }

    if (args.type === 'cleanup') {
      await handleCleanupCommand()
      return
    }

    await handleConfigPortCommand(args.portArg)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    printUsage('general', true)
    process.exitCode = 1
  }
}

function extractVerboseFlag(args: string[]): { filteredArgs: string[]; verbose: boolean } {
  const filteredArgs: string[] = []
  let verbose = false

  for (const arg of args) {
    if (arg === '--verbose') {
      verbose = true
      continue
    }

    filteredArgs.push(arg)
  }

  return { filteredArgs, verbose }
}

function parseCliArgs(argv: string[]): ParsedCliArgs {
  if (argv.length === 0) {
    throw new Error('Missing command.')
  }

  const [command, ...rest] = argv

  if (isHelpFlag(command) && rest.length === 0) {
    return {
      type: 'help',
      topic: 'general',
    }
  }

  if (isVersionFlag(command) && rest.length === 0) {
    return {
      type: 'version',
    }
  }

  if (command === 'view') {
    if (isSingleHelpFlag(rest)) {
      return {
        type: 'help',
        topic: 'view',
      }
    }

    const { filteredArgs, verbose } = extractVerboseFlag(rest)
    if (filteredArgs.length > 1) {
      throw new Error('`rse view` accepts at most one env file path.')
    }

    return {
      type: 'view',
      envFilePathArg: filteredArgs[0],
      verbose,
    }
  }

  if (command === 'run') {
    if (isSingleHelpFlag(rest)) {
      return {
        type: 'help',
        topic: 'run',
      }
    }

    const separatorIndex = rest.indexOf('--')

    if (separatorIndex === -1) {
      throw new Error('`rse run` requires `-- <command...>`.')
    }

    const beforeSeparator = rest.slice(0, separatorIndex)
    const commandParts = rest.slice(separatorIndex + 1)
    const { filteredArgs, verbose } = extractVerboseFlag(beforeSeparator)

    if (filteredArgs.length > 1) {
      throw new Error('`rse run` accepts at most one env file path before `--`.')
    }

    if (commandParts.length === 0) {
      throw new Error('Missing child command after `--`.')
    }

    return {
      type: 'run',
      envFilePathArg: filteredArgs[0],
      command: commandParts,
      verbose,
    }
  }

  if (command === 'import') {
    if (isSingleHelpFlag(rest)) {
      return {
        type: 'help',
        topic: 'import',
      }
    }

    const { filteredArgs, verbose } = extractVerboseFlag(rest)
    if (filteredArgs.length > 1) {
      throw new Error('`rse import` accepts at most one env file path.')
    }

    return {
      type: 'import',
      envFilePathArg: filteredArgs[0],
      verbose,
    }
  }

  if (command === 'config') {
    if (isSingleHelpFlag(rest)) {
      return {
        type: 'help',
        topic: 'config',
      }
    }

    const { filteredArgs, verbose } = extractVerboseFlag(rest)
    if (filteredArgs[0] !== 'port') {
      throw new Error('Usage: rse config port [port] [--verbose]')
    }

    if (filteredArgs.length > 2) {
      throw new Error('Usage: rse config port [port] [--verbose]')
    }

    return {
      type: 'config-port',
      portArg: filteredArgs[1],
      verbose,
    }
  }

  if (command === 'cleanup') {
    if (isSingleHelpFlag(rest)) {
      return {
        type: 'help',
        topic: 'cleanup',
      }
    }

    const { filteredArgs, verbose } = extractVerboseFlag(rest)
    if (filteredArgs.length > 0) {
      throw new Error('Usage: rse cleanup [--verbose]')
    }

    return {
      type: 'cleanup',
      verbose,
    }
  }

  throw new Error(`Unknown command: ${command}`)
}

function isSingleHelpFlag(args: string[]): boolean {
  return args.length === 1 && isHelpFlag(args[0])
}

function isHelpFlag(value: string): boolean {
  return HELP_FLAGS.has(value)
}

function isVersionFlag(value: string): boolean {
  return VERSION_FLAGS.has(value)
}

async function getCliVersion(): Promise<string> {
  for (const packageJsonPath of PACKAGE_JSON_PATH_CANDIDATES) {
    try {
      const raw = await readFile(packageJsonPath, 'utf8')
      const packageJson = JSON.parse(raw) as { version?: string }
      if (packageJson.version) {
        return packageJson.version
      }
    } catch {
      continue
    }
  }

  return 'unknown'
}

async function handleViewCommand(envFilePathArg: string | undefined, verbose: boolean): Promise<void> {
  const envPath = await resolveEnvPath(envFilePathArg)
  const envContent = await readEnvFileIfExists(envPath)
  const config = await loadCliConfig()

  if (!envContent) {
    console.log(`[rse] env file not found: ${envPath}`)
    console.log(`[rse] starting local UI session on localhost:${config.uiPort} (mode=view)`)
    await startUiSession({
      mode: 'view',
      port: config.uiPort,
      envFilePath: envPath,
      envFileContent: null,
    })
    console.log('[rse] browser connected to local session.')
    return
  }

  console.log(`[rse] loaded env file: ${envPath}`)
  if (verbose) {
    const parsed = parseEnvFile(envContent)
    const roundTrip = serializeEnvDocument(parsed)
    console.log(
      `[rse] lossless parser round-trip check: ${roundTrip === envContent ? 'ok' : 'mismatch'}`
    )
    console.log('[rse] parsed entries (debug):')
    console.log(formatParsedEntriesForDebug(parsed.entries))
  }
  console.log(`[rse] starting local UI session on localhost:${config.uiPort} (mode=view)`)
  await startUiSession({
    mode: 'view',
    port: config.uiPort,
    envFilePath: envPath,
    envFileContent: envContent,
  })
  console.log('[rse] browser connected to local session.')
}

async function handleImportCommand(envFilePathArg: string | undefined, verbose: boolean): Promise<void> {
  const envPath = await resolveEnvPath(envFilePathArg)
  const envContent = await readEnvFileIfExists(envPath)
  const config = await loadCliConfig()

  if (envContent) {
    console.log(`[rse] loaded env file: ${envPath}`)
    if (verbose) {
      const parsed = parseEnvFile(envContent)
      const roundTrip = serializeEnvDocument(parsed)
      console.log(
        `[rse] lossless parser round-trip check: ${roundTrip === envContent ? 'ok' : 'mismatch'}`
      )
      console.log('[rse] parsed entries (debug):')
      console.log(formatParsedEntriesForDebug(parsed.entries))
    }
  } else {
    console.log(`[rse] env file not found: ${envPath}`)
  }

  console.log(`[rse] starting local UI session on localhost:${config.uiPort} (mode=import)`)
  await startUiSession({
    mode: 'import',
    port: config.uiPort,
    envFilePath: envPath,
    envFileContent: envContent,
  })
  console.log('[rse] browser connected to local session.')
}

async function handleRunCommand(
  envFilePathArg: string | undefined,
  command: string[]
): Promise<number> {
  const envPath = await resolveEnvPath(envFilePathArg)
  const envContent = await readEnvFileIfExists(envPath)
  const config = await loadCliConfig()

  if (!envContent) {
    console.log(`[rse] env file not found: ${envPath}; running command unchanged.`)
    return spawnChild(command)
  }

  const parsed = parseEnvFile(envContent)
  const containsEncryptedValues = hasEncryptedEntries(parsed)

  if (!containsEncryptedValues) {
    const childEnv = buildChildEnv(parsed, null)
    return spawnChild(command, childEnv)
  }

  console.log(`[rse] encrypted values detected in ${envPath}; approval is required.`)
  console.log(`[rse] starting local UI session on localhost:${config.uiPort} (mode=run)`)

  const runSession = await startUiSession({
    mode: 'run',
    port: config.uiPort,
    commandDisplay: command.join(' '),
    envFilePath: envPath,
    encryptedEntryCount: countEncryptedEntries(parsed),
  })

  if (runSession.mode !== 'run') {
    throw new Error('Invalid run session result.')
  }

  if (!runSession.approved) {
    console.error('[rse] run was denied.')
    return 1
  }

  if (!runSession.unlockedMasterKey) {
    console.error('[rse] run approval completed without unlocked key.')
    return 1
  }

  const unlockedMasterKey = runSession.unlockedMasterKey
  try {
    const childEnv = buildChildEnv(parsed, unlockedMasterKey)
    return await spawnChild(command, childEnv)
  } finally {
    wipeMasterKey(unlockedMasterKey)
  }
}

async function handleConfigPortCommand(portArg?: string): Promise<void> {
  if (!portArg) {
    const config = await loadCliConfig()
    console.log(`[rse] configured UI port: ${config.uiPort}`)
    console.log(`[rse] config file: ${getConfigFilePath()}`)
    return
  }

  const newPort = parseAndValidatePort(portArg)
  const updated = await setUiPort(newPort)
  console.log(`[rse] updated UI port: ${updated.uiPort}`)
  console.log(`[rse] config file: ${getConfigFilePath()}`)
}

async function handleCleanupCommand(): Promise<void> {
  const clearedDir = await clearCliState()
  console.log(`[rse] cleared local state: ${clearedDir}`)
  console.log('[rse] registration, wrapped master key, counters, and cli config were removed.')
}

async function resolveEnvPath(envFilePathArg?: string): Promise<string> {
  if (!envFilePathArg) {
    return path.resolve(process.cwd(), '.env')
  }

  const candidatePath = path.resolve(process.cwd(), envFilePathArg)
  try {
    const candidateStats = await stat(candidatePath)
    if (candidateStats.isDirectory()) {
      return path.join(candidatePath, '.env')
    }

    return candidatePath
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return candidatePath
    }

    throw error
  }
}

async function readEnvFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null
    }

    throw error
  }
}

function isFileNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return 'code' in error && error.code === 'ENOENT'
}

function hasEncryptedEntries(document: EnvDocument): boolean {
  return document.entries.some(
    (entry) => entry.type === 'pair' && entry.rawValue.startsWith(ENCRYPTED_PREFIX)
  )
}

function countEncryptedEntries(document: EnvDocument): number {
  return document.entries.filter(
    (entry) => entry.type === 'pair' && entry.rawValue.startsWith(ENCRYPTED_PREFIX)
  ).length
}

function buildChildEnv(document: EnvDocument, masterKey: Buffer | null): NodeJS.ProcessEnv {
  const envFromFile: Record<string, string> = {}

  for (const entry of document.entries) {
    if (entry.type !== 'pair') {
      continue
    }

    if (entry.rawValue.startsWith(ENCRYPTED_PREFIX)) {
      if (!masterKey) {
        throw new Error(`Missing unlocked key for encrypted env key: ${entry.key}`)
      }

      envFromFile[entry.key] = decryptEnvValue(entry.rawValue, entry.key, masterKey)
      continue
    }

    envFromFile[entry.key] = decodeEnvValue(entry.rawValue)
  }

  return {
    ...process.env,
    ...envFromFile,
  }
}

function spawnChild(command: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: 'inherit',
      env,
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`[rse] child process terminated by signal ${signal}`)
        resolve(1)
        return
      }

      resolve(code ?? 1)
    })
  })
}

function wipeMasterKey(masterKey: Buffer | null): void {
  if (!masterKey) {
    return
  }

  masterKey.fill(0)
}

function printUsage(topic: HelpTopic = 'general', toError = false): void {
  const write = toError ? console.error : console.log

  if (topic === 'view') {
    write('Usage:')
    write('  rse view [envFilePath] [--verbose]')
    return
  }

  if (topic === 'import') {
    write('Usage:')
    write('  rse import [envFilePath] [--verbose]')
    return
  }

  if (topic === 'run') {
    write('Usage:')
    write('  rse run [envFilePath] [--verbose] -- <command...>')
    return
  }

  if (topic === 'config') {
    write('Usage:')
    write('  rse config port [port] [--verbose]')
    return
  }

  if (topic === 'cleanup') {
    write('Usage:')
    write('  rse cleanup [--verbose]')
    return
  }

  write('Usage:')
  write('  rse view [envFilePath] [--verbose]')
  write('  rse import [envFilePath] [--verbose]')
  write('  rse run [envFilePath] [--verbose] -- <command...>')
  write('  rse config port [port] [--verbose]')
  write('  rse cleanup [--verbose]')
  write('')
  write('Flags:')
  write('  -h, --help     Show help')
  write('  -v, --version  Show CLI version')
}

void main()
