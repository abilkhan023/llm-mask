import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openVault } from '../src/vault.js'
import { createDetector } from '../src/detectors.js'
import { createMasker } from '../src/masker.js'
import { maskRequest, unmaskResponse } from '../src/request.js'

const setup = (dictionary = ['domain:corp.example']) => {
  const vault = openVault(mkdtempSync(join(tmpdir(), 'llm-mask-request-')))
  const masker = createMasker({ vault, detect: createDetector({ dictionary }) })
  const host = vault.placeholderFor('gitlab.corp.example', 'HOST')
  return { vault, masker, host }
}

const options = { systemNote: false, media: 'pass', keepMasked: ['WebFetch', 'WebSearch', 'mcp__*'] }

test('string system prompt is masked', () => {
  const { masker, host } = setup()
  const { body } = maskRequest({ system: 'repo at gitlab.corp.example', messages: [] }, masker, options)
  assert.equal(body.system, `repo at ${host}`)
})

test('system text blocks are masked and keep their cache control', () => {
  const { masker, host } = setup()
  const { body } = maskRequest(
    { system: [{ type: 'text', text: 'repo at gitlab.corp.example', cache_control: { type: 'ephemeral' } }], messages: [] },
    masker,
    options,
  )
  assert.deepEqual(body.system, [{ type: 'text', text: `repo at ${host}`, cache_control: { type: 'ephemeral' } }])
})

test('string message content is masked', () => {
  const { masker, host } = setup()
  const { body } = maskRequest({ messages: [{ role: 'user', content: 'open gitlab.corp.example' }] }, masker, options)
  assert.deepEqual(body.messages, [{ role: 'user', content: `open ${host}` }])
})

test('text, tool use and tool result blocks are masked', () => {
  const { masker, host } = setup()
  const { body } = maskRequest(
    {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'open gitlab.corp.example' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01',
              name: 'Bash',
              input: { command: 'curl gitlab.corp.example', options: { hosts: ['gitlab.corp.example'], retries: 2 } },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_01', content: 'reply from gitlab.corp.example' },
            { type: 'tool_result', tool_use_id: 'toolu_02', content: [{ type: 'text', text: 'gitlab.corp.example ok' }], is_error: false },
          ],
        },
      ],
    },
    masker,
    options,
  )
  assert.deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: `open ${host}` }] },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'Bash',
          input: { command: `curl ${host}`, options: { hosts: [host], retries: 2 } },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_01', content: `reply from ${host}` },
        { type: 'tool_result', tool_use_id: 'toolu_02', content: [{ type: 'text', text: `${host} ok` }], is_error: false },
      ],
    },
  ])
})

test('thinking blocks pass through untouched so their signature stays valid', () => {
  const { masker } = setup()
  const thinking = { type: 'thinking', thinking: 'mail a.user@corp.example about gitlab.corp.example', signature: 'c2lnbmF0dXJl' }
  const redacted = { type: 'redacted_thinking', data: 'gitlab.corp.example' }
  const { body } = maskRequest({ messages: [{ role: 'assistant', content: [thinking, redacted] }] }, masker, options)
  assert.deepEqual(body.messages[0].content, [thinking, redacted])
})

test('block types that come from the api pass through untouched', () => {
  const { masker } = setup()
  const block = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_01', content: [{ type: 'web_search_result', url: 'https://gitlab.corp.example', encrypted_content: 'gitlab.corp.example' }] }
  const { body, skipped } = maskRequest({ messages: [{ role: 'user', content: [block] }] }, masker, options)
  assert.deepEqual(body.messages[0].content, [block])
  assert.deepEqual(skipped, { web_search_tool_result: 1 })
})

test('tool identity, ids and model stay readable when they contain a dictionary term', () => {
  const { masker } = setup(['acme'])
  const { body } = maskRequest(
    {
      model: 'acme-model',
      tools: [{ name: 'mcp__acme__search', description: 'search', input_schema: { type: 'object', properties: { acme_id: { type: 'string' } } } }],
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_acme', name: 'mcp__acme__search', input: { acme_id: 'x' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_acme', content: 'ok' }] },
      ],
    },
    masker,
    options,
  )
  assert.equal(body.model, 'acme-model')
  assert.equal(body.tools[0].name, 'mcp__acme__search')
  assert.deepEqual(Object.keys(body.tools[0].input_schema.properties), ['acme_id'])
  assert.equal(body.messages[0].content[0].name, 'mcp__acme__search')
  assert.equal(body.messages[0].content[0].id, 'toolu_acme')
  assert.deepEqual(Object.keys(body.messages[0].content[0].input), ['acme_id'])
  assert.equal(body.messages[1].content[0].tool_use_id, 'toolu_acme')
})

test('tool descriptions are masked at every depth', () => {
  const { masker, host } = setup()
  const { body } = maskRequest(
    {
      tools: [
        {
          name: 'deploy',
          description: 'deploys to gitlab.corp.example',
          input_schema: { type: 'object', properties: { target: { type: 'string', description: 'host such as gitlab.corp.example' } } },
        },
      ],
      messages: [],
    },
    masker,
    options,
  )
  assert.equal(body.tools[0].description, `deploys to ${host}`)
  assert.equal(body.tools[0].input_schema.properties.target.description, `host such as ${host}`)
})

