import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from '../src/launcher.js'
import { buildHelper, createNativeEngine } from '../src/native.js'
import { createCertificate } from './helpers/certificates.js'
import { openVault } from '../src/vault.js'

const tempDir = (name) => mkdtempSync(join(tmpdir(), `llm-mask-${name}-`))

const startUpstream = async () => {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ url: req.url, headers: req.headers, body })
      const [placeholder = 'nothing'] = body.match(/MSK_[A-Z]+_[0-9a-f]{10}/) ?? []
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: `seen ${placeholder}` }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

const CLIENT = `
const { writeFileSync } = require('node:fs')
const report = { env: {} }
for (const name of ['ANTHROPIC_BASE_URL', 'NO_PROXY', 'no_proxy', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'DISABLE_BUG_COMMAND', 'ANTHROPIC_API_KEY', 'LLM_MASK_ACTIVE']) report.env[name] = process.env[name]
report.args = process.argv.slice(2)
fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY },
  body: JSON.stringify({ messages: [{ role: 'user', content: process.env.TEST_IMAGE ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: require('node:fs').readFileSync(process.env.TEST_IMAGE).toString('base64') } }] : process.env.TEST_PROMPT }] }),
})
  .then((response) => response.json())
  .then((body) => {
    report.reply = body.content[0].text
    writeFileSync(process.env.TEST_REPORT, JSON.stringify(report))
    process.exit(Number(process.env.TEST_EXIT ?? 0))
  })
`

const setup = async (t, { env = {}, files = {}, home = tempDir('home') } = {}) => {
  const upstream = await startUpstream()
  t.after(() => upstream.close())
  const cwd = tempDir('cwd')
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content)
  const script = join(cwd, 'client.cjs')
  writeFileSync(script, CLIENT)
  const reportFile = join(cwd, 'report.json')
  const run = (prompt, extra = {}, identities = {}) =>
    launch({
      command: process.execPath,
      args: [script, 'first', '--second'],
      cwd,
      home,
      identities,
      env: { PATH: process.env.PATH, ANTHROPIC_BASE_URL: upstream.url, ANTHROPIC_API_KEY: 'key-for-gateway', TEST_PROMPT: prompt, TEST_REPORT: reportFile, ...env, ...extra },
    })
  const report = () => JSON.parse(readFileSync(reportFile, 'utf8'))
  return { upstream, run, report, home, cwd }
}

test('command talks to the upstream through the proxy with masking both ways', async (t) => {
  const { upstream, run, report } = await setup(t)
  await run('mail a.user@corp.example')

  assert.equal(upstream.requests.length, 1)
  assert.equal(upstream.requests[0].body.includes('a.user@corp.example'), false)
  assert.match(upstream.requests[0].body, /MSK_EMAIL_[0-9a-f]{10}/)
  assert.equal(report().reply, 'seen a.user@corp.example')
})

test('command is pointed at a local address instead of the upstream', async (t) => {
  const { upstream, run, report } = await setup(t)
  await run('hi')

  assert.match(report().env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.notEqual(report().env.ANTHROPIC_BASE_URL, upstream.url)
})

test('command keeps its credentials and arguments', async (t) => {
  const { upstream, run, report } = await setup(t)
  await run('hi')

  assert.equal(report().env.ANTHROPIC_API_KEY, 'key-for-gateway')
  assert.equal(upstream.requests[0].headers['x-api-key'], 'key-for-gateway')
  assert.deepEqual(report().args, ['first', '--second'])
})

test('command has reporting switched off and the local address excluded from system proxies', async (t) => {
  const { run, report } = await setup(t, { env: { NO_PROXY: 'gateway.internal' } })
  await run('hi')

  const { env } = report()
  assert.equal(env.DISABLE_TELEMETRY, '1')
  assert.equal(env.DISABLE_ERROR_REPORTING, '1')
  assert.equal(env.DISABLE_BUG_COMMAND, '1')
  assert.deepEqual(env.NO_PROXY.split(','), ['gateway.internal', '127.0.0.1', 'localhost'])
  assert.deepEqual(env.no_proxy.split(','), ['gateway.internal', '127.0.0.1', 'localhost'])
})

test('exit code of the command is returned', async (t) => {
  const { run } = await setup(t)
  assert.equal(await run('hi', { TEST_EXIT: '7' }), 7)
  assert.equal(await run('hi'), 0)
})

test('dictionary from the home directory is applied', async (t) => {
  const home = tempDir('home')
  writeFileSync(join(home, 'dictionary.txt'), 'domain:corp.example\n')
  const { upstream, run, report } = await setup(t, { home })
  await run('open gitlab.corp.example')

  assert.equal(upstream.requests[0].body.includes('corp.example'), false)
  assert.equal(report().reply, 'seen gitlab.corp.example')
})

test('values from env files in the working directory are masked', async (t) => {
  const { upstream, run } = await setup(t, { files: { '.env': 'VITE_RS_URL=https://rs.dev.corp.example/api\n' } })
  await run('request https://rs.dev.corp.example/api/patterns failed')

  const [{ content }] = JSON.parse(upstream.requests[0].body).messages
  assert.match(content, /^request https:\/\/MSK_HOST_[0-9a-f]{10}\/api\/patterns failed$/)
})

test('values from env files are left alone when the config switches that off', async (t) => {
  const home = tempDir('home')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ envFiles: false, systemNote: false }))
  const { upstream, run } = await setup(t, { home, files: { '.env': 'BUILD_LABEL=nightly-build-42\n' } })
  await run('label nightly-build-42 is stale')

  assert.deepEqual(JSON.parse(upstream.requests[0].body).messages, [{ role: 'user', content: 'label nightly-build-42 is stale' }])
})

