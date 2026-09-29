import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createRecorder } from '../src/recorder.js'
import { createViewer, VIEWER_PREFIX } from '../src/viewer.js'

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

const setup = async (t) => {
  const recorder = createRecorder()
  const viewer = createViewer({ recorder, token: TOKEN })
  const passed = []
  const server = createServer((req, res) => {
    if (viewer.handle(req, res)) return
    passed.push(req.url)
    res.writeHead(204)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}${VIEWER_PREFIX}/${TOKEN}`
  return { recorder, passed, port, base }
}

const withHost = (port, path, host, method = 'GET') =>
  new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { host } }, (incoming) => {
      incoming.resume()
      incoming.on('end', () => resolve(incoming.statusCode))
    })
    outgoing.on('error', reject)
    outgoing.end()
  })

test('page is served as a document that cannot be cached', async (t) => {
  const { base } = await setup(t)
  const response = await fetch(`${base}/`)

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/html/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(await response.text(), /<!doctype html>/i)
})

test('page is forbidden from loading anything from outside', async (t) => {
  const { base } = await setup(t)
  const policy = (await fetch(`${base}/`)).headers.get('content-security-policy')

  assert.match(policy, /default-src 'none'/)
  assert.match(policy, /connect-src 'self'/)
  assert.equal(/https?:/.test(policy), false)
})

test('page itself names no outside address', async (t) => {
  const { base } = await setup(t)
  const page = await (await fetch(`${base}/`)).text()

  assert.deepEqual(page.match(/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//gi) ?? [], [])
  assert.equal(/@import|url\(\s*["']?https?:/i.test(page), false)
})

test('page carries the rules that tell what the person wrote from what was added', async (t) => {
  const { base } = await setup(t)
  const page = await (await fetch(`${base}/`)).text()

  assert.match(page, /const splitParts = /)
  assert.equal(page.includes('SHARED_PARTS'), false)
  assert.equal(/^export /m.test(page), false)
})

test('list of exchanges is served', async (t) => {
  const { recorder, base } = await setup(t)
  recorder.begin({ method: 'POST', path: '/v1/messages', request: { model: 'claude-sonnet-5', messages: [] }, bytes: 10, counts: {} }).end(200)
  const response = await fetch(`${base}/exchanges`)

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^application\/json/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual((await response.json()).map(({ id, status, path }) => ({ id, status, path })), [{ id: '1', status: 200, path: '/v1/messages' }])
})

test('one exchange is served in full', async (t) => {
  const { recorder, base } = await setup(t)
  const exchange = recorder.begin({ method: 'POST', path: '/v1/messages', request: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'open MSK_HOST_0123456789' }] }, bytes: 10, counts: { HOST: 1 } })
  exchange.body({ content: [{ type: 'text', text: 'opening MSK_HOST_0123456789' }], stop_reason: 'end_turn' })
  exchange.end(200)
  const body = await (await fetch(`${base}/exchanges/${exchange.id}`)).json()

  assert.deepEqual(body.request.messages, [{ role: 'user', content: 'open MSK_HOST_0123456789' }])
  assert.deepEqual(body.response.content, [{ type: 'text', text: 'opening MSK_HOST_0123456789' }])
})

test('unknown exchange is not found', async (t) => {
  const { base } = await setup(t)
  assert.equal((await fetch(`${base}/exchanges/999`)).status, 404)
})

test('unknown page under the viewer is not found', async (t) => {
  const { base } = await setup(t)
  assert.equal((await fetch(`${base}/settings`)).status, 404)
})

test('wrong key gives nothing and is not passed on', async (t) => {
  const { passed, port } = await setup(t)
  const response = await fetch(`http://127.0.0.1:${port}${VIEWER_PREFIX}/00000000000000000000000000000000/exchanges`)

  assert.equal(response.status, 404)
  assert.deepEqual(passed, [])
})

test('viewer address without a key gives nothing and is not passed on', async (t) => {
  const { passed, port } = await setup(t)

  assert.equal((await fetch(`http://127.0.0.1:${port}${VIEWER_PREFIX}`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${port}${VIEWER_PREFIX}/`)).status, 404)
  assert.deepEqual(passed, [])
})

test('request that names another host is refused', async (t) => {
  const { port } = await setup(t)

  assert.equal(await withHost(port, `${VIEWER_PREFIX}/${TOKEN}/exchanges`, 'attacker.example'), 403)
  assert.equal(await withHost(port, `${VIEWER_PREFIX}/${TOKEN}/exchanges`, `attacker.example:${port}`), 403)
})

test('request that names this machine is served', async (t) => {
  const { port } = await setup(t)

  assert.equal(await withHost(port, `${VIEWER_PREFIX}/${TOKEN}/exchanges`, `127.0.0.1:${port}`), 200)
  assert.equal(await withHost(port, `${VIEWER_PREFIX}/${TOKEN}/exchanges`, `localhost:${port}`), 200)
})

test('viewer only answers requests that read', async (t) => {
  const { port } = await setup(t)
  assert.equal(await withHost(port, `${VIEWER_PREFIX}/${TOKEN}/exchanges`, `127.0.0.1:${port}`, 'POST'), 405)
})

test('other addresses are left to the proxy', async (t) => {
  const { passed, port } = await setup(t)
  await fetch(`http://127.0.0.1:${port}/v1/models`)

  assert.deepEqual(passed, ['/v1/models'])
})
