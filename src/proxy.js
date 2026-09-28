import { createServer, request as requestHttp } from 'node:http'
import { request as requestHttps } from 'node:https'
import { StringDecoder } from 'node:string_decoder'
import { rootCertificates } from 'node:tls'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { maskAnyJson, maskRequest, unmaskResponse } from './request.js'
import { createSseUnmasker } from './stream.js'

const MESSAGES_PATH = /\/v1\/messages(?:\/count_tokens)?$/
const REQUEST_HEADERS_DROPPED = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'content-length', 'transfer-encoding', 'accept-encoding'])
const RESPONSE_HEADERS_DROPPED = new Set(['connection', 'keep-alive', 'content-length', 'transfer-encoding'])
const RESPONSE_HEADERS_DECODED = new Set([...RESPONSE_HEADERS_DROPPED, 'content-encoding'])
const DECODERS = { gzip: createGunzip, 'x-gzip': createGunzip, deflate: createInflate, br: createBrotliDecompress }

const without = (headers, dropped) => Object.fromEntries(Object.entries(headers).filter(([name]) => !dropped.has(name)))

const readAll = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })

const sendJson = (res, status, body, headers = {}) => {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { ...headers, 'content-type': 'application/json', 'content-length': payload.length })
  res.end(payload)
}

const refusal = (message) => ({ type: 'error', error: { type: 'llm_mask_error', message: `llm-mask: ${message}` } })

export const startProxy = async ({ upstream, masker, redactor, authorities = [], options, audit = () => {}, persist = () => {} }) => {
  const target = new URL(upstream)
  const send = target.protocol === 'https:' ? requestHttps : requestHttp
  const prefix = target.pathname.replace(/\/$/, '')
  const ca = authorities.length ? [...rootCertificates, ...authorities] : undefined

  const maskMessages = async (parsed, entry) => {
    if (options.media !== 'redact') return maskRequest(parsed, masker, options)
    const inspected = await redactor.redactImages(parsed)
    const masked = maskRequest(inspected.body, masker, options)
    entry.media = inspected.media
    for (const [category, amount] of Object.entries(inspected.counts)) masked.counts[category] = (masked.counts[category] ?? 0) + amount
    return masked
  }

  const maskBody = async (req, path, raw, entry) => {
    if (!raw.length) return { body: raw }
    if (!(req.headers['content-type'] ?? '').includes('json') || req.headers['content-encoding']) {
      return { status: 415, message: 'only plain json request bodies can be masked, request was not sent' }
    }
    let parsed
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      return { status: 400, message: 'request body is not valid json, request was not sent' }
    }
    try {
      const masked = MESSAGES_PATH.test(path) ? await maskMessages(parsed, entry) : maskAnyJson(parsed, masker)
      entry.counts = masked.counts
      entry.skipped = masked.skipped
      persist()
      return { body: Buffer.from(JSON.stringify(masked.body)) }
    } catch {
      return { status: 500, message: 'masking failed, request was not sent' }
    }
  }

  const relay = (incoming, res, entry) => {
    const encoding = incoming.headers['content-encoding']
    const decode = DECODERS[encoding]
    const readable = !encoding || Boolean(decode)
    const source = decode ? incoming.pipe(decode()) : incoming
    const headers = without(incoming.headers, decode ? RESPONSE_HEADERS_DECODED : RESPONSE_HEADERS_DROPPED)
    const type = incoming.headers['content-type'] ?? ''
    entry.status = incoming.statusCode
    const finish = () => audit(entry)
    incoming.on('error', () => res.destroy())
    source.on('error', () => res.destroy())

    if (readable && type.includes('text/event-stream')) {
      const decoder = new StringDecoder('utf8')
      const unmasker = createSseUnmasker(masker, options)
      res.writeHead(incoming.statusCode, headers)
      source.on('data', (chunk) => {
        const restored = unmasker.push(decoder.write(chunk))
        if (restored) res.write(restored)
      })
      source.on('end', () => {
        res.end(unmasker.push(decoder.end()) + unmasker.flush())
        finish()
      })
      return
    }

    if (readable && type.includes('json')) {
      readAll(source).then(
        (raw) => {
          let payload = raw
          try {
            payload = Buffer.from(JSON.stringify(unmaskResponse(JSON.parse(raw.toString('utf8')), masker, options)))
          } catch {}
          res.writeHead(incoming.statusCode, { ...headers, 'content-length': payload.length })
          res.end(payload)
          finish()
        },
        () => res.destroy(),
      )
      return
    }

    res.writeHead(incoming.statusCode, headers)
    source.pipe(res)
    source.on('end', finish)
  }

  const handle = async (req, res) => {
    const path = req.url.split('?')[0]
    const entry = { time: new Date().toISOString(), method: req.method, path, counts: {}, skipped: {} }
    const fail = (status, message) => {
      Object.assign(entry, { status, refused: true })
      audit(entry)
      if (res.headersSent) res.destroy()
      else sendJson(res, status, refusal(message))
    }

    const masked = await maskBody(req, path, await readAll(req), entry)
    if (masked.status) return fail(masked.status, masked.message)

    const headers = { ...without(req.headers, REQUEST_HEADERS_DROPPED), host: target.host, 'accept-encoding': 'identity' }
    if (masked.body.length) headers['content-length'] = masked.body.length

    const outgoing = send(
      { protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: prefix + req.url, headers, ca },
      (incoming) => relay(incoming, res, entry),
    )
    outgoing.on('error', () => fail(502, 'upstream is unreachable'))
    res.on('close', () => {
      if (!res.writableFinished) outgoing.destroy()
    })
    outgoing.end(masked.body)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy())
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const { port, address } = server.address()
  const close = () =>
    new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections()
    })

  return { port, address, close }
}
