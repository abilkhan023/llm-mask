import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const VIEWER_PREFIX = '/__llm-mask'

const PAGE = fileURLToPath(new URL('./viewer.html', import.meta.url))
const SHARED = fileURLToPath(new URL('./parts.js', import.meta.url))
const LOCAL_NAMES = ['127.0.0.1', 'localhost']
const POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'self'",
  'img-src data:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

const send = (res, status, type, body) => {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-security-policy': POLICY,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end(body)
}

const sendJson = (res, value) => send(res, 200, 'application/json', JSON.stringify(value))

const pathOf = (req) => req.url.split('?')[0]

export const isViewerPath = (req) => pathOf(req) === VIEWER_PREFIX || pathOf(req).startsWith(`${VIEWER_PREFIX}/`)

export const refuseViewerPath = (res) => send(res, 404, 'text/plain', 'not found')

const namesThisMachine = (req) => {
  const [name, port] = (req.headers.host ?? '').split(':')
  return LOCAL_NAMES.includes(name) && Number(port) === req.socket.localPort
}

export const createViewer = ({ recorder, token }) => {
  const shared = readFileSync(SHARED, 'utf8').replace(/^export /gm, '')
  const page = readFileSync(PAGE, 'utf8').replace('/*SHARED_PARTS*/', () => shared)
  const base = `${VIEWER_PREFIX}/${token}/`

  const answer = (req, res) => {
    const path = pathOf(req)
    if (!namesThisMachine(req)) return send(res, 403, 'text/plain', 'forbidden')
    if (!path.startsWith(base)) return refuseViewerPath(res)
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'read only')
    const rest = path.slice(base.length)
    if (rest === '') return send(res, 200, 'text/html; charset=utf-8', page)
    if (rest === 'exchanges') return sendJson(res, recorder.list())
    const exchange = rest.startsWith('exchanges/') && recorder.get(rest.slice('exchanges/'.length))
    return exchange ? sendJson(res, exchange) : refuseViewerPath(res)
  }

  const handle = (req, res) => {
    if (!isViewerPath(req)) return false
    answer(req, res)
    return true
  }

  return { handle, address: (port) => `http://127.0.0.1:${port}${base}` }
}
