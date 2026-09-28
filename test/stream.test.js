import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openVault } from '../src/vault.js'
import { createDetector } from '../src/detectors.js'
import { createMasker } from '../src/masker.js'
import { createTextUnmasker, createSseUnmasker } from '../src/stream.js'

const setup = () => {
  const vault = openVault(mkdtempSync(join(tmpdir(), 'llm-mask-stream-')))
  const masker = createMasker({ vault, detect: createDetector({ dictionary: [] }) })
  const host = vault.placeholderFor('gitlab.corp.example', 'HOST')
  const quoted = vault.placeholderFor('say "hi"', 'TERM')
  return { masker, host, quoted }
}

const keepMasked = ['WebFetch', 'WebSearch', 'mcp__*']

const toSse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')

const fromSse = (text) =>
  text
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.split('\n').find((line) => line.startsWith('data: ')).slice(6)))

const inPieces = (text, size) => {
  const pieces = []
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size))
  return pieces
}

const runSse = (masker, events, size = 7) => {
  const unmasker = createSseUnmasker(masker, { keepMasked })
  const output = inPieces(toSse(events), size).map((piece) => unmasker.push(piece)).join('') + unmasker.flush()
  return fromSse(output)
}

const textDelta = (index, text) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
const jsonDelta = (index, partial_json) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })
const textStart = (index) => ({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
const toolStart = (index, name) => ({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_0${index}`, name, input: {} } })
const stop = (index) => ({ type: 'content_block_stop', index })

const deltasOf = (events, index, field) =>
  events
    .filter((event) => event.type === 'content_block_delta' && event.index === index)
    .map((event) => event.delta[field])
    .join('')

test('text without placeholders is released at once', () => {
  const { masker } = setup()
  assert.equal(createTextUnmasker(masker).push('hello world.'), 'hello world.')
})

test('placeholder split across chunks is restored and never leaks a fragment', () => {
  const { masker, host } = setup()
  const unmasker = createTextUnmasker(masker)
  const outputs = [`open ${host.slice(0, 6)}`, host.slice(6, 13), `${host.slice(13)} now`].map((chunk) => unmasker.push(chunk))
  assert.deepEqual(outputs, ['open ', '', 'gitlab.corp.example now'])
})

test('every way of cutting the text in two gives the same restored text', () => {
  const { masker, host } = setup()
  const text = `open ${host}, then ${host}/api MS teams ALARM`
  for (let cut = 0; cut <= text.length; cut++) {
    const unmasker = createTextUnmasker(masker)
    const restored = unmasker.push(text.slice(0, cut)) + unmasker.push(text.slice(cut)) + unmasker.flush()
    assert.equal(restored, 'open gitlab.corp.example, then gitlab.corp.example/api MS teams ALARM', `cut at ${cut}`)
  }
})

test('flush releases text that only looked like the start of a placeholder', () => {
  const { masker } = setup()
  const unmasker = createTextUnmasker(masker)
  assert.equal(unmasker.push('see MSK_HOST_'), 'see ')
  assert.equal(unmasker.flush(), 'MSK_HOST_')
})

test('flush restores a placeholder that ended exactly at the end of the stream', () => {
  const { masker, host } = setup()
  const unmasker = createTextUnmasker(masker)
  assert.equal(unmasker.push(`open ${host}`), 'open ')
  assert.equal(unmasker.flush(), 'gitlab.corp.example')
})

test('json mode escapes the restored value', () => {
  const { masker, quoted } = setup()
  const unmasker = createTextUnmasker(masker, { json: true })
  assert.equal(unmasker.push(`{"command":"${quoted}"}`) + unmasker.flush(), '{"command":"say \\"hi\\""}')
})

test('sse text deltas are restored across delta and network boundaries', () => {
  const { masker, host } = setup()
  const events = runSse(masker, [
    textStart(0),
    textDelta(0, `open ${host.slice(0, 9)}`),
    textDelta(0, `${host.slice(9)} now`),
    stop(0),
  ])
  assert.equal(deltasOf(events, 0, 'text'), 'open gitlab.corp.example now')
})

test('sse output never contains a placeholder fragment in a text delta', () => {
  const { masker, host } = setup()
  const events = runSse(masker, [textStart(0), textDelta(0, `open ${host.slice(0, 9)}`), textDelta(0, `${host.slice(9)} now`), stop(0)])
  const texts = events.filter((event) => event.type === 'content_block_delta').map((event) => event.delta.text)
  assert.deepEqual(texts, ['open ', 'gitlab.corp.example now'])
})

test('sse text held at the end of a block is emitted before the block stops', () => {
  const { masker, host } = setup()
  const events = runSse(masker, [textStart(0), textDelta(0, `open ${host}`), stop(0)])
  assert.deepEqual(events, [textStart(0), textDelta(0, 'open '), textDelta(0, 'gitlab.corp.example'), stop(0)])
})

test('sse tool input is restored as valid json for a local tool', () => {
  const { masker, host, quoted } = setup()
  const events = runSse(masker, [
    toolStart(1, 'Bash'),
    jsonDelta(1, `{"command": "curl ${host.slice(0, 12)}`),
    jsonDelta(1, `${host.slice(12)} && echo ${quoted}"}`),
    stop(1),
  ])
  assert.deepEqual(JSON.parse(deltasOf(events, 1, 'partial_json')), { command: 'curl gitlab.corp.example && echo say "hi"' })
})

test('sse tool input stays masked for tools that send data outside', () => {
  const { masker, host } = setup()
  const input = [toolStart(0, 'WebFetch'), jsonDelta(0, `{"url": "https://${host}/x"}`), stop(0), toolStart(1, 'mcp__drive__search'), jsonDelta(1, `{"query": "${host}"}`), stop(1)]
  assert.deepEqual(runSse(masker, input), input)
})

test('sse blocks are tracked separately by index', () => {
  const { masker, host } = setup()
  const events = runSse(masker, [
    textStart(0),
    textDelta(0, `first ${host}`),
    stop(0),
    toolStart(1, 'Read'),
    jsonDelta(1, `{"file_path": "/etc/${host}.conf"}`),
    stop(1),
  ])
  assert.equal(deltasOf(events, 0, 'text'), 'first gitlab.corp.example')
  assert.deepEqual(JSON.parse(deltasOf(events, 1, 'partial_json')), { file_path: '/etc/gitlab.corp.example.conf' })
})

test('sse thinking and signature deltas pass through as the model produced them', () => {
  const { masker, host } = setup()
  const input = [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: `consider ${host}` } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'c2lnbmF0dXJl' } },
    stop(0),
  ]
  assert.deepEqual(runSse(masker, input), input)
})

test('sse events outside content blocks pass through byte for byte', () => {
  const { masker } = setup()
  const stream =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","model":"claude-sonnet-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":25,"output_tokens":1}}}\n\n' +
    'event: ping\ndata: {"type": "ping"}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":15}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  const unmasker = createSseUnmasker(masker, { keepMasked })
  const output = inPieces(stream, 11).map((piece) => unmasker.push(piece)).join('') + unmasker.flush()
  assert.equal(output, stream)
})

test('sse stream with carriage returns is understood', () => {
  const { masker, host } = setup()
  const stream = toSse([textStart(0), textDelta(0, `open ${host} now`), stop(0)]).replaceAll('\n', '\r\n')
  const unmasker = createSseUnmasker(masker, { keepMasked })
  const output = unmasker.push(stream) + unmasker.flush()
  assert.equal(output.includes('gitlab.corp.example now'), true)
  assert.equal(output.includes('MSK_'), false)
})

test('sse stream cut off in the middle of an event releases what it received', () => {
  const { masker } = setup()
  const unmasker = createSseUnmasker(masker, { keepMasked })
  const partial = 'event: ping\ndata: {"type": "pi'
  assert.equal(unmasker.push(partial) + unmasker.flush(), partial)
})