test('values from env files are masked wherever they appear by default', async (t) => {
  const { upstream, run } = await setup(t, { files: { '.env': 'BUILD_LABEL=nightly-build-42\n' } })
  await run('label nightly-build-42 is stale')

  assert.match(JSON.parse(upstream.requests[0].body).messages[0].content, /^label MSK_TERM_[0-9a-f]{10} is stale$/)
})

test('public domains from the config are left readable', async (t) => {
  const home = tempDir('home')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ publicDomains: ['docs.vendor.kz'] }))
  const { upstream, run } = await setup(t, { home })
  await run('compare https://docs.vendor.kz/guide with https://portal.corp.kz/guide')

  assert.match(JSON.parse(upstream.requests[0].body).messages[0].content, /^compare https:\/\/docs\.vendor\.kz\/guide with https:\/\/MSK_HOST_[0-9a-f]{10}\/guide$/)
})

test('learned values are on disk after the command exits', async (t) => {
  const { upstream, run, home } = await setup(t)
  await run('mail a.user@corp.example')

  const [placeholder] = upstream.requests[0].body.match(/MSK_EMAIL_[0-9a-f]{10}/)
  assert.equal(openVault(home).valueFor(placeholder), 'a.user@corp.example')
})

test('audit log records the request without any value', async (t) => {
  const { run, home } = await setup(t)
  await run('mail a.user@corp.example')

  const [line] = readFileSync(join(home, 'audit.log'), 'utf8').trim().split('\n')
  const entry = JSON.parse(line)
  assert.equal(entry.path, '/v1/messages')
  assert.deepEqual(entry.counts, { EMAIL: 1 })
  assert.equal(line.includes('a.user'), false)
})

test('upstream defaults to the anthropic api when no base url is set', async (t) => {
  const { upstream, cwd } = await setup(t)
  const code = await launch({
    command: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(join(cwd, 'upstream.txt'))}, process.env.LLM_MASK_UPSTREAM)`],
    cwd,
    home: tempDir('home'),
    env: { PATH: process.env.PATH },
  })

  assert.equal(code, 0)
  assert.equal(readFileSync(join(cwd, 'upstream.txt'), 'utf8'), 'https://api.anthropic.com')
  assert.equal(upstream.requests.length, 0)
})

test('launch inside an already masked session does not start a second proxy', async (t) => {
  const { upstream, run, report } = await setup(t, { env: { LLM_MASK_ACTIVE: '1' } })
  await run('mail a.user@corp.example')

  assert.equal(report().env.ANTHROPIC_BASE_URL, upstream.url)
})

test('command that cannot be started is reported', async (t) => {
  const { cwd } = await setup(t)
  await assert.rejects(
    launch({ command: join(cwd, 'missing-binary'), args: [], cwd, home: tempDir('home'), env: { PATH: process.env.PATH } }),
    /missing-binary/,
  )
})

test('image is painted on the way out when the config asks for it', async (t) => {
  const home = tempDir('home')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ media: 'redact' }))
  const original = fileURLToPath(new URL('./fixtures/secrets.png', import.meta.url))
  const { upstream, run } = await setup(t, { home })
  await run('unused', { TEST_IMAGE: original })

  const { source } = JSON.parse(upstream.requests[0].body).messages[0].content[0]
  const session = await createNativeEngine({ binary: await buildHelper() }).open(source.data, source.media_type)
  session.close()
  const text = session.lines.join('\n')
  assert.notEqual(source.data, readFileSync(original).toString('base64'))
  assert.equal(text.includes('hunter2hunter42'), false)
  assert.equal(text.includes('owner.person'), false)
  assert.match(text, /nothing secret on this line/)
})

test('image is sent untouched when the config does not ask for painting', async (t) => {
  const original = fileURLToPath(new URL('./fixtures/secrets.png', import.meta.url))
  const { upstream, run } = await setup(t)
  await run('unused', { TEST_IMAGE: original })

  const { source } = JSON.parse(upstream.requests[0].body).messages[0].content[0]
  assert.equal(source.data, readFileSync(original).toString('base64'))
})

test('secure upstream is reached with the authorities named in the environment', async (t) => {
  const certificate = createCertificate()
  const seen = []
  const server = createSecureServer({ key: certificate.key, cert: certificate.cert }, (req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push(req.url)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'secure reply' }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    return new Promise((resolve) => server.close(resolve))
  })
  const { run, report } = await setup(t)
  await run('hi', { ANTHROPIC_BASE_URL: `https://127.0.0.1:${server.address().port}`, NODE_EXTRA_CA_CERTS: certificate.file })

  assert.deepEqual(seen, ['/v1/messages'])
  assert.equal(report().reply, 'secure reply')
})

