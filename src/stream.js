import { isKeptMasked } from './request.js'

const PARTIAL_PLACEHOLDER = /M(?:S(?:K(?:_(?:[A-Z]+(?:_[0-9a-f]*)?)?)?)?)?$/i
const EVENT_END = /\r?\n\r?\n/g

export const createTextUnmasker = (masker, { json = false } = {}) => {
  let held = ''

  const push = (chunk) => {
    const text = held + chunk
    const cut = PARTIAL_PLACEHOLDER.exec(text)?.index ?? text.length
    held = text.slice(cut)
    return masker.unmask(text.slice(0, cut), { json })
  }

  const flush = () => {
    const rest = masker.unmask(held, { json })
    held = ''
    return rest
  }

  return { push, flush }
}

const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`

const parse = (raw) => {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

export const createSseUnmasker = (masker, { keepMasked }) => {
  const blocks = new Map()
  let pending = ''

  const open = ({ index, content_block: block }) => {
    if (block?.type === 'text') {
      blocks.set(index, { kind: 'text_delta', field: 'text', unmasker: createTextUnmasker(masker) })
    }
    if (block?.type === 'tool_use' && !isKeptMasked(block.name, keepMasked)) {
      blocks.set(index, { kind: 'input_json_delta', field: 'partial_json', unmasker: createTextUnmasker(masker, { json: true }) })
    }
  }

  const delta = (index, { kind, field }, value) => frame({ type: 'content_block_delta', index, delta: { type: kind, [field]: value } })

  const transform = (raw) => {
    const event = parse(raw)
    if (!event) return raw
    if (event.type === 'content_block_start') {
      open(event)
      return raw
    }
    const block = blocks.get(event.index)
    if (!block) return raw
    if (event.type === 'content_block_delta') {
      if (event.delta?.type !== block.kind) return raw
      const received = event.delta[block.field]
      const restored = block.unmasker.push(received)
      if (restored === received) return raw
      return restored ? delta(event.index, block, restored) : ''
    }
    if (event.type === 'content_block_stop') {
      blocks.delete(event.index)
      const rest = block.unmasker.flush()
      return (rest ? delta(event.index, block, rest) : '') + raw
    }
    return raw
  }

  const push = (chunk) => {
    pending += chunk
    let output = ''
    let consumed = 0
    EVENT_END.lastIndex = 0
    let match
    while ((match = EVENT_END.exec(pending))) {
      const end = match.index + match[0].length
      output += transform(pending.slice(consumed, end))
      consumed = end
    }
    pending = pending.slice(consumed)
    return output
  }

  const flush = () => {
    const rest = pending
    pending = ''
    return rest
  }

  return { push, flush }
}
