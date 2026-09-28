import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PLACEHOLDER = /^MSK_([A-Z]+)_([0-9a-f]+)$/i
const ID_LENGTH = 10

const normalize = (placeholder) => {
  const match = PLACEHOLDER.exec(placeholder)
  if (!match) return undefined
  return `MSK_${match[1].toUpperCase()}_${match[2].toLowerCase()}`
}

const loadKey = (dir) => {
  const path = join(dir, 'key')
  try {
    writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  return readFileSync(path, 'utf8').trim()
}

export const openVault = (dir) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const key = loadKey(dir)
  const file = join(dir, 'vault.json')
  const byPlaceholder = new Map()
  const byValue = new Map()
  let loadedAt = -1
  let dirty = false
  let sorted = null

  const remember = (placeholder, value, category) => {
    byPlaceholder.set(placeholder, { value, category })
    if (!byValue.has(value)) byValue.set(value, placeholder)
    sorted = null
  }

  const refresh = () => {
    let modified
    try {
      modified = statSync(file).mtimeMs
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    if (modified === loadedAt) return
    const { entries } = JSON.parse(readFileSync(file, 'utf8'))
    for (const [placeholder, { value, category }] of Object.entries(entries)) {
      if (!byPlaceholder.has(placeholder)) remember(placeholder, value, category)
    }
    loadedAt = modified
  }

  const placeholderFor = (value, category) => {
    const known = byValue.get(value)
    if (known) return known
    const digest = createHmac('sha256', key).update(value).digest('hex')
    const label = category.toUpperCase().replace(/[^A-Z]/g, '')
    let length = ID_LENGTH
    let placeholder = `MSK_${label}_${digest.slice(0, length)}`
    while (byPlaceholder.has(placeholder)) {
      length += 2
      placeholder = `MSK_${label}_${digest.slice(0, length)}`
    }
    remember(placeholder, value, label)
    dirty = true
    return placeholder
  }

  const valueFor = (placeholder) => {
    const id = normalize(placeholder)
    if (!id) return undefined
    if (!byPlaceholder.has(id)) refresh()
    return byPlaceholder.get(id)?.value
  }

  const save = () => {
    if (!dirty) return
    refresh()
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, entries: Object.fromEntries(byPlaceholder) }), { mode: 0o600 })
    renameSync(temp, file)
    loadedAt = statSync(file).mtimeMs
    dirty = false
  }

  const stats = () => {
    const counts = {}
    for (const { category } of byPlaceholder.values()) counts[category] = (counts[category] ?? 0) + 1
    return counts
  }

  const knownValues = () => {
    sorted ??= [...byValue.keys()].sort((a, b) => b.length - a.length)
    return sorted
  }

  refresh()
  return { placeholderFor, valueFor, save, stats, knownValues }
}
