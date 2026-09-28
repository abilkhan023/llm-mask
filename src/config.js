import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const PUBLIC_DOMAINS = [
  'w3.org', 'example.com', 'example.org', 'example.net', 'anthropic.com', 'claude.ai', 'claude.com',
  'github.com', 'githubusercontent.com', 'github.io', 'gitlab.com', 'npmjs.com', 'npmjs.org', 'nodejs.org',
  'mozilla.org', 'google.com', 'googleapis.com', 'gstatic.com', 'jsdelivr.net', 'cloudflare.com', 'unpkg.com',
  'schema.org', 'json-schema.org', 'stackoverflow.com', 'vuejs.org', 'typescriptlang.org', 'apple.com',
  'microsoft.com', 'socket.io', 'shields.io',
]
const DEFAULTS = { systemNote: true, media: 'pass', keepMasked: ['WebFetch', 'WebSearch', 'mcp__*'], envFiles: true, viewer: true, publicDomains: PUBLIC_DOMAINS }
const MEDIA_MODES = ['pass', 'block', 'redact']
const ENV_FILE = /^\.env(\..+)?$/
const ENV_LINE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0'])

const readOptional = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export const loadConfig = (home) => {
  const text = readOptional(join(home, 'config.json'))
  if (text === null) return { ...DEFAULTS }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`config.json is not valid json: ${error.message}`)
  }
  const config = { ...DEFAULTS, ...parsed }
  if (!MEDIA_MODES.includes(config.media)) throw new Error(`config.json: media must be one of: ${MEDIA_MODES.join(', ')}`)
  if (!Array.isArray(config.publicDomains)) throw new Error('config.json: publicDomains must be a list')
  return config
}

export const loadDictionary = (home) => readOptional(join(home, 'dictionary.txt'))?.split(/\r?\n/) ?? []

const unquoted = (value) => (/^(["']).*\1$/.test(value) ? value.slice(1, -1) : value)

const asUrl = (value) => {
  if (!value.includes('://')) return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

const entriesFor = (value) => {
  const url = asUrl(value)
  if (url) {
    const entries = []
    if (url.hostname.includes('.') && !LOCAL_HOSTS.has(url.hostname)) entries.push(`domain:${url.hostname}`)
    if (url.username && url.password) entries.push(`term:${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`)
    return entries
  }
  return value.length >= 8 && /\d/.test(value) ? [`term:${value}`] : []
}

export const readEnvFiles = (directory) => {
  const entries = new Set()
  const files = readdirSync(directory).filter((name) => ENV_FILE.test(name)).sort()
  for (const file of files) {
    for (const line of readFileSync(join(directory, file), 'utf8').split(/\r?\n/)) {
      const match = ENV_LINE.exec(line)
      if (!match) continue
      for (const entry of entriesFor(unquoted(match[1]))) entries.add(entry)
    }
  }
  return [...entries]
}
