const SECRET_NAME = 'password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?'
const ENV_SECRET_NAME = 'PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?'
const DOMAIN_ENDINGS = [
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'biz', 'io', 'cloud', 'tech',
  'local', 'lan', 'internal', 'corp', 'intranet', 'kz', 'ru',
]
const COUNTRY_ENDINGS = [
  'de', 'fr', 'es', 'nl', 'uk', 'us', 'eu', 'cn', 'jp', 'kr', 'tr', 'uz', 'az', 'su', 'ai', 'co', 'xyz',
  'fi', 'cz', 'dk', 'sg', 'hk', 'tw', 'vn', 'nz', 'za', 'mx', 'au',
]
const CODE_OBJECTS = new Set([
  'this', 'self', 'window', 'document', 'console', 'process', 'module', 'exports', 'props', 'state', 'options', 'opts',
  'config', 'params', 'event', 'evt', 'item', 'data', 'res', 'req', 'err', 'error', 'app', 'vm', 'ctx', 'context',
  'el', 'node', 'obj', 'object', 'value', 'result', 'response', 'request', 'args', 'env', 'meta', 'routes', 'router',
  'store', 'locale', 'locales', 'messages', 'translations', 'i18n', 'lang', 'langs', 't', 'e', 'i', 'x', 'y',
])
const LOCAL_HOSTS = new Set(['localhost', '0.0.0.0'])
const HOST_SHAPE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i
const FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'js', 'ts', 'css', 'vue', 'json', 'map'])

const digitsOf = (value) => value.replace(/\D/g, '')

const passesLuhn = (value) => {
  const digits = digitsOf(value)
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return sum % 10 === 0
}

const isCard = (value) => /^[2-6]/.test(value) && passesLuhn(value)

const weighted = (digits, weights) => weights.reduce((sum, weight, i) => sum + weight * Number(digits[i]), 0) % 11

