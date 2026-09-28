import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openVault } from '../src/vault.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'llm-mask-vault-'))

test('placeholder carries the category and ten hex characters', () => {
  const vault = openVault(tempDir())
  assert.match(vault.placeholderFor('gitlab.corp.example', 'HOST'), /^MSK_HOST_[0-9a-f]{10}$/)
})

test('same value gives the same placeholder on repeated calls', () => {
  const vault = openVault(tempDir())
  const first = vault.placeholderFor('secret-value-1', 'SECRET')
  const second = vault.placeholderFor('secret-value-1', 'SECRET')
  assert.equal(first, second)
})

test('different values give different placeholders', () => {
  const vault = openVault(tempDir())
  const a = vault.placeholderFor('secret-value-1', 'SECRET')
  const b = vault.placeholderFor('secret-value-2', 'SECRET')
  assert.notEqual(a, b)
})

test('value keeps its first placeholder when seen again under another category', () => {
  const vault = openVault(tempDir())
  const first = vault.placeholderFor('10.20.30.40', 'IP')
  const second = vault.placeholderFor('10.20.30.40', 'TERM')
  assert.equal(second, first)
})

test('placeholder resolves back to the original value', () => {
  const vault = openVault(tempDir())
  const placeholder = vault.placeholderFor('user@corp.example', 'EMAIL')
  assert.equal(vault.valueFor(placeholder), 'user@corp.example')
})

test('placeholder resolves regardless of letter case', () => {
  const vault = openVault(tempDir())
  const placeholder = vault.placeholderFor('user@corp.example', 'EMAIL')
  assert.equal(vault.valueFor(placeholder.toLowerCase()), 'user@corp.example')
  assert.equal(vault.valueFor(placeholder.toUpperCase()), 'user@corp.example')
})

test('unknown placeholder resolves to undefined', () => {
  const vault = openVault(tempDir())
  assert.equal(vault.valueFor('MSK_HOST_0000000000'), undefined)
})

test('a new vault on the same directory reproduces placeholders and values', () => {
  const dir = tempDir()
  const first = openVault(dir)
  const placeholder = first.placeholderFor('gitlab.corp.example', 'HOST')
  first.save()

  const second = openVault(dir)
  assert.equal(second.valueFor(placeholder), 'gitlab.corp.example')
  assert.equal(second.placeholderFor('gitlab.corp.example', 'HOST'), placeholder)
})

test('vaults on different directories give different placeholders for one value', () => {
  const a = openVault(tempDir()).placeholderFor('gitlab.corp.example', 'HOST')
  const b = openVault(tempDir()).placeholderFor('gitlab.corp.example', 'HOST')
  assert.notEqual(a, b)
})

test('saving does not drop entries written by another vault on the same directory', () => {
  const dir = tempDir()
  const a = openVault(dir)
  const b = openVault(dir)
  const fromA = a.placeholderFor('value-from-a', 'SECRET')
  const fromB = b.placeholderFor('value-from-b', 'SECRET')
  a.save()
  b.save()

  const reopened = openVault(dir)
  assert.equal(reopened.valueFor(fromA), 'value-from-a')
  assert.equal(reopened.valueFor(fromB), 'value-from-b')
})

test('placeholder created by another vault is found without reopening', () => {
  const dir = tempDir()
  const reader = openVault(dir)
  const writer = openVault(dir)
  const placeholder = writer.placeholderFor('late-value', 'SECRET')
  writer.save()

  assert.equal(reader.valueFor(placeholder), 'late-value')
})

test('key and vault files are readable by the owner only', () => {
  const dir = tempDir()
  const vault = openVault(dir)
  vault.placeholderFor('secret-value-1', 'SECRET')
  vault.save()

  assert.equal(statSync(join(dir, 'key')).mode & 0o777, 0o600)
  assert.equal(statSync(join(dir, 'vault.json')).mode & 0o777, 0o600)
})

test('vault file does not store the key', () => {
  const dir = tempDir()
  const vault = openVault(dir)
  vault.placeholderFor('secret-value-1', 'SECRET')
  vault.save()

  const key = readFileSync(join(dir, 'key'), 'utf8').trim()
  assert.equal(readFileSync(join(dir, 'vault.json'), 'utf8').includes(key), false)
})

test('stats count entries per category without exposing values', () => {
  const vault = openVault(tempDir())
  vault.placeholderFor('a@corp.example', 'EMAIL')
  vault.placeholderFor('b@corp.example', 'EMAIL')
  vault.placeholderFor('gitlab.corp.example', 'HOST')

  assert.deepEqual(vault.stats(), { EMAIL: 2, HOST: 1 })
})

test('known values are listed longest first', () => {
  const vault = openVault(tempDir())
  vault.placeholderFor('corp', 'TERM')
  vault.placeholderFor('gitlab.corp.example', 'HOST')
  vault.placeholderFor('corp.example', 'HOST')

  assert.deepEqual(vault.knownValues(), ['gitlab.corp.example', 'corp.example', 'corp'])
})
