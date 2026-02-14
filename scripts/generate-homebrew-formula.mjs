#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptFilePath = fileURLToPath(import.meta.url)
const scriptsDirPath = path.dirname(scriptFilePath)
const repoRootPath = path.resolve(scriptsDirPath, '..')

const args = parseArgs(process.argv.slice(2))

const packageJsonPath = path.join(repoRootPath, 'package.json')
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))

const packageName = typeof packageJson.name === 'string' ? packageJson.name : 'rest-safe-env'
const version = args.version ?? packageJson.version
if (!version || typeof version !== 'string') {
  throw new Error('Unable to determine package version.')
}

const formulaFileName = args.formulaName ?? `${stripScope(packageName)}.rb`
const formulaClassName = toFormulaClassName(stripScope(packageName))
const outputFormulaPath = args.output ? path.resolve(repoRootPath, args.output) : null

const npmMetadataUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName).replaceAll(
  '%40',
  '@'
)}/${version}`
const npmMetadataResponse = await fetch(npmMetadataUrl)
if (!npmMetadataResponse.ok) {
  throw new Error(
    `Failed to fetch npm metadata for ${packageName}@${version}. Publish to npm first. URL: ${npmMetadataUrl}`
  )
}

const npmMetadata = await npmMetadataResponse.json()
const tarballUrl = npmMetadata?.dist?.tarball
if (typeof tarballUrl !== 'string' || tarballUrl.length === 0) {
  throw new Error(`No dist.tarball found for ${packageName}@${version}.`)
}

const tarballResponse = await fetch(tarballUrl)
if (!tarballResponse.ok) {
  throw new Error(`Failed to download npm tarball: ${tarballUrl}`)
}

const tarballBuffer = Buffer.from(await tarballResponse.arrayBuffer())
const tarballSha256 = createHash('sha256').update(tarballBuffer).digest('hex')

const homepage = deriveHomepage(packageJson)
const desc =
  typeof packageJson.description === 'string' && packageJson.description.length > 0
    ? packageJson.description
    : `${packageName} CLI`
const license = typeof packageJson.license === 'string' ? packageJson.license : 'MIT'

const formulaContents = renderFormula({
  className: formulaClassName,
  desc,
  homepage,
  url: tarballUrl,
  sha256: tarballSha256,
  license,
  binName: 'rse',
})

if (outputFormulaPath) {
  await mkdir(path.dirname(outputFormulaPath), { recursive: true })
  await writeFile(outputFormulaPath, formulaContents, 'utf8')
  console.log(`[rse] wrote Homebrew formula: ${outputFormulaPath}`)
} else if (!args.tapDir) {
  const defaultOutputFormulaPath = path.resolve(repoRootPath, path.join('brew', 'Formula', formulaFileName))
  await mkdir(path.dirname(defaultOutputFormulaPath), { recursive: true })
  await writeFile(defaultOutputFormulaPath, formulaContents, 'utf8')
  console.log(`[rse] wrote Homebrew formula: ${defaultOutputFormulaPath}`)
}

if (args.tapDir) {
  const tapDirPath = path.resolve(repoRootPath, args.tapDir)
  const tapFormulaPath = path.join(tapDirPath, 'Formula', formulaFileName)
  await mkdir(path.dirname(tapFormulaPath), { recursive: true })
  await writeFile(tapFormulaPath, formulaContents, 'utf8')
  console.log(`[rse] synced formula to tap: ${tapFormulaPath}`)

  const aliasName = args.alias ?? 'rse'
  const aliasDirPath = path.join(tapDirPath, 'Aliases')
  const aliasPath = path.join(aliasDirPath, aliasName)
  await mkdir(aliasDirPath, { recursive: true })
  await rm(aliasPath, { force: true })
  await symlink(`../Formula/${formulaFileName}`, aliasPath)
  console.log(`[rse] wrote tap alias: ${aliasPath} -> ../Formula/${formulaFileName}`)
}

console.log('[rse] next steps:')
console.log('  1) commit formula changes in your tap repository')
console.log('  2) push the tap repository')
console.log('  3) install with: brew tap <owner>/tap && brew install rest-safe-env')

function parseArgs(argv) {
  /** @type {{ version?: string, output?: string, tapDir?: string, formulaName?: string, alias?: string }} */
  const parsed = {}

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--version') {
      parsed.version = argv[index + 1]
      index += 1
      continue
    }

    if (arg === '--output') {
      parsed.output = argv[index + 1]
      index += 1
      continue
    }

    if (arg === '--tap-dir') {
      parsed.tapDir = argv[index + 1]
      index += 1
      continue
    }

    if (arg === '--formula-name') {
      parsed.formulaName = argv[index + 1]
      index += 1
      continue
    }

    if (arg === '--alias') {
      parsed.alias = argv[index + 1]
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return parsed
}

function stripScope(packageName) {
  const slashIndex = packageName.lastIndexOf('/')
  if (slashIndex === -1) {
    return packageName
  }

  return packageName.slice(slashIndex + 1)
}

function deriveHomepage(packageJson) {
  if (typeof packageJson.homepage === 'string' && packageJson.homepage.length > 0) {
    return packageJson.homepage
  }

  const repositoryUrl =
    typeof packageJson.repository?.url === 'string' ? packageJson.repository.url : undefined
  if (!repositoryUrl) {
    return ''
  }

  return repositoryUrl.replace(/\.git$/, '')
}

function toFormulaClassName(packageName) {
  return packageName
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('')
}

function escapeRubyString(input) {
  return input.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function renderFormula({ className, desc, homepage, url, sha256, license, binName }) {
  return `class ${className} < Formula
  desc "${escapeRubyString(desc)}"
  homepage "${escapeRubyString(homepage)}"
  url "${escapeRubyString(url)}"
  sha256 "${sha256}"
  license "${escapeRubyString(license)}"

  depends_on "node"

  def install
    source_dir = Dir.exist?("package") ? "package" : "."
    libexec.install Dir["#{source_dir}/*"]
    bin.install_symlink libexec/"bin/${escapeRubyString(binName)}.js" => "${escapeRubyString(
      binName
    )}"
  end

  test do
    output = shell_output("#{bin}/${escapeRubyString(binName)} 2>&1", 1)
    assert_match "Usage:", output
  end
end
`
}
