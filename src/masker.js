import { withoutOverlaps } from './detectors.js'

export const PLACEHOLDER_SOURCE = 'MSK_[A-Z]+_[0-9a-f]{10,}'
const PLACEHOLDER = new RegExp(PLACEHOLDER_SOURCE, 'gi')
const ID_LENGTH = 10

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const categoryOf = (placeholder) => placeholder.split('_')[1]

const WHOLE_WORDS = new Set(['LOGIN', 'NAME'])

const LOOKALIKES = {
  o: '0', ø: '0', о: '0',
  l: '1', i: '1', '|': '1', і: '1', ı: '1',
  s: '5', z: '2', b: '8', в: '8',
  а: 'a', е: 'e', р: 'p', с: 'c', х: 'x', у: 'y', к: 'k', м: 'm', т: 't', н: 'h',
}

const fold = (text) => {
  let folded = ''
  for (const unit of text.split('')) {
    const lower = unit.toLowerCase()
    const plain = lower.length === 1 ? lower : unit
    folded += LOOKALIKES[plain] ?? plain
  }
  return folded
}

export const createMasker = ({ vault, detect }) => {
  let knownValues = null
  let knownPattern = null
  let looseValues = null
  let loosePattern = null
  let looseOriginals = null

  const isWholeWord = (value) => WHOLE_WORDS.has(categoryOf(vault.placeholderFor(value, 'TERM')))

  const alternation = (values) => values.map(escapeRegex).join('|')

  const patternsFor = (values) => {
    const words = values.filter(isWholeWord)
    const parts = values.filter((value) => !isWholeWord(value))
    return [
      parts.length ? new RegExp(alternation(parts), 'g') : null,
      words.length ? new RegExp(`(?<![A-Za-z0-9_])(?:${alternation(words)})(?![A-Za-z0-9_])`, 'g') : null,
    ].filter(Boolean)
  }

  const findKnown = (text) => {
    const values = vault.knownValues()
    if (!values.length) return []
    if (values !== knownValues) {
      knownValues = values
      knownPattern = patternsFor(values)
    }
    return knownPattern.flatMap((pattern) =>
      [...text.matchAll(pattern)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
        category: 'TERM',
      })),
    )
  }

  const findLookalikes = (text) => {
    const values = vault.knownValues()
    if (!values.length) return []
    if (values !== looseValues) {
      looseValues = values
      looseOriginals = new Map()
      for (const value of values) if (!looseOriginals.has(fold(value))) looseOriginals.set(fold(value), value)
      loosePattern = new RegExp([...looseOriginals.keys()].map(escapeRegex).join('|'), 'g')
    }
    return [...fold(text).matchAll(loosePattern)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      value: looseOriginals.get(match[0]),
      category: 'TERM',
    }))
  }

  const locate = (text, { loose = false } = {}) => {
    const reserved = [...text.matchAll(PLACEHOLDER)].map((match) => [match.index, match.index + match[0].length])
    const isFree = ({ start, end }) => !reserved.some(([from, to]) => start < to && from < end)

    const detected = detect(text).filter(isFree)
    for (const { value, category } of detected) vault.placeholderFor(value, category)
    const known = loose ? findLookalikes(text) : findKnown(text)
    return withoutOverlaps([...detected, ...known.filter(isFree)]).map(({ start, end, value, category }) => ({
      start,
      end,
      value,
      category: categoryOf(vault.placeholderFor(value, category)),
    }))
  }

  const mask = (text) => {
    const counts = {}
    let result = ''
    let position = 0
    for (const { start, end, value, category } of locate(text)) {
      counts[category] = (counts[category] ?? 0) + 1
      result += text.slice(position, start) + vault.placeholderFor(value, category)
      position = end
    }
    return { text: result + text.slice(position), counts }
  }

  const unmask = (text, { json = false } = {}) =>
    text.replace(PLACEHOLDER, (found) => {
      const prefix = found.slice(0, found.lastIndexOf('_') + 1)
      const id = found.slice(prefix.length)
      for (let length = id.length; length >= ID_LENGTH; length--) {
        const value = vault.valueFor(prefix + id.slice(0, length))
        if (value === undefined) continue
        const restored = json ? JSON.stringify(value).slice(1, -1) : value
        return restored + id.slice(length)
      }
      return found
    })

  return { locate, mask, unmask }
}
