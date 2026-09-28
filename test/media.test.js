import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openVault } from '../src/vault.js'
import { createDetector } from '../src/detectors.js'
import { createMasker } from '../src/masker.js'
import { createRedactor } from '../src/media.js'

const SHOT = ['Service settings', 'DB_PASSWORD=hunter2hunter42', 'mail owner.person@masktest.example']
const KEY = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIBOgIBAAJBAKj34GkxFhD9', '-----END RSA PRIVATE KEY-----']
const CLEAN = ['hello world', 'plain text only']

const recordingEngine = (images, { paintFails = false } = {}) => {
  const calls = []
  const open = async (data, mediaType) => {
    if (!images[data]) throw new Error('unreadable image')
    const call = { data, mediaType, painted: null, closed: false }
    calls.push(call)
    return {
      lines: images[data],
      paint: async (ranges) => {
        if (paintFails) throw new Error('paint failed')
        call.painted = ranges
        return { data: `painted:${data}`, mediaType: 'image/png' }
      },
      close: () => {
        call.closed = true
      },
    }
  }
  return { calls, open }
}

const setup = (images, options) => {
  const vault = openVault(mkdtempSync(join(tmpdir(), 'llm-mask-media-')))
  const masker = createMasker({ vault, detect: createDetector({ dictionary: [] }) })
  const engine = recordingEngine(images, options)
  return { masker, engine, redactor: createRedactor({ engine, masker }) }
}

const image = (data, media_type = 'image/jpeg') => ({ type: 'image', source: { type: 'base64', media_type, data } })
const user = (...content) => ({ messages: [{ role: 'user', content }] })
const isNotice = (block) => block.type === 'text' && /llm-mask/.test(block.text)

test('image with sensitive text is replaced by the painted copy', async () => {
  const { redactor } = setup({ SHOT })
  const { body } = await redactor.redactImages(user(image('SHOT')))

  assert.deepEqual(body.messages[0].content, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'painted:SHOT' } }])
})

test('exactly the sensitive parts of each line are painted', async () => {
  const { redactor, engine } = setup({ SHOT })
  await redactor.redactImages(user(image('SHOT')))

  assert.deepEqual(engine.calls[0].painted, [
    { line: 1, start: 12, end: 27 },
    { line: 2, start: 5, end: 34 },
  ])
})

test('value spanning several lines is painted on each of them', async () => {
  const { redactor, engine } = setup({ KEY })
  await redactor.redactImages(user(image('KEY')))

  assert.deepEqual(engine.calls[0].painted, [
    { line: 0, start: 0, end: 31 },
    { line: 1, start: 0, end: 24 },
    { line: 2, start: 0, end: 29 },
  ])
})

test('image without sensitive text is sent as it is and never repainted', async () => {
  const { redactor, engine } = setup({ CLEAN })
  const { body, media } = await redactor.redactImages(user(image('CLEAN')))

  assert.deepEqual(body.messages[0].content, [image('CLEAN')])
  assert.equal(engine.calls[0].painted, null)
  assert.deepEqual(media, { redacted: 0, clean: 1, removed: 0 })
})

test('image inside a tool result is redacted', async () => {
  const { redactor } = setup({ SHOT })
  const { body } = await redactor.redactImages(user({ type: 'tool_result', tool_use_id: 'toolu_01', content: [{ type: 'text', text: 'screenshot' }, image('SHOT')] }))

  assert.deepEqual(body.messages[0].content[0].content, [
    { type: 'text', text: 'screenshot' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'painted:SHOT' } },
  ])
})

test('image keeps its cache control', async () => {
  const { redactor } = setup({ SHOT })
  const { body } = await redactor.redactImages(user({ ...image('SHOT'), cache_control: { type: 'ephemeral' } }))

  assert.deepEqual(body.messages[0].content[0].cache_control, { type: 'ephemeral' })
})

test('same image sent again is recognized once and gives the same bytes', async () => {
  const { redactor, engine } = setup({ SHOT })
  const first = await redactor.redactImages(user(image('SHOT')))
  const second = await redactor.redactImages(user(image('SHOT'), image('SHOT')))

  assert.equal(engine.calls.length, 1)
  assert.deepEqual(second.body.messages[0].content, [first.body.messages[0].content[0], first.body.messages[0].content[0]])
  assert.deepEqual(second.media, { redacted: 2, clean: 0, removed: 0 })
})

