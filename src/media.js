import { createHash } from 'node:crypto'

const REMOVED_NOTICE = '[llm-mask: attachment removed before sending because it could not be inspected]'

const rangesOf = (lines, matches) => {
  const ranges = []
  let offset = 0
  lines.forEach((line, index) => {
    const from = offset
    const to = offset + line.length
    for (const { start, end } of matches) {
      const first = Math.max(start, from)
      const last = Math.min(end, to)
      if (first < last) ranges.push({ line: index, start: first - from, end: last - from })
    }
    offset = to + 1
  })
  return ranges
}

const tally = (matches) => {
  const counts = {}
  for (const { category } of matches) counts[category] = (counts[category] ?? 0) + 1
  return counts
}

const isReadableDocument = ({ source }) => source?.type === 'text' || source?.type === 'content'

export const createRedactor = ({ engine, masker }) => {
  const inspected = new Map()

  const inspect = async ({ data, media_type: mediaType }) => {
    let session
    try {
      session = await engine.open(data, mediaType)
      const matches = masker.locate(session.lines.join('\n'), { loose: true })
      if (!matches.length) return { status: 'clean', counts: {} }
      const painted = await session.paint(rangesOf(session.lines, matches))
      return { status: 'redacted', counts: tally(matches), source: { type: 'base64', media_type: painted.mediaType, data: painted.data } }
    } catch {
      return { status: 'removed', counts: {} }
    } finally {
      session?.close()
    }
  }

  const inspectOnce = (source) => {
    const key = createHash('sha256').update(source.data).digest('hex')
    if (!inspected.has(key)) inspected.set(key, inspect(source))
    return inspected.get(key)
  }

  const redactImages = async (body) => {
    const counts = {}
    const media = { redacted: 0, clean: 0, removed: 0 }

    const remove = () => {
      media.removed++
      return { type: 'text', text: REMOVED_NOTICE }
    }

    const redactImage = async (block) => {
      if (block.source?.type !== 'base64') return remove()
      const { status, counts: found, source } = await inspectOnce(block.source)
      if (status === 'removed') return remove()
      media[status]++
      for (const [category, amount] of Object.entries(found)) counts[category] = (counts[category] ?? 0) + amount
      return status === 'redacted' ? { ...block, source } : block
    }

    const redactBlock = async (block) => {
      if (block.type === 'image') return redactImage(block)
      if (block.type === 'document') return isReadableDocument(block) ? block : remove()
      if (block.type === 'tool_result') return { ...block, content: await redactContent(block.content) }
      return block
    }

    const redactContent = async (content) => {
      if (!Array.isArray(content)) return content
      const blocks = []
      for (const block of content) blocks.push(await redactBlock(block))
      return blocks
    }

    if (!Array.isArray(body.messages)) return { body, counts, media }
    const messages = []
    for (const message of body.messages) messages.push({ ...message, content: await redactContent(message.content) })
    return { body: { ...body, messages }, counts, media }
  }

  return { redactImages }
}
