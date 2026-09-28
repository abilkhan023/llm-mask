import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openVault } from '../src/vault.js'
import { createDetector } from '../src/detectors.js'
import { createMasker } from '../src/masker.js'

const setup = (dictionary = []) => {
  const vault = openVault(mkdtempSync(join(tmpdir(), 'llm-mask-masker-')))
  const masker = createMasker({ vault, detect: createDetector({ dictionary }) })
  return { vault, masker }
}

test('detected value is replaced by a placeholder of its category', () => {
  const { masker } = setup()
  assert.match(masker.mask('write to a.user@corp.example').text, /^write to MSK_EMAIL_[0-9a-f]{10}$/)
})

test('text without sensitive values is returned unchanged with no counts', () => {
  const { masker } = setup()
  assert.deepEqual(masker.mask('const sum = a + b'), { text: 'const sum = a + b', counts: {} })
})

test('counts report replacements per category', () => {
  const { masker } = setup()
  assert.deepEqual(masker.mask('a@corp.example b@corp.example 10.20.30.40').counts, { EMAIL: 2, IP: 1 })
})

test('value learned from context is masked where it appears without context in the same text', () => {
  const { masker } = setup()
  const { text } = masker.mask('DB_PASSWORD=hunter2hunter\nretry with hunter2hunter')
  const [first, second] = text.match(/MSK_SECRET_[0-9a-f]{10}/g)
  assert.equal(text, `DB_PASSWORD=${first}\nretry with ${first}`)
  assert.equal(second, first)
})

test('value learned in an earlier text is masked in a later text without context', () => {
  const { masker, vault } = setup()
  masker.mask('DB_PASSWORD=hunter2hunter')
  const placeholder = vault.placeholderFor('hunter2hunter', 'SECRET')
  assert.equal(masker.mask('log: hunter2hunter sent').text, `log: ${placeholder} sent`)
})

test('longer value wins over a shorter value contained in it', () => {
  const { masker } = setup(['corp', 'domain:corp.example'])
  assert.match(masker.mask('open gitlab.corp.example now').text, /^open MSK_HOST_[0-9a-f]{10} now$/)
})

test('placeholder already present in the text is not masked again', () => {
  const { masker, vault } = setup()
  const placeholder = vault.placeholderFor('hunter2hunter', 'SECRET')
  const text = `password: "${placeholder}"`
  assert.equal(masker.mask(text).text, text)
})

test('dictionary term does not corrupt a placeholder that contains it', () => {
  const { masker, vault } = setup(['host'])
  const placeholder = vault.placeholderFor('gitlab.corp.example', 'HOST')
  const masked = masker.mask(`open ${placeholder} on host`).text
  assert.equal(masked.startsWith(`open ${placeholder} on MSK_TERM_`), true)
})

test('unmask restores the exact original text', () => {
  const { masker } = setup(['domain:corp.example', 'acme'])
  const original = [
    'Host gitlab.corp.example (10.20.30.40), owner a.user@corp.example',
    'DB_PASSWORD=hunter2hunter',
    'Call +7 701 123 45 67 about ACME and acme',
  ].join('\n')
  const { text } = masker.mask(original)
  assert.equal(masker.unmask(text), original)
})

test('masked text contains none of the sensitive values', () => {
  const { masker } = setup(['domain:corp.example', 'acme'])
  const { text } = masker.mask('gitlab.corp.example a.user@corp.example DB_PASSWORD=hunter2hunter ACME 10.20.30.40')
  for (const value of ['corp.example', 'a.user', 'hunter2hunter', 'ACME', '10.20.30.40']) {
    assert.equal(text.includes(value), false, value)
  }
})

test('unmask leaves an unknown placeholder as it is', () => {
  const { masker } = setup()
  assert.equal(masker.unmask('see MSK_HOST_0000000000 here'), 'see MSK_HOST_0000000000 here')
})

test('unmask resolves a placeholder written in another letter case', () => {
  const { masker, vault } = setup()
  const placeholder = vault.placeholderFor('gitlab.corp.example', 'HOST')
  assert.equal(masker.unmask(`https://${placeholder.toLowerCase()}/api`), 'https://gitlab.corp.example/api')
})

test('unmask resolves a placeholder directly followed by hex characters', () => {
  const { masker, vault } = setup()
  const placeholder = vault.placeholderFor('gitlab.corp.example', 'HOST')
  assert.equal(masker.unmask(`${placeholder}beef`), 'gitlab.corp.examplebeef')
})

test('unmask inside json escapes the restored value', () => {
  const { masker, vault } = setup()
  const placeholder = vault.placeholderFor('line1\nline2 "quoted" back\\slash', 'TERM')
  const restored = masker.unmask(`{"command":"echo ${placeholder}"}`, { json: true })
  assert.equal(restored, '{"command":"echo line1\\nline2 \\"quoted\\" back\\\\slash"}')
})

test('locate reports where each sensitive value sits', () => {
  const { masker } = setup()
  assert.deepEqual(masker.locate('mail a.user@corp.example from 10.20.30.40'), [
    { start: 5, end: 24, value: 'a.user@corp.example', category: 'EMAIL' },
    { start: 30, end: 41, value: '10.20.30.40', category: 'IP' },
  ])
})

test('locate includes a value learned earlier that appears without context', () => {
  const { masker } = setup()
  masker.mask('DB_PASSWORD=hunter2hunter')
  assert.deepEqual(masker.locate('typed hunter2hunter here'), [{ start: 6, end: 19, value: 'hunter2hunter', category: 'SECRET' }])
})

test('locate skips placeholders', () => {
  const { masker, vault } = setup()
  const placeholder = vault.placeholderFor('hunter2hunter', 'SECRET')
  assert.deepEqual(masker.locate(`password: "${placeholder}"`), [])
})

test('locate remembers what it found so later text is masked', () => {
  const { masker } = setup()
  masker.locate('DB_PASSWORD=hunter2hunter')
  assert.match(masker.mask('typed hunter2hunter here').text, /^typed MSK_SECRET_[0-9a-f]{10} here$/)
})

test('loose locate finds a known value whose zero was read as a slashed letter', () => {
  const { masker } = setup()
  masker.mask('DB_PASSWORD=Tr0ub4dor3xK')
  assert.deepEqual(masker.locate('pass Trøub4dor3xK done', { loose: true }), [
    { start: 5, end: 17, value: 'Tr0ub4dor3xK', category: 'SECRET' },
  ])
})

test('loose locate finds a known value read with look-alike latin and cyrillic letters', () => {
  const { masker } = setup(['domain:corp.example'])
  masker.mask('open gitlab.corp.example')
  assert.deepEqual(masker.locate('open gitIab.соrp.ехаmpIe now', { loose: true }), [
    { start: 5, end: 24, value: 'gitlab.corp.example', category: 'HOST' },
  ])
})

test('loose locate still finds values by their patterns', () => {
  const { masker } = setup()
  assert.deepEqual(masker.locate('mail a.user@corp.example', { loose: true }), [
    { start: 5, end: 24, value: 'a.user@corp.example', category: 'EMAIL' },
  ])
})

test('strict locate ignores look-alikes so that text is restored exactly', () => {
  const { masker } = setup()
  masker.mask('DB_PASSWORD=Tr0ub4dor3xK')
  assert.deepEqual(masker.locate('pass Trøub4dor3xK done'), [])
  assert.equal(masker.mask('pass Trøub4dor3xK done').text, 'pass Trøub4dor3xK done')
})
