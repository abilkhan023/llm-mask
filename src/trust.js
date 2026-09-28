import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g

const execute = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

const certificatesIn = (text) => text.match(CERTIFICATE) ?? []

const isAuthority = (pem) => {
  try {
    return new X509Certificate(pem).ca
  } catch {
    return false
  }
}

const fromKeychains = (home, run) => {
  const keychains = ['/Library/Keychains/System.keychain', join(home, 'Library/Keychains/login.keychain-db')]
  const scratch = mkdtempSync(join(tmpdir(), 'llm-mask-trust-'))
  const file = join(scratch, 'candidate.pem')
  const trusted = []
  try {
    for (const keychain of keychains) {
      let listing
      try {
        listing = run('security', ['find-certificate', '-a', '-p', keychain])
      } catch {
        continue
      }
      for (const pem of certificatesIn(listing).filter(isAuthority)) {
        writeFileSync(file, pem)
        try {
          run('security', ['verify-cert', '-c', file, '-p', 'ssl'])
          trusted.push(pem)
        } catch {}
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return trusted
}

const fromEnvironment = (env) => {
  if (!env.NODE_EXTRA_CA_CERTS) return []
  try {
    return certificatesIn(readFileSync(env.NODE_EXTRA_CA_CERTS, 'utf8'))
  } catch {
    return []
  }
}

export const loadAuthorities = ({ env, platform = process.platform, home = homedir(), run = execute }) => [
  ...new Set([...(platform === 'darwin' ? fromKeychains(home, run) : []), ...fromEnvironment(env)]),
]
