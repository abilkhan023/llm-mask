import { describeRequest } from './parts.js'

const EVENT_END = /\r?\n\r?\n/g

const parse = (raw) => {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  try {
    return data ? JSON.parse(data) : null
  } catch {
    return null
  }
}

const finished = ({ partial, ...block }) => {
  if (block.type !== 'tool_use') return block
  try {
    return { ...block, input: partial ? JSON.parse(partial) : block.input }
  } catch {
    return { ...block, input: partial }
  }
}

const createReply = () => {
  const blocks = []
  const reply = {}
  let pending = ''

  const apply = (event) => {
    if (event.type === 'message_start') reply.usage = { ...event.message?.usage }
    if (event.type === 'message_delta') {
      reply.stop_reason = event.delta?.stop_reason
      reply.usage = { ...reply.usage, ...event.usage }
    }
    if (event.type === 'error') reply.error = event.error
    if (event.type === 'content_block_start') {
      const { signature, ...block } = event.content_block
      blocks[event.index] = block.type === 'tool_use' ? { ...block, partial: '' } : block
    }
    const block = blocks[event.index]
    if (event.type !== 'content_block_delta' || !block) return
    if (event.delta.type === 'text_delta') block.text += event.delta.text
    if (event.delta.type === 'thinking_delta') block.thinking += event.delta.thinking
    if (event.delta.type === 'input_json_delta') block.partial += event.delta.partial_json
  }

  const chunk = (text) => {
    pending += text
    let consumed = 0
    EVENT_END.lastIndex = 0
    let match
    while ((match = EVENT_END.exec(pending))) {
      const event = parse(pending.slice(consumed, match.index))
      if (event) apply(event)
      consumed = match.index + match[0].length
    }
    pending = pending.slice(consumed)
  }

  const body = ({ content = [], stop_reason, usage, error }) => {
    blocks.push(...content)
    Object.assign(reply, { stop_reason, usage, error })
  }

  const read = () => {
    const result = { content: blocks.filter(Boolean).map(finished) }
    for (const key of ['stop_reason', 'usage', 'error']) if (reply[key] !== undefined) result[key] = reply[key]
    return result
  }

  return { chunk, body, read }
}

export const createRecorder = ({ limit = 30, maxBytes = 64 * 1024 * 1024 } = {}) => {
  const kept = []
  let counter = 0

  const trim = () => {
    const total = () => kept.reduce((sum, { summary }) => sum + (summary.bytes ?? 0), 0)
    while (kept.length > 1 && (kept.length > limit || total() > maxBytes)) kept.shift()
  }

  const keep = (summary, request) => {
    const entry = { summary: { id: String(++counter), time: new Date().toISOString(), done: false, ...summary }, request, reply: createReply() }
    kept.push(entry)
    trim()
    return entry
  }

  const begin = ({ method, path, request, bytes, counts, media }) => {
    const { summary, reply } = keep(
      { method, path, model: request?.model, messages: request?.messages?.length, bytes, counts, media, ...describeRequest(request) },
      request,
    )
    return {
      id: summary.id,
      chunk: reply.chunk,
      body: reply.body,
      end: (status) => Object.assign(summary, { status, done: true }),
    }
  }

  const refuse = ({ method, path, status, reason }) => {
    const { reply } = keep({ method, path, status, refused: true, done: true })
    reply.body({ error: { type: 'refused', message: reason } })
  }

  const list = () => kept.map(({ summary }) => ({ ...summary })).reverse()

  const get = (id) => {
    const entry = kept.find(({ summary }) => summary.id === id)
    return entry && { ...entry.summary, request: entry.request, response: entry.reply.read() }
  }

  return { begin, refuse, list, get }
}
