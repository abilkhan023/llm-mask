#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { loadDictionary } from '../src/config.js'
import { createDetector } from '../src/detectors.js'
import { launch, openRedactor, openSession } from '../src/launcher.js'
import { runningSessions } from '../src/sessions.js'

const USAGE = `llm-mask: masks sensitive values in what Claude Code sends and restores them in the replies

usage:
  llm-mask run -- <command> [arguments]   start a command behind the masking proxy
  llm-mask check [file]                   print the masked form of a file or of standard input
  llm-mask check <image>                  write a painted copy of an image next to it
  llm-mask add                            add dictionary entries read from standard input
  llm-mask status                         show how much is masked, by category
  llm-mask watch                          open the live view of what is sent and what comes back
  llm-mask help                           show this list

dictionary entries for add, one per line:
  acme                    a word or a name, any letter case
  domain:corp.example     a domain with all its subdomains
  regex:operator_\\d{5}    a pattern
`

const HELP_OPTIONS = ['--help', '-h']

const home = process.env.LLM_MASK_HOME || join(homedir(), '.llm-mask')
const cwd = process.cwd()

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

class UsageError extends Error {}

const readInput = (file) => readFileSync(file ?? 0, 'utf8')

const table = (counts) =>
  Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, amount]) => `  ${category.padEnd(8)} ${amount}\n`)
    .join('')

const checkImage = async (file, type, masker, vault) => {
  const redactor = await openRedactor(masker)
  const image = { type: 'image', source: { type: 'base64', media_type: type, data: readFileSync(file).toString('base64') } }
  const { body, counts, media } = await redactor.redactImages({ messages: [{ role: 'user', content: [image] }] })
  vault.save()
  if (media.removed) throw new Error(`${file} cannot be inspected`)
  if (media.redacted) {
    const { source } = body.messages[0].content[0]
    const painted = `${file.slice(0, -extname(file).length)}.masked.${source.media_type === 'image/jpeg' ? 'jpg' : 'png'}`
    writeFileSync(painted, Buffer.from(source.data, 'base64'))
    process.stdout.write(`${painted}\n`)
  }
  process.stderr.write(`masked:\n${table(counts) || '  nothing\n'}`)
  return 0
}

const commands = {
  run: async (rest) => {
    const separator = rest.indexOf('--')
    const [command, ...args] = separator === -1 ? rest : rest.slice(separator + 1)
    if (!command) throw new UsageError()
    return launch({ command, args, cwd, home, env: process.env })
  },

  check: async ([file]) => {
    const { masker, vault } = openSession({ home, cwd })
    const type = file && IMAGE_TYPES[extname(file).toLowerCase()]
    if (type) return checkImage(file, type, masker, vault)
    const { text, counts } = masker.mask(readInput(file))
    vault.save()
    process.stdout.write(text)
    process.stderr.write(`masked:\n${table(counts) || '  nothing\n'}`)
    return 0
  },

  add: () => {
    if (process.stdin.isTTY) process.stderr.write('entries, one per line, then Ctrl+D:\n')
    const entries = readInput()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    createDetector({ dictionary: entries })
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const existing = loadDictionary(home).join('\n')
    const lead = existing && !existing.endsWith('\n') ? '\n' : ''
    appendFileSync(join(home, 'dictionary.txt'), lead + entries.map((entry) => `${entry}\n`).join(''), { mode: 0o600 })
    process.stderr.write(`added entries: ${entries.length}\n`)
    return 0
  },

  watch: ([option]) => {
    const sessions = runningSessions(home)
    if (!sessions.length) throw new Error('nothing is running, start a session first: llm-mask run -- claude')
    for (const { viewer } of sessions) process.stdout.write(`${viewer}\n`)
    if (option !== '--print') spawn('open', [sessions[0].viewer], { stdio: 'ignore', detached: true }).unref()
    return 0
  },

  help: () => {
    process.stdout.write(USAGE)
    return 0
  },

  status: () => {
    const { vault } = openSession({ home, cwd })
    const entries = loadDictionary(home).filter((line) => line.trim() && !line.trim().startsWith('#'))
    process.stdout.write(`home: ${home}\ndictionary entries: ${entries.length}\nmasked values by category:\n${table(vault.stats()) || '  none\n'}`)
    return 0
  },
}

const [given = 'help', ...rest] = process.argv.slice(2)
const name = HELP_OPTIONS.includes(given) ? 'help' : given

try {
  if (!Object.hasOwn(commands, name)) throw new UsageError()
  process.exitCode = await commands[name](rest)
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(USAGE)
    process.exitCode = 2
  } else {
    process.stderr.write(`llm-mask: ${error.message}\n`)
    process.exitCode = 1
  }
}