const isIin = (value) => {
  const month = Number(value.slice(2, 4))
  const day = Number(value.slice(4, 6))
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  if (!/[1-6]/.test(value[6])) return false
  let check = weighted(value, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  if (check === 10) check = weighted(value, [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2])
  return check === Number(value[11])
}

const isRoutableIp = (value) => !value.startsWith('127.') && value !== '0.0.0.0' && value !== '255.255.255.255'

const isEmail = (value) => {
  const [local] = value.split('@')
  const extension = value.slice(value.lastIndexOf('.') + 1).toLowerCase()
  return local !== 'git' && !FILE_EXTENSIONS.has(extension)
}

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'

const BUILT_IN = [
  { category: 'KEY', source: '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----' },
  { category: 'TOKEN', source: '\\beyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}' },
  { category: 'TOKEN', source: '\\bsk-[A-Za-z0-9_-]{20,}', accept: (value) => /\d/.test(value) },
  { category: 'TOKEN', source: '\\bglpat-[A-Za-z0-9_-]{20,}' },
  { category: 'TOKEN', source: '\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}' },
  { category: 'TOKEN', source: '\\bgithub_pat_[A-Za-z0-9_]{22,}' },
  { category: 'TOKEN', source: '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b' },
  { category: 'TOKEN', source: '\\bxox[abprs]-[A-Za-z0-9-]{10,}' },
  { category: 'TOKEN', source: '\\bAIza[0-9A-Za-z_-]{35}' },
  { category: 'TOKEN', source: '\\bnpm_[A-Za-z0-9]{36}' },
  { category: 'SECRET', source: '\\b(?:Bearer|Basic)\\s+([A-Za-z0-9._~+/=-]{16,})', group: 1 },
  {
    category: 'SECRET',
    source: `(?<![A-Za-z0-9_])[A-Z0-9_]*(?:${ENV_SECRET_NAME})[A-Z0-9_]*=(["']?)([^\\s"']{6,})\\1`,
    group: 2,
  },
  {
    category: 'SECRET',
    source: `(?:${SECRET_NAME})[A-Za-z0-9_]*["']?\\s*[:=]\\s*(["'\`])((?:(?!\\1)[^\\s\\\\]){6,})\\1`,
    flags: 'i',
    group: 2,
    accept: (value) => /\d/.test(value),
  },
  { category: 'SECRET', source: '\\b[a-z][a-z0-9+.-]*://([^\\s:@/]+:[^\\s@/]+)@', flags: 'i', group: 1 },
  { category: 'EMAIL', source: '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}', accept: isEmail },
  { category: 'IP', source: `(?<![\\w.]|[A-Za-z]/)(?:${OCTET}\\.){3}${OCTET}(?!\\w|\\.\\d)`, accept: isRoutableIp },
  { category: 'PHONE', source: '(?<![\\w+])\\+7[ \\-(]{0,2}\\d{3}[ \\-)]{0,2}\\d{3}[ -]?\\d{2}[ -]?\\d{2}(?!\\d)' },
  { category: 'PHONE', source: '(?<![\\w+.])8[ \\-(]{0,2}7\\d{2}[ \\-)]{0,2}\\d{3}[ -]?\\d{2}[ -]?\\d{2}(?!\\d)' },
  { category: 'PHONE', source: '(?<![\\w+])\\+[1-9]\\d{9,14}(?!\\d)' },
  { category: 'IIN', source: '(?<![\\d+])\\d{12}(?!\\d)', accept: isIin },
  {
    category: 'CARD',
    source: '(?<!\\d)(?:\\d{15,19}|\\d{4}([ -])\\d{4}\\1\\d{4}\\1\\d{3,7}|\\d{4}([ -])\\d{6}\\2\\d{5})(?!\\d)',
    accept: isCard,
  },
]

const nameEnding = (endings, labels) =>
  `(?<![\\w.-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)${labels}(?:${endings.join('|')}))(?![\\w-]|\\.[a-z0-9]|\\()`

const hostDetectors = (publicDomains) => {
  const isPublic = (host) => {
    const name = host.toLowerCase()
    return publicDomains.some((domain) => name === domain || name.endsWith(`.${domain}`))
  }
  const isRemote = (host) => HOST_SHAPE.test(host) && !LOCAL_HOSTS.has(host.toLowerCase()) && !host.startsWith('127.') && !isPublic(host)
  const isName = (host) => !CODE_OBJECTS.has(host.split('.')[0]) && !isPublic(host)
  return [
    { category: 'HOST', source: '\\b[a-z][a-z0-9+.-]*://(?:[^\\s/@]+@)?([^\\s/:?#"\x27<>`\\\\)]+)', flags: 'i', group: 1, accept: isRemote },
    { category: 'HOST', source: nameEnding(DOMAIN_ENDINGS, '+'), group: 1, accept: isName },
    { category: 'HOST', source: nameEnding(COUNTRY_ENDINGS, '{2,}'), group: 1, accept: isName },
  ]
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const fromDictionary = (line) => {
  const entry = line.trim()
  if (!entry || entry.startsWith('#')) return null
  if (entry.startsWith('regex:')) return { category: 'CUSTOM', source: entry.slice(6) }
  if (entry.startsWith('domain:')) {
    const domain = escapeRegex(entry.slice(7).trim())
    return {
      category: 'HOST',
      source: `(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\\.)*${domain}(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`,
      flags: 'i',
    }
  }
  const term = entry.startsWith('term:') ? entry.slice(5).trim() : entry
  if (term.length < 3) return null
  return { category: 'TERM', source: escapeRegex(term), flags: 'i' }
}

const compile = ({ category, source, flags = '', group = 0, accept }) => ({
  category,
  group,
  accept,
  pattern: new RegExp(source, `dg${flags}`),
})

export const withoutOverlaps = (matches) => {
  const ordered = [...matches].sort((a, b) => a.start - b.start || b.end - a.end)
  const kept = []
  let reached = 0
  for (const match of ordered) {
    if (match.start < reached) continue
    kept.push(match)
    reached = match.end
  }
  return kept
}

export const createDetector = ({ dictionary = [], publicDomains = [] } = {}) => {
  const custom = dictionary.map((line, index) => {
    const entry = fromDictionary(line)
    try {
      return entry && compile(entry)
    } catch {
      throw new Error(`dictionary entry ${index + 1} is not a valid pattern`)
    }
  })
  const detectors = [...custom.filter(Boolean), ...BUILT_IN.map(compile), ...hostDetectors(publicDomains).map(compile)]

  return (text) => {
    const matches = []
    for (const { category, group, accept, pattern } of detectors) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(text))) {
        if (match[0] === '') {
          pattern.lastIndex++
          continue
        }
        const value = match[group]
        if (!value || (accept && !accept(value))) continue
        const [start, end] = match.indices[group]
        matches.push({ start, end, value, category })
      }
    }
    return withoutOverlaps(matches)
  }
}
