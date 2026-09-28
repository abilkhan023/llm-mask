import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { openVault } from '../src/vault.js'
import { createDetector } from '../src/detectors.js'
import { createMasker } from '../src/masker.js'
import { createRedactor } from '../src/media.js'
import { startProxy } from '../src/proxy.js'
import { createCertificate } from './helpers/certificates.js'

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

const startUpstream = async (respond) => {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const request = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      requests.push(request)
      respond(request, res)
    })
  })
  const port = await listen(server)
  return { requests, url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

const setup = async (t, respond, { path = '', options = {} } = {}) => {
  const vault = openVault(mkdtempSync(join(tmpdir(), 'llm-mask-proxy-')))
  const masker = createMasker({ vault, detect: createDetector({ dictionary: ['domain:corp.example'] }) })
  const host = vault.placeholderFor('gitlab.corp.example', 'HOST')
  const upstream = await startUpstream((request, res) => respond(request, res, host))
  const audit = []
  const proxy = await startProxy({
    upstream: upstream.url + path,
    masker,
    options: { systemNote: false, media: 'pass', keepMasked: ['WebFetch', 'WebSearch', 'mcp__*'], ...options },
    audit: (entry) => audit.push(entry),
  })
  t.after(async () => {
    await proxy.close()
    await upstream.close()
  })
  return { upstream, proxy, host, audit, url: `http://127.0.0.1:${proxy.port}` }
}

const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })

const message = (content) => ({ model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content }] })

const reply = (text) => ({ id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } })

test('upstream receives the masked request and the client receives the restored reply', async (t) => {
  const { upstream, host, url } = await setup(t, (request, res, placeholder) => json(res, 200, reply(`opened ${placeholder}`)))
  const response = await post(`${url}/v1/messages`, message('open gitlab.corp.example'))

  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).content, [{ type: 'text', text: 'opened gitlab.corp.example' }])
  assert.deepEqual(JSON.parse(upstream.requests[0].body).messages, [{ role: 'user', content: `open ${host}` }])
})

test('nothing sensitive reaches the upstream in any part of the request', async (t) => {
  const { upstream, url } = await setup(t, (request, res) => json(res, 200, reply('ok')))
  await post(`${url}/v1/messages`, {
    ...message([{ type: 'text', text: 'mail a.user@corp.example, DB_PASSWORD=hunter2hunter' }]),
    system: 'server 10.20.30.40 at gitlab.corp.example',
  })

  for (const value of ['corp.example', 'a.user', 'hunter2hunter', '10.20.30.40']) {
    assert.equal(upstream.requests[0].body.includes(value), false, value)
  }
})

test('streamed reply is restored when a placeholder is split between network writes', async (t) => {
  const { url } = await setup(t, (request, res, placeholder) => {
    const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    const stream =
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `opened ${placeholder.slice(0, 8)}` } }) +
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${placeholder.slice(8)} for you` } }) +
      frame({ type: 'content_block_stop', index: 0 }) +
      frame({ type: 'message_stop' })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const middle = stream.indexOf(placeholder.slice(8)) + 3
    res.write(stream.slice(0, middle))
    setTimeout(() => res.end(stream.slice(middle)), 20)
  })
  const response = await post(`${url}/v1/messages`, { ...message('open gitlab.corp.example'), stream: true })
  const body = await response.text()
  const text = body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((event) => event.type === 'content_block_delta')
    .map((event) => event.delta.text)
    .join('')

  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.equal(text, 'opened gitlab.corp.example for you')
  assert.equal(body.includes('MSK_'), false)
})

test('streamed reply with a multibyte character split between network writes stays intact', async (t) => {
  const { url } = await setup(t, (request, res) => {
    const frame = Buffer.from(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"привет"}}\n\n`)
    const middle = frame.indexOf(Buffer.from('и')) + 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(frame.subarray(0, middle))
    setTimeout(() => res.end(frame.subarray(middle)), 20)
  })
  const response = await post(`${url}/v1/messages`, { ...message('hi'), stream: true })
  assert.equal((await response.text()).includes('"text":"привет"'), true)
})

