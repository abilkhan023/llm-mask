import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'
import { loadConfig, loadDictionary, readEnvFiles, readIdentities } from './config.js'
import { createDetector } from './detectors.js'
import { createMasker } from './masker.js'
import { createRedactor } from './media.js'
import { buildHelper, createNativeEngine } from './native.js'
import { startProxy } from './proxy.js'
import { announce } from './sessions.js'
import { loadAuthorities } from './trust.js'
import { openVault } from './vault.js'

const DEFAULT_UPSTREAM = 'https://api.anthropic.com'
const LOCAL_ADDRESSES = ['127.0.0.1', 'localhost']
const FORWARDED_SIGNALS = ['SIGTERM', 'SIGHUP']

const runCommand = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    const ignore = () => {}
    const forward = (signal) => child.kill(signal)
    const release = () => {
      process.off('SIGINT', ignore)
      for (const signal of FORWARDED_SIGNALS) process.off(signal, forward)
    }
    process.on('SIGINT', ignore)
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forward)
    child.on('error', (error) => {
      release()
      reject(new Error(`cannot start ${command}: ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      release()
      resolve(code ?? 128 + (constants.signals[signal] ?? 0))
    })
  })

export const openSession = ({ home, cwd, identities }) => {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const config = loadConfig(home)
  const dictionary = [...loadDictionary(home), ...(config.envFiles ? readEnvFiles(cwd) : [])]
  const vault = openVault(home)
  const known = config.identities ? (identities ?? readIdentities()) : {}
  const masker = createMasker({ vault, detect: createDetector({ dictionary, publicDomains: config.publicDomains, identities: known }) })
  return { config, vault, masker }
}

export const openRedactor = async (masker) => createRedactor({ engine: createNativeEngine({ binary: await buildHelper() }), masker })

export const launch = async ({ command, args, cwd, home, env, identities }) => {
  if (env.LLM_MASK_ACTIVE) return runCommand(command, args, { cwd, env })

  const { config, vault, masker } = openSession({ home, cwd, identities })
  const upstream = env.ANTHROPIC_BASE_URL || DEFAULT_UPSTREAM
  const auditFile = join(home, 'audit.log')

  const proxy = await startProxy({
    upstream,
    masker,
    redactor: config.media === 'redact' ? await openRedactor(masker) : undefined,
    authorities: upstream.startsWith('https:') ? loadAuthorities({ env }) : [],
    viewerToken: config.viewer ? randomBytes(16).toString('hex') : undefined,
    options: config,
    persist: vault.save,
    audit: (entry) => appendFileSync(auditFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 }),
  })

  const withdraw = proxy.viewer ? announce(home, { pid: process.pid, started: new Date().toISOString(), viewer: proxy.viewer }) : () => {}
  const excluded = [...(env.NO_PROXY ?? env.no_proxy ?? '').split(',').filter(Boolean), ...LOCAL_ADDRESSES].join(',')
  try {
    return await runCommand(command, args, {
      cwd,
      env: {
        ...env,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
        NO_PROXY: excluded,
        no_proxy: excluded,
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        DISABLE_BUG_COMMAND: '1',
        LLM_MASK_ACTIVE: '1',
        LLM_MASK_UPSTREAM: upstream,
      },
    })
  } finally {
    withdraw()
    await proxy.close()
    vault.save()
  }
}
