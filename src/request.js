const SYSTEM_NOTE =
  'Some values in this conversation are replaced with placeholders such as MSK_HOST_3fa9c1d2ab. ' +
  "Each placeholder stands for a real value that is restored on the user's machine. " +
  'Treat a placeholder as an opaque literal: copy it exactly wherever the value is needed, ' +
  'and never alter it, split it, or guess what it stands for.'

const MEDIA_NOTICE = '[llm-mask: attachment removed before sending]'

const mapValues = (object, change) => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, change(value, key)]))

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const deepStrings = (value, change) => {
  if (typeof value === 'string') return change(value)
  if (Array.isArray(value)) return value.map((item) => deepStrings(item, change))
  if (isObject(value)) return mapValues(value, (item) => deepStrings(item, change))
  return value
}

const isBinary = ({ type, source }) => type === 'image' || (source?.type !== 'text' && source?.type !== 'content')

export const isKeptMasked = (name, patterns) =>
  patterns.some((pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern))

export const maskRequest = (body, masker, { systemNote, media }) => {
  const counts = {}
  const skipped = {}
  const count = (bucket, key, amount = 1) => {
    bucket[key] = (bucket[key] ?? 0) + amount
  }

  const maskText = (value) => {
    const { text, counts: found } = masker.mask(value)
    for (const [category, amount] of Object.entries(found)) count(counts, category, amount)
    return text
  }

  const maskContent = (content) => {
    if (typeof content === 'string') return maskText(content)
    if (Array.isArray(content)) return content.map(maskBlock)
    return content
  }

  const maskAttachment = (block) => {
    if (isBinary(block)) {
      if (media !== 'block') return block
      count(counts, 'MEDIA')
      return { type: 'text', text: MEDIA_NOTICE }
    }
    return mapValues(block, (value, key) => {
      if (key === 'title' || key === 'context') return typeof value === 'string' ? maskText(value) : value
      if (key !== 'source') return value
      return mapValues(value, (inner, innerKey) => {
        if (innerKey === 'data') return maskText(inner)
        if (innerKey === 'content') return maskContent(inner)
        return inner
      })
    })
  }

  const maskBlock = (block) => {
    switch (block.type) {
      case 'text':
        return { ...block, text: maskText(block.text) }
      case 'tool_use':
        return { ...block, input: deepStrings(block.input, maskText) }
      case 'tool_result':
        return 'content' in block ? { ...block, content: maskContent(block.content) } : block
      case 'image':
      case 'document':
        return maskAttachment(block)
      case 'thinking':
      case 'redacted_thinking':
        return block
      default:
        count(skipped, block.type)
        return block
    }
  }

  const maskDescriptions = (value) => {
    if (Array.isArray(value)) return value.map(maskDescriptions)
    if (!isObject(value)) return value
    return mapValues(value, (item, key) => (key === 'description' && typeof item === 'string' ? maskText(item) : maskDescriptions(item)))
  }

  const addNote = (system) => {
    if (system === undefined) return SYSTEM_NOTE
    if (typeof system === 'string') return `${system}\n\n${SYSTEM_NOTE}`
    return [...system, { type: 'text', text: SYSTEM_NOTE }]
  }

  const masked = { ...body }
  if ('system' in body) masked.system = maskContent(body.system)
  if (Array.isArray(body.messages)) masked.messages = body.messages.map((message) => ({ ...message, content: maskContent(message.content) }))
  if (Array.isArray(body.tools)) masked.tools = maskDescriptions(body.tools)
  if (systemNote) masked.system = addNote(masked.system)

  return { body: masked, counts, skipped }
}

export const maskAnyJson = (body, masker) => {
  const counts = {}
  const masked = deepStrings(body, (value) => {
    const { text, counts: found } = masker.mask(value)
    for (const [category, amount] of Object.entries(found)) counts[category] = (counts[category] ?? 0) + amount
    return text
  })
  return { body: masked, counts, skipped: {} }
}

export const unmaskResponse = (body, masker, { keepMasked }) => {
  const restore = (value) => deepStrings(value, (text) => masker.unmask(text))

  const restoreBlock = (block) => {
    if (block.type === 'text') return { ...block, text: masker.unmask(block.text) }
    if (block.type === 'tool_use' && !isKeptMasked(block.name, keepMasked)) return { ...block, input: restore(block.input) }
    return block
  }

  const restored = { ...body }
  if (Array.isArray(body.content)) restored.content = body.content.map(restoreBlock)
  if (isObject(body.error)) restored.error = restore(body.error)
  return restored
}
