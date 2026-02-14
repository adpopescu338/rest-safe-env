export const ENCRYPTED_PREFIX = 'enc:v1:'

export type PairEntry = {
  type: 'pair'
  key: string
  rawValue: string
  leadingWhitespace: string
  spacingBeforeEquals: string
  spacingAfterEquals: string
  encrypted: boolean
}

export type CommentEntry = {
  type: 'comment'
  text: string
}

export type BlankEntry = {
  type: 'blank'
  whitespace: string
}

export type EnvEntry = PairEntry | CommentEntry | BlankEntry

export type EnvDocument = {
  entries: EnvEntry[]
  newline: '\n' | '\r\n'
  endsWithNewline: boolean
}

const PAIR_LINE_PATTERN = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)=(\s*)(.*)$/
const COMMENT_LINE_PATTERN = /^\s*#/
const BLANK_LINE_PATTERN = /^\s*$/

export function parseEnvFile(content: string): EnvDocument {
  const newline: '\n' | '\r\n' = content.includes('\r\n') ? '\r\n' : '\n'
  const endsWithNewline = content.endsWith('\n')
  const lines = content.split(/\r?\n/)

  if (endsWithNewline) {
    lines.pop()
  }

  return {
    entries: lines.map(parseEnvLine),
    newline,
    endsWithNewline,
  }
}

export function serializeEnvDocument(document: EnvDocument): string {
  const body = document.entries.map(serializeEnvLine).join(document.newline)

  if (document.endsWithNewline) {
    return `${body}${document.newline}`
  }

  return body
}

export function formatParsedEntriesForDebug(entries: EnvEntry[]): string {
  const preview = entries.map((entry, index) => {
    if (entry.type === 'pair') {
      return {
        index,
        type: entry.type,
        key: entry.key,
        rawValue: entry.rawValue,
        encrypted: entry.encrypted,
      }
    }

    if (entry.type === 'blank') {
      return {
        index,
        type: entry.type,
      }
    }

    return {
      index,
      type: entry.type,
      text: entry.text,
    }
  })

  return JSON.stringify(preview, null, 2)
}

export function decodeEnvValue(rawValue: string): string {
  if (rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"')) {
    return decodeDoubleQuotedValue(rawValue.slice(1, -1))
  }

  if (rawValue.length >= 2 && rawValue.startsWith("'") && rawValue.endsWith("'")) {
    return rawValue.slice(1, -1)
  }

  return rawValue
}

function parseEnvLine(line: string): EnvEntry {
  if (BLANK_LINE_PATTERN.test(line)) {
    return { type: 'blank', whitespace: line }
  }

  if (COMMENT_LINE_PATTERN.test(line)) {
    return { type: 'comment', text: line }
  }

  const pairMatch = line.match(PAIR_LINE_PATTERN)
  if (!pairMatch) {
    return { type: 'comment', text: line }
  }

  const [, leadingWhitespace, key, spacingBeforeEquals, spacingAfterEquals, rawValue] =
    pairMatch

  return {
    type: 'pair',
    key,
    rawValue,
    leadingWhitespace,
    spacingBeforeEquals,
    spacingAfterEquals,
    encrypted: rawValue.startsWith(ENCRYPTED_PREFIX),
  }
}

function serializeEnvLine(entry: EnvEntry): string {
  if (entry.type === 'pair') {
    return `${entry.leadingWhitespace}${entry.key}${entry.spacingBeforeEquals}=${entry.spacingAfterEquals}${entry.rawValue}`
  }

  if (entry.type === 'blank') {
    return entry.whitespace
  }

  return entry.text
}

function decodeDoubleQuotedValue(value: string): string {
  let output = ''

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index]
    if (current !== '\\') {
      output += current
      continue
    }

    const next = value[index + 1]
    if (next === undefined) {
      output += '\\'
      continue
    }

    if (next === 'n') {
      output += '\n'
      index += 1
      continue
    }

    if (next === 'r') {
      output += '\r'
      index += 1
      continue
    }

    if (next === 't') {
      output += '\t'
      index += 1
      continue
    }

    if (next === '"') {
      output += '"'
      index += 1
      continue
    }

    if (next === '\\') {
      output += '\\'
      index += 1
      continue
    }

    output += `\\${next}`
    index += 1
  }

  return output
}
