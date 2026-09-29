import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRecorder } from '../src/recorder.js'

const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`

const request = (text) => ({ model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content: text }] })

const started = (recorder, text = 'open MSK_HOST_0123456789', extra = {}) =>
  recorder.begin({ method: 'POST', path: '/v1/messages', request: request(text), bytes: 120, counts: { HOST: 1 }, ...extra })

test('exchange in progress is listed with what is known so far', () => {
  const recorder = createRecorder()
  started(recorder)
  const [summary] = recorder.list()

  assert.equal(summary.method, 'POST')
  assert.equal(summary.path, '/v1/messages')
  assert.equal(summary.model, 'claude-sonnet-5')
  assert.equal(summary.messages, 1)
  assert.equal(summary.bytes, 120)
  assert.deepEqual(summary.counts, { HOST: 1 })
  assert.equal(summary.done, false)
  assert.equal(summary.status, undefined)
  assert.match(summary.time, /^\d{4}-\d{2}-\d{2}T/)
})

test('summary says what the request was about', () => {
  const recorder = createRecorder()
  started(recorder, '<system-reminder>Follow the rules.</system-reminder>\nopen MSK_HOST_0123456789 and check the port')
  const [summary] = recorder.list()

  assert.equal(summary.kind, 'question')
  assert.equal(summary.title, 'open MSK_HOST_0123456789 and check the port')
})

test('summary carries a short title and not the request or the reply', () => {
  const recorder = createRecorder()
  const exchange = started(recorder, `open MSK_HOST_0123456789\n${'long body of the request '.repeat(200)}`)
  exchange.body({ content: [{ type: 'text', text: 'a reply that must not be listed' }] })
  exchange.end(200)
  const listed = JSON.stringify(recorder.list())

  assert.equal(listed.includes('long body of the request'), false)
  assert.equal(listed.includes('a reply that must not be listed'), false)
  assert.equal(listed.length < 600, true)
})

test('full exchange holds the request exactly as it was sent', () => {
  const recorder = createRecorder()
  const exchange = started(recorder)

  assert.deepEqual(recorder.get(exchange.id).request, request('open MSK_HOST_0123456789'))
})

test('streamed reply is put together from its pieces', () => {
  const recorder = createRecorder()
  const exchange = started(recorder)
  const stream =
    frame({ type: 'message_start', message: { id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: { input_tokens: 25, output_tokens: 1 } } }) +
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }) +
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'consider MSK_HOST_' } }) +
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '0123456789' } }) +
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'c2ln' } }) +
    frame({ type: 'content_block_stop', index: 0 }) +
    frame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) +
    frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'opening MSK_HO' } }) +
    frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ST_0123456789' } }) +
    frame({ type: 'content_block_stop', index: 1 }) +
    frame({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} } }) +
    frame({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command": "curl MSK_' } }) +
    frame({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'HOST_0123456789"}' } }) +
    frame({ type: 'content_block_stop', index: 2 }) +
    frame({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 40 } }) +
    frame({ type: 'message_stop' })
  for (let i = 0; i < stream.length; i += 13) exchange.chunk(stream.slice(i, i + 13))
  exchange.end(200)

  assert.deepEqual(recorder.get(exchange.id).response, {
    content: [
      { type: 'thinking', thinking: 'consider MSK_HOST_0123456789' },
      { type: 'text', text: 'opening MSK_HOST_0123456789' },
      { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'curl MSK_HOST_0123456789' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 25, output_tokens: 40 },
  })
})

test('tool input that stops halfway is kept as the text that arrived', () => {
  const recorder = createRecorder()
  const exchange = started(recorder)
  exchange.chunk(
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} } }) +
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command": "cur' } }),
  )
  exchange.end(200)

  assert.deepEqual(recorder.get(exchange.id).response.content, [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: '{"command": "cur' }])
})

test('error sent inside a stream is kept', () => {
  const recorder = createRecorder()
  const exchange = started(recorder)
  exchange.chunk(frame({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
  exchange.end(200)

  assert.deepEqual(recorder.get(exchange.id).response.error, { type: 'overloaded_error', message: 'Overloaded' })
})

test('reply that is not streamed is kept as it arrived', () => {
  const recorder = createRecorder()
  const exchange = started(recorder)
  exchange.body({ id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'opening MSK_HOST_0123456789' }], stop_reason: 'end_turn', usage: { input_tokens: 25, output_tokens: 8 } })
  exchange.end(200)

  assert.deepEqual(recorder.get(exchange.id).response, {
    content: [{ type: 'text', text: 'opening MSK_HOST_0123456789' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 25, output_tokens: 8 },
  })
})

test('error reply is kept with its status', () => {
  const recorder = createRecorder()
  const exchange = started(recorder)
  exchange.body({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })
  exchange.end(429)

  assert.equal(recorder.list()[0].status, 429)
  assert.deepEqual(recorder.get(exchange.id).response, { content: [], error: { type: 'rate_limit_error', message: 'slow down' } })
})

test('finished exchange is marked done with its status', () => {
  const recorder = createRecorder()
  started(recorder).end(200)

  assert.equal(recorder.list()[0].done, true)
  assert.equal(recorder.list()[0].status, 200)
})

test('request that was refused is recorded with the reason and without its body', () => {
  const recorder = createRecorder()
  recorder.refuse({ method: 'POST', path: '/v1/messages', status: 400, reason: 'request body is not valid json, request was not sent' })
  const [summary] = recorder.list()

  assert.equal(summary.status, 400)
  assert.equal(summary.refused, true)
  assert.equal(summary.done, true)
  assert.deepEqual(recorder.get(summary.id).response, { content: [], error: { type: 'refused', message: 'request body is not valid json, request was not sent' } })
  assert.equal(recorder.get(summary.id).request, undefined)
})

test('newest exchange comes first', () => {
  const recorder = createRecorder()
  const first = started(recorder, 'first')
  const second = started(recorder, 'second')

  assert.deepEqual(recorder.list().map(({ id }) => id), [second.id, first.id])
})

test('only the latest exchanges are kept', () => {
  const recorder = createRecorder({ limit: 3 })
  const ids = ['a', 'b', 'c', 'd', 'e'].map((text) => started(recorder, text).id)

  assert.deepEqual(recorder.list().map(({ id }) => id), [ids[4], ids[3], ids[2]])
  assert.equal(recorder.get(ids[0]), undefined)
})

test('oldest exchanges are dropped when together they grow too large', () => {
  const recorder = createRecorder({ limit: 10, maxBytes: 250 })
  const ids = ['a', 'b', 'c'].map((text) => started(recorder, text).id)

  assert.deepEqual(recorder.list().map(({ id }) => id), [ids[2], ids[1]])
})

test('newest exchange is kept even when it alone is too large', () => {
  const recorder = createRecorder({ limit: 10, maxBytes: 50 })
  const exchange = started(recorder)

  assert.deepEqual(recorder.list().map(({ id }) => id), [exchange.id])
})

test('unknown exchange gives nothing', () => {
  assert.equal(createRecorder().get('404'), undefined)
})

test('writing to an exchange that was already dropped does not bring it back', () => {
  const recorder = createRecorder({ limit: 1 })
  const dropped = started(recorder, 'first')
  const kept = started(recorder, 'second')
  dropped.chunk(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  dropped.end(200)

  assert.deepEqual(recorder.list().map(({ id }) => id), [kept.id])
})
