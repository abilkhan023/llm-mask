import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = (home) => join(home, 'sessions')

const isRunning = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export const announce = (home, session) => {
  mkdirSync(directory(home), { recursive: true, mode: 0o700 })
  const file = join(directory(home), `${session.pid}.json`)
  writeFileSync(file, JSON.stringify(session), { mode: 0o600 })
  return () => rmSync(file, { force: true })
}

export const runningSessions = (home) => {
  let names
  try {
    names = readdirSync(directory(home))
  } catch {
    return []
  }
  const sessions = []
  for (const name of names) {
    const file = join(directory(home), name)
    try {
      const session = JSON.parse(readFileSync(file, 'utf8'))
      if (isRunning(session.pid)) sessions.push(session)
      else rmSync(file, { force: true })
    } catch {
      rmSync(file, { force: true })
    }
  }
  return sessions.sort((a, b) => b.started.localeCompare(a.started))
}