test('credentials and protocol headers reach the upstream unchanged', async (t) => {
  const { upstream, url } = await setup(t, (request, res) => json(res, 200, reply('ok')))
  await post(`${url}/v1/messages`, message('hi'), {
    'x-api-key': 'key-for-gateway',
    authorization: 'Bearer oauth-token-value',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14',
    'user-agent': 'claude-cli/2.1.283',
  })

  const { headers } = upstream.requests[0]
  assert.equal(headers['x-api-key'], 'key-for-gateway')
  assert.equal(headers.authorization, 'Bearer oauth-token-value')
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14')
  assert.equal(headers['user-agent'], 'claude-cli/2.1.283')
  assert.equal(headers.host, new URL(upstream.url).host)
})

test('request declares the length of the masked body', async (t) => {
  const { upstream, url } = await setup(t, (request, res) => json(res, 200, reply('ok')))
  await post(`${url}/v1/messages`, message('open gitlab.corp.example and wiki.corp.example twice'))

  const [{ headers, body }] = upstream.requests
  assert.equal(Number(headers['content-length']), Buffer.byteLength(body))
})

test('upstream path prefix and query string are kept', async (t) => {
  const { upstream, url } = await setup(t, (request, res) => json(res, 200, reply('ok')), { path: '/gateway/' })
  await post(`${url}/v1/messages?beta=true`, message('hi'))

  assert.equal(upstream.requests[0].url, '/gateway/v1/messages?beta=true')
})

test('error status, headers and restored message reach the client', async (t) => {
  const { url } = await setup(t, (request, res, placeholder) =>
    json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: `slow down ${placeholder}` } }, { 'retry-after': '7', 'request-id': 'req_01' }),
  )
  const response = await post(`${url}/v1/messages`, message('open gitlab.corp.example'))

  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '7')
  assert.equal(response.headers.get('request-id'), 'req_01')
  assert.equal((await response.json()).error.message, 'slow down gitlab.corp.example')
})

test('token counting request is masked', async (t) => {
  const { upstream, host, url } = await setup(t, (request, res) => json(res, 200, { input_tokens: 12 }))
  const response = await post(`${url}/v1/messages/count_tokens`, message('open gitlab.corp.example'))

  assert.deepEqual(await response.json(), { input_tokens: 12 })
  assert.deepEqual(JSON.parse(upstream.requests[0].body).messages, [{ role: 'user', content: `open ${host}` }])
})

test('json sent to an unknown path has every string masked', async (t) => {
  const { upstream, host, url } = await setup(t, (request, res) => json(res, 200, {}))
  await post(`${url}/v1/other`, { note: 'open gitlab.corp.example', nested: { list: ['gitlab.corp.example'] }, count: 3 })

  assert.deepEqual(JSON.parse(upstream.requests[0].body), { note: `open ${host}`, nested: { list: [host] }, count: 3 })
})

test('request without a body passes through', async (t) => {
  const { upstream, url } = await setup(t, (request, res) => json(res, 200, { data: [{ id: 'claude-sonnet-5' }] }))
  const response = await fetch(`${url}/v1/models`)

  assert.deepEqual(await response.json(), { data: [{ id: 'claude-sonnet-5' }] })
  assert.equal(upstream.requests[0].method, 'GET')
  assert.equal(upstream.requests[0].url, '/v1/models')
})

test('body that is not valid json is refused and never sent', async (t) => {
  const { upstream, url } = await setup(t, (request, res) => json(res, 200, reply('ok')))
  const response = await post(`${url}/v1/messages`, '{"messages": [gitlab.corp.example')

  assert.equal(response.status, 400)
  assert.equal((await response.json()).type, 'error')
  assert.equal(upstream.requests.length, 0)
})

test('body that is not json is refused and never sent', async (t) => {
  const { upstream, url } = await setup(t, (request, res) => json(res, 200, {}))
  const response = await fetch(`${url}/v1/files`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'gitlab.corp.example' })

  assert.equal(response.status, 415)
  assert.equal(upstream.requests.length, 0)
})

test('unreachable upstream gives a gateway error', async (t) => {
  const vault = openVault(mkdtempSync(join(tmpdir(), 'llm-mask-proxy-')))
  const masker = createMasker({ vault, detect: createDetector({ dictionary: [] }) })
  const closed = await startUpstream(() => {})
  await closed.close()
  const proxy = await startProxy({ upstream: closed.url, masker, options: { systemNote: false, media: 'pass', keepMasked: [] }, audit: () => {} })
  t.after(() => proxy.close())

  const response = await post(`http://127.0.0.1:${proxy.port}/v1/messages`, message('hi'))
  assert.equal(response.status, 502)
  assert.equal((await response.json()).type, 'error')
})

