import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, loadDictionary, readEnvFiles } from '../src/config.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'llm-mask-config-'))

test('defaults apply when there is no config file', () => {
  const { publicDomains, ...rest } = loadConfig(tempDir())
  assert.deepEqual(rest, {
    systemNote: true,
    media: 'pass',
    keepMasked: ['WebFetch', 'WebSearch', 'mcp__*'],
    envFiles: true,
  })
  for (const domain of ['w3.org', 'github.com', 'anthropic.com', 'claude.ai', 'npmjs.com']) assert.equal(publicDomains.includes(domain), true, domain)
})

test('config file overrides only the settings it names', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ media: 'block', keepMasked: ['WebFetch'], publicDomains: ['w3.org'] }))
  assert.deepEqual(loadConfig(dir), { systemNote: true, media: 'block', keepMasked: ['WebFetch'], envFiles: true, publicDomains: ['w3.org'] })
})

test('public domains must be a list', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ publicDomains: 'github.com' }))
  assert.throws(() => loadConfig(dir), /publicDomains/)
})

test('broken config file is reported instead of silently falling back to defaults', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'config.json'), '{ media: block')
  assert.throws(() => loadConfig(dir), /config\.json/)
})

test('media can be set to redact', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ media: 'redact' }))
  assert.equal(loadConfig(dir).media, 'redact')
})

test('unknown media mode is rejected', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ media: 'blur' }))
  assert.throws(() => loadConfig(dir), /media/)
})

test('dictionary is empty when there is no dictionary file', () => {
  assert.deepEqual(loadDictionary(tempDir()), [])
})

test('dictionary file is read line by line', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'dictionary.txt'), '# internal\ndomain:corp.example\n\nacme\r\nregex:operator_\\d{5}\n')
  assert.deepEqual(loadDictionary(dir), ['# internal', 'domain:corp.example', '', 'acme', 'regex:operator_\\d{5}', ''])
})

test('env files give the host of a url value instead of the whole url', () => {
  const dir = tempDir()
  writeFileSync(join(dir, '.env'), 'VITE_RS_URL=https://rs.dev.corp.example/api/v1\n')
  assert.deepEqual(readEnvFiles(dir), ['domain:rs.dev.corp.example'])
})

test('env files give credentials and host of a url that carries credentials', () => {
  const dir = tempDir()
  writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgres://deploy:s3cretpass@db.corp.example:5432/app\n')
  assert.deepEqual(readEnvFiles(dir), ['domain:db.corp.example', 'term:deploy:s3cretpass'])
})

test('env files give secret looking values with and without quotes', () => {
  const dir = tempDir()
  writeFileSync(join(dir, '.env'), 'API_TOKEN=abc123def456\nexport OTHER="quoted-value-42"\nTHIRD=\'single_quoted_7\'\n')
  assert.deepEqual(readEnvFiles(dir), ['term:abc123def456', 'term:quoted-value-42', 'term:single_quoted_7'])
})

test('env files skip ordinary words, numbers, flags, short values and comments', () => {
  const dir = tempDir()
  writeFileSync(join(dir, '.env'), '# SECRET=commented-out-1\nNODE_ENV=development\nPORT=8080\nDEBUG=true\nAPP=storefront\nLANG=en-US\nEMPTY=\nURL=http://localhost:3000\n')
  assert.deepEqual(readEnvFiles(dir), [])
})

test('env files are read from every dotenv variant in the directory without duplicates', () => {
  const dir = tempDir()
  writeFileSync(join(dir, '.env'), 'API_TOKEN=abc123def456\n')
  writeFileSync(join(dir, '.env.local'), 'API_TOKEN=abc123def456\nLOCAL_TOKEN=local-token-99\n')
  writeFileSync(join(dir, '.env.production'), 'PROD_TOKEN=prod-token-77\n')
  writeFileSync(join(dir, 'notes.env.txt'), 'IGNORED_TOKEN=ignored-token-1\n')
  assert.deepEqual(readEnvFiles(dir).sort(), ['term:abc123def456', 'term:local-token-99', 'term:prod-token-77'])
})

test('directory without env files gives nothing', () => {
  assert.deepEqual(readEnvFiles(tempDir()), [])
})
