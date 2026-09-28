import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openVault } from '../src/vault.js'
import { createDetector } from '../src/detectors.js'
import { createMasker } from '../src/masker.js'
import { createRedactor } from '../src/media.js'
import { buildHelper, createNativeEngine } from '../src/native.js'

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))).toString('base64')

const pngSize = (base64) => {
  const bytes = Buffer.from(base64, 'base64')
  assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

const jpegSize = (base64) => {
  const bytes = Buffer.from(base64, 'base64')
  assert.equal(bytes.readUInt16BE(0), 0xffd8)
  let position = 2
  while (position < bytes.length) {
    const marker = bytes[position + 1]
    const length = bytes.readUInt16BE(position + 2)
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
    if (isFrame) return { width: bytes.readUInt16BE(position + 7), height: bytes.readUInt16BE(position + 5) }
    position += 2 + length
  }
  throw new Error('jpeg has no frame')
}

const readAgain = async (engine, { data, mediaType }) => {
  const session = await engine.open(data, mediaType)
  session.close()
  return session.lines.join('\n')
}

const rangeOf = (lines, text) => {
  const line = lines.findIndex((candidate) => candidate.includes(text))
  assert.notEqual(line, -1, `recognized text has no "${text}"`)
  const start = lines[line].indexOf(text)
  return { line, start, end: start + text.length }
}

let engine

before(async () => {
  engine = createNativeEngine({ binary: await buildHelper() })
})

test('helper is built once and then reused', async () => {
  const first = await buildHelper()
  const second = await buildHelper()
  assert.equal(second, first)
  assert.equal(existsSync(first), true)
})

test('text of an image is recognized line by line', async () => {
  const session = await engine.open(fixture('secrets.png'), 'image/png')
  session.close()

  assert.deepEqual(session.lines, [
    'Service settings',
    'DB_PASSWORD=hunter2hunter42',
    'owner: owner.person@masktest.example',
    'server 10.20.30.40 is reachable',
    'nothing secret on this line',
  ])
})

test('painted part can no longer be read while the rest still can', async () => {
  const session = await engine.open(fixture('secrets.png'), 'image/png')
  const painted = await session.paint([rangeOf(session.lines, '10.20.30.40')])
  session.close()
  const text = await readAgain(engine, painted)

  assert.equal(text.includes('10.20.30.40'), false)
  assert.equal(text.includes('hunter2hunter42'), true)
  assert.equal(text.includes('nothing secret on this line'), true)
})

test('painting covers only the words it was asked to cover', async () => {
  const session = await engine.open(fixture('secrets.png'), 'image/png')
  const painted = await session.paint([rangeOf(session.lines, '10.20.30.40')])
  session.close()
  const text = await readAgain(engine, painted)

  assert.match(text, /server/)
  assert.match(text, /is reachable/)
})

test('painted copy of a png is a png of the same size', async () => {
  const session = await engine.open(fixture('secrets.png'), 'image/png')
  const painted = await session.paint([rangeOf(session.lines, 'hunter2hunter42')])
  session.close()

  assert.equal(painted.mediaType, 'image/png')
  assert.deepEqual(pngSize(painted.data), { width: 900, height: 380 })
})

test('painted copy of a jpeg stays a jpeg', async () => {
  const session = await engine.open(fixture('rotated.jpg'), 'image/jpeg')
  const painted = await session.paint([rangeOf(session.lines, 'hunter2hunter42')])
  session.close()

  assert.equal(painted.mediaType, 'image/jpeg')
  assert.equal(Buffer.from(painted.data, 'base64').readUInt16BE(0), 0xffd8)
})

test('image stored sideways is read and painted upright', async () => {
  const session = await engine.open(fixture('rotated.jpg'), 'image/jpeg')
  const painted = await session.paint([rangeOf(session.lines, 'hunter2hunter42')])
  session.close()
  const text = await readAgain(engine, painted)

  assert.deepEqual(jpegSize(painted.data), { width: 900, height: 380 })
  assert.equal(text.includes('hunter2hunter42'), false)
  assert.equal(text.includes('nothing secret on this line'), true)
})

test('data that is not an image is rejected', async () => {
  await assert.rejects(engine.open(Buffer.from('just some text').toString('base64'), 'image/png'))
})

test('range outside the recognized text is rejected instead of being skipped', async () => {
  const session = await engine.open(fixture('clean.png'), 'image/png')
  await assert.rejects(session.paint([{ line: 99, start: 0, end: 4 }]))
  session.close()
})

test('helper that does not answer in time is stopped', async () => {
  const silent = join(mkdtempSync(join(tmpdir(), 'llm-mask-native-')), 'silent.sh')
  writeFileSync(silent, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 })
  const slow = createNativeEngine({ binary: silent, timeout: 200 })
  const started = Date.now()
  await assert.rejects(slow.open(fixture('clean.png'), 'image/png'))
  assert.equal(Date.now() - started < 5000, true)
})

test('whole pipeline leaves no secret readable in the image and keeps harmless text', async () => {
  const vault = openVault(mkdtempSync(join(tmpdir(), 'llm-mask-native-')))
  const masker = createMasker({ vault, detect: createDetector({ dictionary: [] }) })
  const redactor = createRedactor({ engine, masker })
  const { body, counts, media } = await redactor.redactImages({
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: fixture('secrets.png') } }] }],
  })
  const { source } = body.messages[0].content[0]
  const text = await readAgain(engine, { data: source.data, mediaType: source.media_type })

  for (const secret of ['hunter2hunter42', 'owner.person', 'masktest.example', '10.20.30.40']) {
    assert.equal(text.includes(secret), false, secret)
  }
  assert.match(text, /Service settings/)
  assert.match(text, /nothing secret on this line/)
  assert.deepEqual(counts, { SECRET: 1, EMAIL: 1, IP: 1 })
  assert.deepEqual(media, { redacted: 1, clean: 0, removed: 0 })
})

test('whole pipeline sends an image without secrets byte for byte', async () => {
  const vault = openVault(mkdtempSync(join(tmpdir(), 'llm-mask-native-')))
  const masker = createMasker({ vault, detect: createDetector({ dictionary: [] }) })
  const redactor = createRedactor({ engine, masker })
  const request = { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: fixture('clean.png') } }] }] }
  const { body, media } = await redactor.redactImages(request)

  assert.deepEqual(body, request)
  assert.deepEqual(media, { redacted: 0, clean: 1, removed: 0 })
})

test('text in russian is recognized', async () => {
  const session = await engine.open(fixture('mixed.png'), 'image/png')
  session.close()

  assert.equal(session.lines.includes('оператор Иванова на линии'), true)
})

test('whole pipeline paints a known password even when its zero is misread', async () => {
  const vault = openVault(mkdtempSync(join(tmpdir(), 'llm-mask-native-')))
  const masker = createMasker({ vault, detect: createDetector({ dictionary: ['Иванова'] }) })
  masker.mask('DB_PASSWORD=Tr0ub4dor3xK')
  const redactor = createRedactor({ engine, masker })
  const { body } = await redactor.redactImages({
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: fixture('mixed.png') } }] }],
  })
  const { source } = body.messages[0].content[0]
  const text = await readAgain(engine, { data: source.data, mediaType: source.media_type })

  assert.equal(/tr.ub4dor3xk/i.test(text), false)
  assert.equal(text.includes('Иванова'), false)
  assert.match(text, /оператор/)
  assert.match(text, /nothing secret on this line/)
})