test('audit entry reports categories and counts without any value', async (t) => {
  const { audit, url } = await setup(t, (request, res) => json(res, 200, reply('ok')))
  await post(`${url}/v1/messages`, message('open gitlab.corp.example and mail a.user@corp.example'))

  assert.equal(audit.length, 1)
  assert.equal(audit[0].method, 'POST')
  assert.equal(audit[0].path, '/v1/messages')
  assert.equal(audit[0].status, 200)
  assert.deepEqual(audit[0].counts, { HOST: 1, EMAIL: 1 })
  assert.equal(JSON.stringify(audit).includes('corp.example'), false)
})

test('audit entry records a refused request', async (t) => {
  const { audit, url } = await setup(t, (request, res) => json(res, 200, reply('ok')))
  await post(`${url}/v1/messages`, 'not json')

  assert.equal(audit.length, 1)
  assert.equal(audit[0].status, 400)
  assert.equal(audit[0].refused, true)
})

test('upstream is asked not to compress the reply', async (t) => {
  const { upstream, url } = await setup(t, (request, res) => json(res, 200, reply('ok')))
  await post(`${url}/v1/messages`, message('hi'), { 'accept-encoding': 'gzip, br' })

  assert.equal(upstream.requests[0].headers['accept-encoding'], 'identity')
})

test('reply compressed by the upstream anyway is still restored', async (t) => {
  const { url } = await setup(t, (request, res, placeholder) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
    res.end(gzipSync(JSON.stringify(reply(`opened ${placeholder}`))))
  })
  const response = await post(`${url}/v1/messages`, message('open gitlab.corp.example'))

  assert.deepEqual((await response.json()).content, [{ type: 'text', text: 'opened gitlab.corp.example' }])
})

test('values learned from a request are saved before the request is forwarded', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-mask-proxy-'))
  const vault = openVault(dir)
  const masker = createMasker({ vault, detect: createDetector({ dictionary: [] }) })
  let savedWhenForwarded
  const upstream = await startUpstream((request, res) => {
    const [placeholder] = request.body.match(/MSK_EMAIL_[0-9a-f]{10}/)
    savedWhenForwarded = openVault(dir).valueFor(placeholder)
    json(res, 200, reply('ok'))
  })
  const proxy = await startProxy({
    upstream: upstream.url,
    masker,
    options: { systemNote: false, media: 'pass', keepMasked: [] },
    persist: () => vault.save(),
  })
  t.after(async () => {
    await proxy.close()
    await upstream.close()
  })

  await post(`http://127.0.0.1:${proxy.port}/v1/messages`, message('mail a.user@corp.example'))
  assert.equal(savedWhenForwarded, 'a.user@corp.example')
})

test('upstream request is cancelled when the client gives up', async (t) => {
  let cancelled
  const closedUpstream = new Promise((resolve) => (cancelled = resolve))
  const vault = openVault(mkdtempSync(join(tmpdir(), 'llm-mask-proxy-')))
  const masker = createMasker({ vault, detect: createDetector({ dictionary: [] }) })
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: ping\ndata: {"type": "ping"}\n\n')
    res.on('close', () => cancelled('closed'))
  })
  const port = await listen(server)
  const proxy = await startProxy({ upstream: `http://127.0.0.1:${port}`, masker, options: { systemNote: false, media: 'pass', keepMasked: [] } })
  t.after(async () => {
    await proxy.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...message('hi'), stream: true }),
    signal: controller.signal,
  })
  await response.body.getReader().read()
  controller.abort()

  assert.equal(await closedUpstream, 'closed')
})

const paintingEngine = (images) => ({
  open: async (data) => {
    if (!images[data]) throw new Error('unreadable image')
    return { lines: images[data], paint: async () => ({ data: `painted:${data}`, mediaType: 'image/png' }), close: () => {} }
  },
})

const setupWithImages = async (t, images, options = { media: 'redact' }) => {
  const vault = openVault(mkdtempSync(join(tmpdir(), 'llm-mask-proxy-')))
  const masker = createMasker({ vault, detect: createDetector({ dictionary: [] }) })
  const upstream = await startUpstream((request, res) => json(res, 200, reply('ok')))
  const audit = []
  const proxy = await startProxy({
    upstream: upstream.url,
    masker,
    redactor: images && createRedactor({ engine: paintingEngine(images), masker }),
    options: { systemNote: false, keepMasked: [], ...options },
    audit: (entry) => audit.push(entry),
  })
  t.after(async () => {
    await proxy.close()
    await upstream.close()
  })
  return { upstream, audit, url: `http://127.0.0.1:${proxy.port}` }
}

