import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const SOURCE = fileURLToPath(new URL('../native/ocr.swift', import.meta.url))
const BUILD = fileURLToPath(new URL('../native/build', import.meta.url))
const compile = promisify(execFile)

export const buildHelper = async () => {
  const digest = createHash('sha256').update(readFileSync(SOURCE)).digest('hex').slice(0, 16)
  const binary = join(BUILD, `ocr-${digest}`)
  if (existsSync(binary)) return binary
  mkdirSync(BUILD, { recursive: true })
  const draft = `${binary}.${process.pid}.tmp`
  try {
    await compile('swiftc', ['-O', '-swift-version', '5', SOURCE, '-o', draft])
  } catch (error) {
    const [reason] = String(error.stderr || error.message).split('\n')
    throw new Error(`image masking needs the Swift compiler (xcode-select --install): ${reason}`)
  }
  renameSync(draft, binary)
  return binary
}

const converse = (binary, format, timeout) => {
  const child = spawn(binary, [format], { stdio: ['pipe', 'pipe', 'ignore'] })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
  let received = ''
  let waiting = null
  let stopped = null

  const settle = () => {
    if (!waiting) return
    const end = received.indexOf('\n')
    if (end === -1 && !stopped) return
    const { resolve, reject } = waiting
    waiting = null
    if (end === -1) return reject(stopped)
    const line = received.slice(0, end)
    received = received.slice(end + 1)
    try {
      resolve(JSON.parse(line))
    } catch {
      reject(new Error('image helper gave an unreadable answer'))
    }
  }

  const stop = (error) => {
    clearTimeout(timer)
    stopped ??= error
    settle()
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    received += chunk
    settle()
  })
  child.stdin.on('error', () => {})
  child.on('error', () => stop(new Error('image helper could not start')))
  child.on('close', () => stop(new Error('image helper stopped without an answer')))

  const ask = (line) =>
    new Promise((resolve, reject) => {
      waiting = { resolve, reject }
      child.stdin.write(`${line}\n`)
      settle()
    })

  const close = () => {
    clearTimeout(timer)
    child.kill()
  }

  return { ask, close }
}

export const createNativeEngine = ({ binary, timeout = 30000 }) => ({
  open: async (data, mediaType) => {
    const format = mediaType === 'image/jpeg' ? 'jpeg' : 'png'
    const { ask, close } = converse(binary, format, timeout)
    try {
      const { lines } = await ask(data)
      const paint = async (ranges) => {
        const { image } = await ask(JSON.stringify({ ranges }))
        return { data: image, mediaType: `image/${format}` }
      }
      return { lines, paint, close }
    } catch (error) {
      close()
      throw error
    }
  },
})
