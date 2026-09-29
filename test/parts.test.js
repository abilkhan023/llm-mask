import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeRequest, splitParts } from '../src/parts.js'

test('plain text is what the person wrote', () => {
  assert.deepEqual(splitParts('Read the file service.conf'), [{ kind: 'typed', text: 'Read the file service.conf' }])
})

test('reminder from the program is set apart from what the person wrote', () => {
  assert.deepEqual(splitParts('<system-reminder>\nFollow the rules.\n</system-reminder>\nRead the file service.conf'), [
    { kind: 'added', text: '<system-reminder>\nFollow the rules.\n</system-reminder>' },
    { kind: 'typed', text: 'Read the file service.conf' },
  ])
})

test('several inserts around the text keep their order', () => {
  const text = '<system-reminder>one</system-reminder>\n\nfirst question\n<total_tokens>900 tokens left</total_tokens>\nsecond question\n<system-reminder>two</system-reminder>'
  assert.deepEqual(splitParts(text), [
    { kind: 'added', text: '<system-reminder>one</system-reminder>' },
    { kind: 'typed', text: 'first question' },
    { kind: 'added', text: '<total_tokens>900 tokens left</total_tokens>' },
    { kind: 'typed', text: 'second question' },
    { kind: 'added', text: '<system-reminder>two</system-reminder>' },
  ])
})

test('output of a command typed in the program is an insert', () => {
  const text = '<command-name>/usage</command-name>\n<command-message>usage</command-message>\n<local-command-stdout>Stats dialog dismissed</local-command-stdout>\nwhat does it mean'
  assert.deepEqual(splitParts(text).map(({ kind }) => kind), ['added', 'added', 'added', 'typed'])
})

test('context added by a hook is an insert as a whole', () => {
  const text = 'SessionStart hook additional context: <EXTREMELY_IMPORTANT>\nYou have superpowers.\n</EXTREMELY_IMPORTANT>'
  assert.deepEqual(splitParts(text), [{ kind: 'added', text }])
})

test('note about an interruption is an insert', () => {
  assert.deepEqual(splitParts('[Request interrupted by user]'), [{ kind: 'added', text: '[Request interrupted by user]' }])
})

test('markup pasted by the person stays theirs', () => {
  const text = 'why does this fail?\n<template>\n  <div class="app"><Softphone locale="ru" /></div>\n</template>'
  assert.deepEqual(splitParts(text), [{ kind: 'typed', text }])
})

test('reminder that was never closed is kept as an insert to the end', () => {
  assert.deepEqual(splitParts('question\n<system-reminder>cut off'), [
    { kind: 'typed', text: 'question' },
    { kind: 'added', text: '<system-reminder>cut off' },
  ])
})

test('empty text gives no parts', () => {
  assert.deepEqual(splitParts('  \n '), [])
})

const asked = (content, earlier = []) => ({ model: 'claude-sonnet-5', messages: [...earlier, { role: 'user', content }] })

test('request is described by the first line of what the person wrote', () => {
  const request = asked([
    { type: 'text', text: '<system-reminder>Follow the rules.</system-reminder>' },
    { type: 'text', text: '\nRead the file service.conf in the current directory\nand tell me what it connects to.' },
  ])
  assert.deepEqual(describeRequest(request), { kind: 'question', title: 'Read the file service.conf in the current directory' })
})

test('request with text given as a plain string is described the same way', () => {
  assert.deepEqual(describeRequest(asked('open MSK_HOST_0123456789 now')), { kind: 'question', title: 'open MSK_HOST_0123456789 now' })
})

test('long first line is cut at a word', () => {
  const { title } = describeRequest(asked('explain why the connection to the billing service is refused before the password is even checked by the server'))
  assert.equal(title, 'explain why the connection to the billing service is refused before the…')
  assert.equal(title.length <= 80, true)
})

test('request that only returns tool results is described by the tools', () => {
  const earlier = [
    { role: 'user', content: 'check the port' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} }, { type: 'tool_use', id: 'toolu_02', name: 'Bash', input: {} }] },
  ]
  const request = asked([
    { type: 'tool_result', tool_use_id: 'toolu_01', content: 'DB_PASSWORD=MSK_SECRET_0123456789' },
    { type: 'tool_result', tool_use_id: 'toolu_02', content: 'ok' },
    { type: 'text', text: '<total_tokens>900 tokens left</total_tokens>' },
  ], earlier)
  assert.deepEqual(describeRequest(request), { kind: 'results', title: 'Read, Bash' })
})

test('tool named twice is listed once', () => {
  const earlier = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} }, { type: 'tool_use', id: 'toolu_02', name: 'Read', input: {} }] }]
  const request = asked([{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'a' }, { type: 'tool_result', tool_use_id: 'toolu_02', content: 'b' }], earlier)
  assert.deepEqual(describeRequest(request), { kind: 'results', title: 'Read' })
})

test('only the part after the last reply counts', () => {
  const earlier = [{ role: 'user', content: 'first question' }, { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] }]
  assert.deepEqual(describeRequest(asked('second question', earlier)), { kind: 'question', title: 'second question' })
})

test('what the person wrote wins over tool results in the same request', () => {
  const earlier = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} }] }]
  const request = asked([{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'a' }, { type: 'text', text: 'stop, use the other file' }], earlier)
  assert.deepEqual(describeRequest(request), { kind: 'question', title: 'stop, use the other file' })
})

test('request with nothing from the person is a background one', () => {
  assert.deepEqual(describeRequest(asked([{ type: 'text', text: '<system-reminder>only this</system-reminder>' }])), { kind: 'background', title: '' })
  assert.deepEqual(describeRequest({ model: 'claude-sonnet-5', messages: [] }), { kind: 'background', title: '' })
  assert.deepEqual(describeRequest({ note: 'not a conversation' }), { kind: 'background', title: '' })
})

test('request that allows a one token answer is a background check and keeps its word', () => {
  assert.deepEqual(describeRequest({ model: 'claude-haiku', max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] }), { kind: 'background', title: 'quota' })
})

test('request that allows a real answer stays a question', () => {
  assert.deepEqual(describeRequest({ model: 'claude-haiku', max_tokens: 2, messages: [{ role: 'user', content: 'quota' }] }), { kind: 'question', title: 'quota' })
})