test('image that cannot be read is removed instead of being sent', async () => {
  const { redactor } = setup({})
  const { body, media } = await redactor.redactImages(user(image('BROKEN')))

  assert.equal(isNotice(body.messages[0].content[0]), true)
  assert.equal(JSON.stringify(body).includes('BROKEN'), false)
  assert.deepEqual(media, { redacted: 0, clean: 0, removed: 1 })
})

test('image that cannot be painted is removed instead of being sent', async () => {
  const { redactor } = setup({ SHOT }, { paintFails: true })
  const { body, media } = await redactor.redactImages(user(image('SHOT')))

  assert.equal(isNotice(body.messages[0].content[0]), true)
  assert.equal(JSON.stringify(body).includes('SHOT'), false)
  assert.deepEqual(media, { redacted: 0, clean: 0, removed: 1 })
})

test('image given by address is removed because it cannot be inspected', async () => {
  const { redactor, engine } = setup({})
  const { body, media } = await redactor.redactImages(user({ type: 'image', source: { type: 'url', url: 'https://files.example.org/shot.png' } }))

  assert.equal(isNotice(body.messages[0].content[0]), true)
  assert.equal(engine.calls.length, 0)
  assert.deepEqual(media, { redacted: 0, clean: 0, removed: 1 })
})

test('binary document is removed because it cannot be inspected', async () => {
  const { redactor } = setup({})
  const { body, media } = await redactor.redactImages(user({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'PDFDATA' } }))

  assert.equal(isNotice(body.messages[0].content[0]), true)
  assert.equal(JSON.stringify(body).includes('PDFDATA'), false)
  assert.deepEqual(media, { redacted: 0, clean: 0, removed: 1 })
})

test('text document and other blocks are left for the text masker', async () => {
  const { redactor } = setup({})
  const request = {
    model: 'claude-sonnet-5',
    system: 'You are a coding assistant.',
    messages: [
      { role: 'user', content: 'plain string content' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'mail owner.person@masktest.example' },
          { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'DB_PASSWORD=hunter2hunter42' } },
          { type: 'tool_result', tool_use_id: 'toolu_01', content: 'string result' },
        ],
      },
    ],
  }
  const { body } = await redactor.redactImages(request)

  assert.deepEqual(body, request)
})

test('counts name the categories found in images', async () => {
  const { redactor } = setup({ SHOT, CLEAN })
  const { counts, media } = await redactor.redactImages(user(image('SHOT'), image('CLEAN')))

  assert.deepEqual(counts, { SECRET: 1, EMAIL: 1 })
  assert.deepEqual(media, { redacted: 1, clean: 1, removed: 0 })
})

test('value seen in an image is masked in later text', async () => {
  const { redactor, masker } = setup({ SHOT })
  await redactor.redactImages(user(image('SHOT')))

  assert.match(masker.mask('typed hunter2hunter42 by hand').text, /^typed MSK_SECRET_[0-9a-f]{10} by hand$/)
})

test('recognizer is released after every image', async () => {
  const { redactor, engine } = setup({ SHOT, CLEAN })
  await redactor.redactImages(user(image('SHOT'), image('CLEAN')))

  assert.deepEqual(engine.calls.map((call) => call.closed), [true, true])
})

test('recognizer receives the image data and its type', async () => {
  const { redactor, engine } = setup({ SHOT })
  await redactor.redactImages(user(image('SHOT', 'image/webp')))

  assert.deepEqual(engine.calls.map(({ data, mediaType }) => ({ data, mediaType })), [{ data: 'SHOT', mediaType: 'image/webp' }])
})

test('known value misread by the recognizer is still painted', async () => {
  const { redactor, engine, masker } = setup({ MISREAD: ['pass Trøub4dor3xK done'] })
  masker.mask('DB_PASSWORD=Tr0ub4dor3xK')
  await redactor.redactImages(user(image('MISREAD')))

  assert.deepEqual(engine.calls[0].painted, [{ line: 0, start: 5, end: 17 }])
})