const picture = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })

test('image is painted before the request is forwarded when media is set to redact', async (t) => {
  const { upstream, url } = await setupWithImages(t, { SHOT: ['DB_PASSWORD=hunter2hunter42'] })
  await post(`${url}/v1/messages`, message([{ type: 'text', text: 'see the screenshot' }, picture('SHOT')]))

  assert.deepEqual(JSON.parse(upstream.requests[0].body).messages[0].content, [
    { type: 'text', text: 'see the screenshot' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'painted:SHOT' } },
  ])
})

test('value seen in an image is masked in the text of the same request', async (t) => {
  const { upstream, url } = await setupWithImages(t, { SHOT: ['DB_PASSWORD=hunter2hunter42'] })
  await post(`${url}/v1/messages`, message([picture('SHOT'), { type: 'text', text: 'why is hunter2hunter42 rejected' }]))

  assert.match(JSON.parse(upstream.requests[0].body).messages[0].content[1].text, /^why is MSK_SECRET_[0-9a-f]{10} rejected$/)
})

test('audit entry reports painted, untouched and removed images', async (t) => {
  const { audit, url } = await setupWithImages(t, { SHOT: ['DB_PASSWORD=hunter2hunter42'], CLEAN: ['hello world'] })
  await post(`${url}/v1/messages`, message([picture('SHOT'), picture('CLEAN'), picture('BROKEN')]))

  assert.deepEqual(audit[0].media, { redacted: 1, clean: 1, removed: 1 })
  assert.deepEqual(audit[0].counts, { SECRET: 1 })
})

test('images are not inspected when media is set to pass', async (t) => {
  const { upstream, audit, url } = await setupWithImages(t, { SHOT: ['DB_PASSWORD=hunter2hunter42'] }, { media: 'pass' })
  await post(`${url}/v1/messages`, message([picture('SHOT')]))

  assert.deepEqual(JSON.parse(upstream.requests[0].body).messages[0].content, [picture('SHOT')])
  assert.equal(audit[0].media, undefined)
})

test('request is refused when media is set to redact and nothing can inspect images', async (t) => {
  const { upstream, url } = await setupWithImages(t, null)
  const response = await post(`${url}/v1/messages`, message([picture('SHOT')]))

  assert.equal(response.status, 500)
  assert.equal(upstream.requests.length, 0)
})

