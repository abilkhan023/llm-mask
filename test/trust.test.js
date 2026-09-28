import { test } from 'node:test'
import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { loadAuthorities } from '../src/trust.js'
import { createCertificate } from './helpers/certificates.js'

const trustedAuthority = createCertificate()
const untrustedAuthority = createCertificate()
const leaf = createCertificate({ authority: false })

const keychains = (contents, trusted) => {
  const calls = []
  const run = (command, args) => {
    calls.push([command, ...args])
    if (args[0] === 'find-certificate') {
      const found = Object.entries(contents).find(([name]) => args.at(-1).endsWith(name))
      if (!found) throw new Error('keychain cannot be read')
      return found[1].join('\n')
    }
    if (args[0] === 'verify-cert') {
      const checked = readFileSync(args[args.indexOf('-c') + 1], 'utf8').trim()
      if (!trusted.includes(checked)) throw new Error('not trusted')
      return ''
    }
    throw new Error(`unexpected command ${args[0]}`)
  }
  return { run, calls }
}

test('authority trusted by the system is returned', () => {
  const { run } = keychains({ 'System.keychain': [trustedAuthority.cert] }, [trustedAuthority.cert])
  assert.deepEqual(loadAuthorities({ platform: 'darwin', home: '/Users/someone', env: {}, run }), [trustedAuthority.cert])
})

test('authority the system does not trust is left out', () => {
  const { run } = keychains({ 'System.keychain': [trustedAuthority.cert, untrustedAuthority.cert] }, [trustedAuthority.cert])
  assert.deepEqual(loadAuthorities({ platform: 'darwin', home: '/Users/someone', env: {}, run }), [trustedAuthority.cert])
})

test('trusted certificate that is not an authority is left out', () => {
  const { run } = keychains({ 'System.keychain': [leaf.cert, trustedAuthority.cert] }, [leaf.cert, trustedAuthority.cert])
  assert.deepEqual(loadAuthorities({ platform: 'darwin', home: '/Users/someone', env: {}, run }), [trustedAuthority.cert])
})

test('system and personal keychains are both read', () => {
  const other = createCertificate()
  const { run, calls } = keychains({ 'System.keychain': [trustedAuthority.cert], 'login.keychain-db': [other.cert] }, [trustedAuthority.cert, other.cert])
  const found = loadAuthorities({ platform: 'darwin', home: '/Users/someone', env: {}, run })

  assert.deepEqual(found, [trustedAuthority.cert, other.cert])
  assert.deepEqual(
    calls.filter(([, action]) => action === 'find-certificate').map((call) => call.at(-1)),
    ['/Library/Keychains/System.keychain', '/Users/someone/Library/Keychains/login.keychain-db'],
  )
})

test('keychain that cannot be read is skipped', () => {
  const { run } = keychains({ 'login.keychain-db': [trustedAuthority.cert] }, [trustedAuthority.cert])
  assert.deepEqual(loadAuthorities({ platform: 'darwin', home: '/Users/someone', env: {}, run }), [trustedAuthority.cert])
})

test('same authority found twice is returned once', () => {
  const { run } = keychains({ 'System.keychain': [trustedAuthority.cert], 'login.keychain-db': [trustedAuthority.cert] }, [trustedAuthority.cert])
  assert.deepEqual(loadAuthorities({ platform: 'darwin', home: '/Users/someone', env: {}, run }), [trustedAuthority.cert])
})

test('keychains are not touched outside macos', () => {
  const { run, calls } = keychains({ 'System.keychain': [trustedAuthority.cert] }, [trustedAuthority.cert])
  assert.deepEqual(loadAuthorities({ platform: 'linux', home: '/home/someone', env: {}, run }), [])
  assert.deepEqual(calls, [])
})

test('authorities from the file named in the environment are added', () => {
  const { run } = keychains({ 'System.keychain': [trustedAuthority.cert] }, [trustedAuthority.cert])
  const found = loadAuthorities({ platform: 'darwin', home: '/Users/someone', env: { NODE_EXTRA_CA_CERTS: untrustedAuthority.file }, run })
  assert.deepEqual(found, [trustedAuthority.cert, untrustedAuthority.cert])
})

test('missing file named in the environment is ignored', () => {
  const { run } = keychains({}, [])
  assert.deepEqual(loadAuthorities({ platform: 'darwin', home: '/Users/someone', env: { NODE_EXTRA_CA_CERTS: '/nonexistent/authorities.pem' }, run }), [])
})

test('real keychains give only certificates that are authorities', { skip: process.platform !== 'darwin' }, () => {
  const started = Date.now()
  const found = loadAuthorities({ env: {} })
  for (const pem of found) assert.equal(new X509Certificate(pem).ca, true)
  assert.equal(Date.now() - started < 10000, true)
})
