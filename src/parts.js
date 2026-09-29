const INSERT_TAGS = [
  'system-reminder', 'total_tokens', 'local-command-stdout', 'local-command-stderr', 'local-command-caveat',
  'command-name', 'command-message', 'command-args', 'task-notification', 'bash-input', 'bash-stdout', 'bash-stderr',
  'agent-message', 'new-diagnostics', 'ide_selection', 'ide_opened_file', 'user-prompt-submit-hook',
]
const INSERT = new RegExp(`<(${INSERT_TAGS.join('|')})>[\\s\\S]*?(?:</\\1>|$)`, 'g')
const WHOLE_INSERT = /^\s*(?:\w+ hook additional context:|\[Request interrupted by user[^\]]*\]\s*$)/
const TITLE_LENGTH = 80

export const splitParts = (text) => {
  if (WHOLE_INSERT.test(text)) return [{ kind: 'added', text: text.trim() }]
  const parts = []
  const typed = (from, to) => {
    const written = text.slice(from, to).trim()
    if (written) parts.push({ kind: 'typed', text: written })
  }
  let position = 0
  for (const match of text.matchAll(INSERT)) {
    typed(position, match.index)
    parts.push({ kind: 'added', text: match[0].trim() })
    position = match.index + match[0].length
  }
  typed(position, text.length)
  return parts
}

const blocksOf = ({ content }) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [])

const shortened = (line) => {
  if (line.length <= TITLE_LENGTH) return line
  const fitting = line.slice(0, TITLE_LENGTH - 1)
  const end = fitting.lastIndexOf(' ')
  return `${fitting.slice(0, end > 0 ? end : fitting.length)}…`
}

export const describeRequest = (request) => {
  const messages = Array.isArray(request?.messages) ? request.messages : []
  const lastReply = messages.map(({ role }) => role).lastIndexOf('assistant')
  const fresh = messages.slice(lastReply + 1).flatMap(blocksOf)

  const written = fresh
    .filter(({ type }) => type === 'text')
    .flatMap(({ text }) => splitParts(text ?? ''))
    .filter(({ kind }) => kind === 'typed')
    .map(({ text }) => text)
    .join('\n')
  const [firstLine] = written.split('\n').map((line) => line.trim().replace(/\s+/g, ' ')).filter(Boolean)
  if (firstLine) return { kind: request.max_tokens <= 1 ? 'background' : 'question', title: shortened(firstLine) }

  const names = new Map(messages.flatMap(blocksOf).filter(({ type }) => type === 'tool_use').map(({ id, name }) => [id, name]))
  const returned = fresh.filter(({ type }) => type === 'tool_result').map((block) => names.get(block.tool_use_id)).filter(Boolean)
  if (returned.length) return { kind: 'results', title: [...new Set(returned)].join(', ') }

  return { kind: 'background', title: '' }
}