const setupSecure = async (t, authorities) => {
  const certificate = createCertificate()
  const requests = []
  const server = createSecureServer({ key: certificate.key, cert: certificate.cert }, (req, res) => {
    req.resume()
    req.on('end', () => {
      requests.push(req.url)
      json(res, 200, reply('ok'))
    })
  })
  const port = await listen(server)
  const vault = openVault(mkdtempSync(join(tmpdir(), 'llm-mask-proxy-')))
  const masker = createMasker({ vault, detect: createDetector({ dictionary: [] }) })
  const proxy = await startProxy({
    upstream: `https://127.0.0.1:${port}`,
    masker,
    authorities: authorities(certificate),
    options: { systemNote: false, media: 'pass', keepMasked: [] },
  })
  t.after(async () => {
    await proxy.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return { requests, url: `http://127.0.0.1:${proxy.port}` }
}

test('secure upstream signed by a given authority is accepted', async (t) => {
  const { requests, url } = await setupSecure(t, (certificate) => [certificate.cert])
  const response = await post(`${url}/v1/messages`, message('hi'))

  assert.equal(response.status, 200)
  assert.deepEqual(requests, ['/v1/messages'])
})

test('secure upstream signed by an unknown authority is refused', async (t) => {
  const { requests, url } = await setupSecure(t, () => [createCertificate().cert])
  const response = await post(`${url}/v1/messages`, message('hi'))

  assert.equal(response.status, 502)
  assert.deepEqual(requests, [])
})

test('secure upstream signed by an unknown authority is refused when no authorities are given', async (t) => {
  const { requests, url } = await setupSecure(t, () => [])
  const response = await post(`${url}/v1/messages`, message('hi'))

  assert.equal(response.status, 502)
  assert.deepEqual(requests, [])
})

const VIEWER_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

const setupWithViewer = async (t, respond, viewerToken = VIEWER_KEY) => {
  const vault = openVault(mkdtempSync(join(tmpdir(), 'llm-mask-proxy-')))
  const masker = createMasker({ vault, detect: createDetector({ dictionary: ['domain:corp.example'] }) })
  const host = vault.placeholderFor('gitlab.corp.example', 'HOST')
  const upstream = await startUpstream((request, res) => respond(request, res, host))
  const proxy = await startProxy({ upstream: upstream.url, masker, viewerToken, options: { systemNote: false, media: 'pass', keepMasked: [] } })
  t.after(async () => {
    await proxy.close()
    await upstream.close()
  })
  const url = `http://127.0.0.1:${proxy.port}`
  const exchanges = async () => (await fetch(`${proxy.viewer}exchanges`)).json()
  const exchange = async (id) => (await fetch(`${proxy.viewer}exchanges/${id}`)).json()
  return { upstream, proxy, host, url, exchanges, exchange }
}

test('viewer shows the request as it was sent and the reply as it arrived', async (t) => {
  const { host, url, exchanges, exchange } = await setupWithViewer(t, (request, res, placeholder) => json(res, 200, reply(`opened ${placeholder}`)))
  const answer = await (await post(`${url}/v1/messages`, message('open gitlab.corp.example'))).json()
  const [summary] = await exchanges()
  const full = await exchange(summary.id)

  assert.equal(answer.content[0].text, 'opened gitlab.corp.example')
  assert.equal(summary.status, 200)
  assert.equal(summary.done, true)
  assert.deepEqual(summary.counts, { HOST: 1 })
  assert.deepEqual(full.request.messages, [{ role: 'user', content: `open ${host}` }])
  assert.deepEqual(full.response.content, [{ type: 'text', text: `opened ${host}` }])
  assert.equal(JSON.stringify(full).includes('corp.example'), false)
})

test('viewer shows a streamed reply as it arrived', async (t) => {
  const { host, url, exchanges, exchange } = await setupWithViewer(t, (request, res, placeholder) => {
    const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    res.write(frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `opened ${placeholder.slice(0, 8)}` } }))
    res.write(frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${placeholder.slice(8)} for you` } }))
    res.write(frame({ type: 'content_block_stop', index: 0 }))
    res.end(frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }))
  })
  const body = await (await post(`${url}/v1/messages`, { ...message('open gitlab.corp.example'), stream: true })).text()
  const [summary] = await exchanges()
  const full = await exchange(summary.id)

  assert.equal(body.includes('gitlab.corp.example for you'), true)
  assert.deepEqual(full.response.content, [{ type: 'text', text: `opened ${host} for you` }])
  assert.equal(full.response.stop_reason, 'end_turn')
  assert.equal(summary.done, true)
})

test('viewer lists a request that was refused', async (t) => {
  const { url, exchanges } = await setupWithViewer(t, (request, res) => json(res, 200, reply('ok')))
  await post(`${url}/v1/messages`, 'not json with gitlab.corp.example')
  const [summary] = await exchanges()

  assert.equal(summary.status, 400)
  assert.equal(summary.refused, true)
  assert.equal(JSON.stringify(await exchanges()).includes('corp.example'), false)
})

test('viewer lists the exchange with the size of what was sent', async (t) => {
  const { upstream, url, exchanges } = await setupWithViewer(t, (request, res) => json(res, 200, reply('ok')))
  await post(`${url}/v1/messages`, message('open gitlab.corp.example'))
  const [summary] = await exchanges()

  assert.equal(summary.bytes, Buffer.byteLength(upstream.requests[0].body))
})

test('viewer addresses are never forwarded', async (t) => {
  const { upstream, url } = await setupWithViewer(t, (request, res) => json(res, 200, reply('ok')))
  await fetch(`${url}/__llm-mask/00000000000000000000000000000000/exchanges`)
  await fetch(`${url}/__llm-mask/`)

  assert.deepEqual(upstream.requests, [])
})

test('viewer addresses are never forwarded when the viewer is off', async (t) => {
  const { upstream, proxy, url } = await setupWithViewer(t, (request, res) => json(res, 200, reply('ok')), null)
  const response = await fetch(`${url}/__llm-mask/${VIEWER_KEY}/exchanges`)

  assert.equal(proxy.viewer, undefined)
  assert.equal(response.status, 404)
  assert.deepEqual(upstream.requests, [])
})

test('proxy accepts connections from the local machine only', async (t) => {
  const { proxy } = await setup(t, (request, res) => json(res, 200, reply('ok')))
  assert.equal(proxy.address, '127.0.0.1')
})