test('document with a text source is masked', () => {
  const { masker, host } = setup()
  const { body } = maskRequest(
    { messages: [{ role: 'user', content: [{ type: 'document', title: 'gitlab.corp.example notes', source: { type: 'text', media_type: 'text/plain', data: 'see gitlab.corp.example' } }] }] },
    masker,
    options,
  )
  assert.deepEqual(body.messages[0].content, [
    { type: 'document', title: `${host} notes`, source: { type: 'text', media_type: 'text/plain', data: `see ${host}` } },
  ])
})

test('image passes through unchanged when media is allowed', () => {
  const { masker } = setup()
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
  const { body } = maskRequest({ messages: [{ role: 'user', content: [image] }] }, masker, options)
  assert.deepEqual(body.messages[0].content, [image])
})

test('image and binary document are replaced by a text notice when media is blocked', () => {
  const { masker } = setup()
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
  const pdf = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'aGVsbG8=' } }
  const { body, counts } = maskRequest(
    { messages: [{ role: 'user', content: [image, { type: 'tool_result', tool_use_id: 'toolu_01', content: [pdf] }] }] },
    masker,
    { ...options, media: 'block' },
  )
  const [first, second] = body.messages[0].content
  assert.equal(first.type, 'text')
  assert.equal(second.content[0].type, 'text')
  assert.equal(JSON.stringify(body).includes('aGVsbG8='), false)
  assert.equal(counts.MEDIA, 2)
})

test('system note is added after the existing system blocks', () => {
  const { masker } = setup()
  const original = { type: 'text', text: 'You are a coding assistant.', cache_control: { type: 'ephemeral' } }
  const { body } = maskRequest({ system: [original], messages: [] }, masker, { ...options, systemNote: true })
  assert.equal(body.system.length, 2)
  assert.deepEqual(body.system[0], original)
  assert.equal(body.system[1].type, 'text')
  assert.match(body.system[1].text, /MSK_/)
})

test('system note is appended to a string system prompt and created when there is none', () => {
  const { masker } = setup()
  const withString = maskRequest({ system: 'You are a coding assistant.', messages: [] }, masker, { ...options, systemNote: true }).body
  const withNone = maskRequest({ messages: [] }, masker, { ...options, systemNote: true }).body
  assert.equal(withString.system.startsWith('You are a coding assistant.'), true)
  assert.match(withString.system, /MSK_/)
  assert.match(withNone.system, /MSK_/)
})

test('counts add up across the whole request', () => {
  const { masker } = setup()
  const { counts } = maskRequest(
    {
      system: 'owner a.user@corp.example',
      messages: [
        { role: 'user', content: 'open gitlab.corp.example and wiki.corp.example' },
        { role: 'user', content: [{ type: 'text', text: 'ping 10.20.30.40' }] },
      ],
    },
    masker,
    options,
  )
  assert.deepEqual(counts, { EMAIL: 1, HOST: 2, IP: 1 })
})

test('fields outside the content are carried over unchanged', () => {
  const { masker } = setup()
  const { body } = maskRequest(
    { model: 'claude-sonnet-5', max_tokens: 1024, stream: true, metadata: { user_id: 'user_a.user@corp.example' }, thinking: { type: 'enabled', budget_tokens: 2000 }, messages: [] },
    masker,
    options,
  )
  assert.deepEqual(body, {
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    stream: true,
    metadata: { user_id: 'user_a.user@corp.example' },
    thinking: { type: 'enabled', budget_tokens: 2000 },
    messages: [],
  })
})

test('response text is restored', () => {
  const { masker, host } = setup()
  const body = unmaskResponse({ id: 'msg_01', type: 'message', role: 'assistant', content: [{ type: 'text', text: `open ${host}` }], stop_reason: 'end_turn' }, masker, options)
  assert.deepEqual(body.content, [{ type: 'text', text: 'open gitlab.corp.example' }])
})

test('response tool input is restored for a local tool', () => {
  const { masker, host } = setup()
  const body = unmaskResponse(
    { type: 'message', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: `curl ${host}`, flags: [host] } }] },
    masker,
    options,
  )
  assert.deepEqual(body.content[0].input, { command: 'curl gitlab.corp.example', flags: ['gitlab.corp.example'] })
})

test('response tool input stays masked for tools that send data outside', () => {
  const { masker, host } = setup()
  const content = [
    { type: 'tool_use', id: 'toolu_01', name: 'WebFetch', input: { url: `https://${host}/x` } },
    { type: 'tool_use', id: 'toolu_02', name: 'mcp__drive__search', input: { query: host } },
  ]
  const body = unmaskResponse({ type: 'message', content }, masker, options)
  assert.deepEqual(body.content, content)
})

test('response thinking stays as the model produced it', () => {
  const { masker, host } = setup()
  const thinking = { type: 'thinking', thinking: `consider ${host}`, signature: 'c2lnbmF0dXJl' }
  const body = unmaskResponse({ type: 'message', content: [thinking] }, masker, options)
  assert.deepEqual(body.content, [thinking])
})

test('error response text is restored', () => {
  const { masker, host } = setup()
  const body = unmaskResponse({ type: 'error', error: { type: 'invalid_request_error', message: `bad value ${host}` } }, masker, options)
  assert.equal(body.error.message, 'bad value gitlab.corp.example')
})
