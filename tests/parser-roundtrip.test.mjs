import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const fixtureDir = path.resolve('tests/fixtures/env-roundtrip')
const parserSourcePath = path.resolve('src/cli/env-parser.ts')

test('env parser fixtures round-trip with no diff', async () => {
  const parserModule = await loadParserModule()
  const fixtureNames = (await readdir(fixtureDir))
    .filter((name) => name.endsWith('.env'))
    .sort()

  assert.ok(fixtureNames.length > 0, 'expected at least one fixture')

  for (const fixtureName of fixtureNames) {
    const fixturePath = path.join(fixtureDir, fixtureName)
    const content = await readFile(fixturePath, 'utf8')

    const parsed = parserModule.parseEnvFile(content)
    const serialized = parserModule.serializeEnvDocument(parsed)

    assert.equal(
      serialized,
      content,
      `round-trip mismatch for fixture ${fixtureName}`
    )
  }
})

test('encrypted prefix detection is preserved in parsed entries', async () => {
  const parserModule = await loadParserModule()
  const fixturePath = path.join(fixtureDir, 'duplicates-and-encrypted.env')
  const content = await readFile(fixturePath, 'utf8')
  const parsed = parserModule.parseEnvFile(content)

  const encryptedPair = parsed.entries.find(
    (entry) => entry.type === 'pair' && entry.key === 'TOKEN'
  )

  assert.ok(encryptedPair, 'expected TOKEN pair entry to exist')
  assert.equal(encryptedPair.encrypted, true)
  assert.equal(encryptedPair.rawValue.startsWith('enc:v1:'), true)
})

test('decodeEnvValue handles quoted values', async () => {
  const parserModule = await loadParserModule()

  assert.equal(parserModule.decodeEnvValue('plain-value'), 'plain-value')
  assert.equal(parserModule.decodeEnvValue('"hello world"'), 'hello world')
  assert.equal(parserModule.decodeEnvValue("'single quoted'"), 'single quoted')
  assert.equal(parserModule.decodeEnvValue('"line\\nnext"'), 'line\nnext')
  assert.equal(parserModule.decodeEnvValue('"tab\\tsep"'), 'tab\tsep')
  assert.equal(parserModule.decodeEnvValue('"say: \\"hi\\""'), 'say: "hi"')
})

async function loadParserModule() {
  const parserSource = await readFile(parserSourcePath, 'utf8')
  const transpiled = ts.transpileModule(parserSource, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: parserSourcePath,
  })

  const tempDir = await mkdtemp(path.join(tmpdir(), 'rse-parser-test-'))
  const tempFilePath = path.join(tempDir, 'env-parser.mjs')

  await writeFile(tempFilePath, transpiled.outputText, 'utf8')

  try {
    return await import(pathToFileURL(tempFilePath).href)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}