const WATCHER = `
const { readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const sessions = join(process.env.TEST_HOME, 'sessions')
const [file] = readdirSync(sessions)
const session = JSON.parse(readFileSync(join(sessions, file), 'utf8'))
fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'mail a.user@corp.example' }] }),
})
  .then(() => fetch(session.viewer + 'exchanges'))
  .then((response) => response.json())
  .then((list) => fetch(session.viewer + 'exchanges/' + list[0].id))
  .then((response) => response.json())
  .then((exchange) => {
    writeFileSync(process.env.TEST_REPORT, JSON.stringify({ file, session, exchange, mode: require('node:fs').statSync(join(sessions, file)).mode & 0o777 }))
  })
`

const watched = async (t, config) => {
  const home = tempDir('home')
  if (config) writeFileSync(join(home, 'config.json'), JSON.stringify(config))
  const { upstream, cwd } = await setup(t, { home })
  const script = join(cwd, 'watcher.cjs')
  const reportFile = join(cwd, 'watch-report.json')
  writeFileSync(script, WATCHER)
  const code = await launch({
    command: process.execPath,
    args: [script],
    cwd,
    home,
    env: { PATH: process.env.PATH, ANTHROPIC_BASE_URL: upstream.url, TEST_HOME: home, TEST_REPORT: reportFile },
  })
  return { code, home, report: () => JSON.parse(readFileSync(reportFile, 'utf8')) }
}

test('running session is announced with the address of its viewer', async (t) => {
  const { code, report } = await watched(t)
  const { file, session, mode } = report()

  assert.equal(code, 0)
  assert.equal(file, `${session.pid}.json`)
  assert.match(session.viewer, /^http:\/\/127\.0\.0\.1:\d+\/__llm-mask\/[0-9a-f]{32}\/$/)
  assert.match(session.started, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(Object.keys(session).sort(), ['pid', 'started', 'viewer'])
  assert.equal(mode, 0o600)
})

test('viewer of a running session shows what was sent', async (t) => {
  const { report } = await watched(t)
  const { exchange } = report()

  assert.match(exchange.request.messages[0].content, /^mail MSK_EMAIL_[0-9a-f]{10}$/)
  assert.equal(JSON.stringify(exchange).includes('a.user'), false)
})

test('announcement is removed when the session ends', async (t) => {
  const { home } = await watched(t)
  assert.deepEqual(readdirSync(join(home, 'sessions')), [])
})

test('each session gets its own key', async (t) => {
  const first = (await watched(t)).report().session.viewer
  const second = (await watched(t)).report().session.viewer
  assert.notEqual(first.split('/').at(-2), second.split('/').at(-2))
})

test('session is not announced when the viewer is switched off', async (t) => {
  const home = tempDir('home')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ viewer: false }))
  const { run } = await setup(t, { home })
  await run('hi')

  assert.equal(existsSync(join(home, 'sessions')) && readdirSync(join(home, 'sessions')).length > 0, false)
})

test('identities of this machine are hidden and restored in the reply', async (t) => {
  const { upstream, run } = await setup(t)
  await run('open /Users/jsmith/project owned by John Smith', {}, { account: 'jsmith', fullName: 'John Smith' })

  const [{ content }] = JSON.parse(upstream.requests[0].body).messages
  assert.match(content, /^open \/Users\/MSK_LOGIN_[0-9a-f]{10}\/project owned by MSK_NAME_[0-9a-f]{10}$/)
})

test('identities of this machine are left alone when the config switches that off', async (t) => {
  const home = tempDir('home')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ identities: false, systemNote: false }))
  const { upstream, run } = await setup(t, { home })
  await run('open /Users/jsmith/project owned by John Smith', {}, { account: 'jsmith', fullName: 'John Smith' })

  assert.deepEqual(JSON.parse(upstream.requests[0].body).messages, [{ role: 'user', content: 'open /Users/jsmith/project owned by John Smith' }])
})
