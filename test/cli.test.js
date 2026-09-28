import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/llm-mask.js', import.meta.url))

const tempDir = (name) => mkdtempSync(join(tmpdir(), `llm-mask-${name}-`))

const start = (args, { home = tempDir('home'), cwd = tempDir('cwd'), input } = {}) => {
  const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { PATH: process.env.PATH, LLM_MASK_HOME: home } })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  child.stdin.end(input ?? '')
  const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr })))
  const saw = (text) =>
    new Promise((resolve) => {
      const check = () => (stdout.includes(text) ? resolve() : setTimeout(check, 10))
      check()
    })
  return { child, done, saw }
}

const run = (args, options) => start(args, options).done

test('check prints the masked text and reports counts separately', async () => {
  const { code, stdout, stderr } = await run(['check'], { input: 'mail a.user@corp.example from 10.20.30.40\n' })

  assert.equal(code, 0)
  assert.match(stdout, /^mail MSK_EMAIL_[0-9a-f]{10} from MSK_IP_[0-9a-f]{10}\n$/)
  assert.match(stderr, /EMAIL\s+1/)
  assert.match(stderr, /IP\s+1/)
  assert.equal(stderr.includes('a.user'), false)
})

test('check reads a file given by name', async () => {
  const cwd = tempDir('cwd')
  writeFileSync(join(cwd, 'notes.txt'), 'mail a.user@corp.example')
  const { code, stdout } = await run(['check', 'notes.txt'], { cwd })

  assert.equal(code, 0)
  assert.match(stdout, /^mail MSK_EMAIL_[0-9a-f]{10}$/)
})

test('check applies env files of the working directory', async () => {
  const cwd = tempDir('cwd')
  writeFileSync(join(cwd, '.env'), 'VITE_RS_URL=https://rs.dev.corp.example/api\n')
  const { stdout } = await run(['check'], { cwd, input: 'GET https://rs.dev.corp.example/api/patterns' })

  assert.match(stdout, /^GET https:\/\/MSK_HOST_[0-9a-f]{10}\/api\/patterns$/)
})

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))

test('check writes a painted copy of an image next to it and names the file', async () => {
  const cwd = tempDir('cwd')
  copyFileSync(join(FIXTURES, 'secrets.png'), join(cwd, 'shot.png'))
  const { code, stdout, stderr } = await run(['check', 'shot.png'], { cwd })

  assert.equal(code, 0)
  assert.equal(stdout, 'shot.masked.png\n')
  assert.equal(readFileSync(join(cwd, 'shot.masked.png')).subarray(1, 4).toString('latin1'), 'PNG')
  assert.notDeepEqual(readFileSync(join(cwd, 'shot.masked.png')), readFileSync(join(cwd, 'shot.png')))
  assert.match(stderr, /SECRET\s+1/)
  assert.match(stderr, /EMAIL\s+1/)
  assert.match(stderr, /IP\s+1/)
})

test('check writes nothing for an image without sensitive text', async () => {
  const cwd = tempDir('cwd')
  copyFileSync(join(FIXTURES, 'clean.png'), join(cwd, 'shot.png'))
  const { code, stdout, stderr } = await run(['check', 'shot.png'], { cwd })

  assert.equal(code, 0)
  assert.equal(stdout, '')
  assert.match(stderr, /nothing/)
  assert.equal(existsSync(join(cwd, 'shot.masked.png')), false)
})

test('check reports an image it cannot read', async () => {
  const cwd = tempDir('cwd')
  writeFileSync(join(cwd, 'shot.png'), 'this is not an image')
  const { code, stderr } = await run(['check', 'shot.png'], { cwd })

  assert.equal(code, 1)
  assert.match(stderr, /cannot be inspected/)
  assert.equal(existsSync(join(cwd, 'shot.masked.png')), false)
})

test('add stores entries in a private dictionary that later commands apply', async () => {
  const home = tempDir('home')
  const added = await run(['add'], { home, input: 'domain:corp.example\nacme\n' })
  const checked = await run(['check'], { home, input: 'open gitlab.corp.example for ACME' })

  assert.equal(added.code, 0)
  assert.equal(readFileSync(join(home, 'dictionary.txt'), 'utf8'), 'domain:corp.example\nacme\n')
  assert.equal(statSync(join(home, 'dictionary.txt')).mode & 0o777, 0o600)
  assert.match(checked.stdout, /^open MSK_HOST_[0-9a-f]{10} for MSK_TERM_[0-9a-f]{10}$/)
})

test('add keeps earlier entries', async () => {
  const home = tempDir('home')
  await run(['add'], { home, input: 'first-entry\n' })
  await run(['add'], { home, input: 'second-entry\n' })

  assert.equal(readFileSync(join(home, 'dictionary.txt'), 'utf8'), 'first-entry\nsecond-entry\n')
})

test('add refuses a broken pattern and stores nothing', async () => {
  const home = tempDir('home')
  const { code, stderr } = await run(['add'], { home, input: 'regex:operator_(\\d{5}\n' })

  assert.equal(code, 1)
  assert.match(stderr, /not a valid pattern/)
  assert.equal(existsSync(join(home, 'dictionary.txt')), false)
})

test('add never echoes the entry', async () => {
  const { code, stdout, stderr } = await run(['add'], { input: 'very-secret-term\n' })
  assert.equal(code, 0)
  assert.equal((stdout + stderr).includes('very-secret-term'), false)
})

test('add starts on a new line when the dictionary was edited by hand without a final newline', async () => {
  const home = tempDir('home')
  writeFileSync(join(home, 'dictionary.txt'), 'manual-entry')
  await run(['add'], { home, input: 'second-entry\n' })

  assert.equal(readFileSync(join(home, 'dictionary.txt'), 'utf8'), 'manual-entry\nsecond-entry\n')
})

test('status shows counts per category and no values', async () => {
  const home = tempDir('home')
  await run(['add'], { home, input: 'domain:corp.example\n' })
  await run(['check'], { home, input: 'mail a.user@corp.example and b.user@corp.example via gitlab.corp.example' })
  const { code, stdout } = await run(['status'], { home })

  assert.equal(code, 0)
  assert.match(stdout, /EMAIL\s+2/)
  assert.match(stdout, /HOST\s+1/)
  assert.match(stdout, /dictionary entries:\s+1/)
  assert.equal(stdout.includes('corp.example'), false)
  assert.equal(stdout.includes('a.user'), false)
})

test('unknown command exits with a usage error', async () => {
  const { code, stderr } = await run(['explode'])
  assert.equal(code, 2)
  assert.match(stderr, /usage/i)
})

test('run without a command exits with a usage error', async () => {
  const { code, stderr } = await run(['run', '--'])
  assert.equal(code, 2)
  assert.match(stderr, /usage/i)
})

test('run returns the exit code of the command', async () => {
  const { code } = await run(['run', '--', process.execPath, '-e', 'process.exit(3)'])
  assert.equal(code, 3)
})

test('run passes arguments that look like options to the command', async () => {
  const { code, stdout } = await run(['run', '--', process.execPath, '-e', 'console.log(process.argv.slice(1).join(" "))', '--', '-p', '--model', 'x'])
  assert.equal(code, 0)
  assert.equal(stdout, '-p --model x\n')
})

test('run refuses to start the command when the dictionary is broken', async () => {
  const home = tempDir('home')
  const cwd = tempDir('cwd')
  writeFileSync(join(home, 'dictionary.txt'), 'regex:operator_(\\d{5}\n')
  const marker = join(cwd, 'started.txt')
  const { code, stderr } = await run(['run', '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], { home, cwd })

  assert.equal(code, 1)
  assert.match(stderr, /dictionary entry 1 is not a valid pattern/)
  assert.equal(existsSync(marker), false)
})

test('termination request is handed to the command', async () => {
  const script = "process.on('SIGTERM', () => process.exit(42)); setInterval(() => {}, 1000); console.log('ready')"
  const { child, done, saw } = start(['run', '--', process.execPath, '-e', script])
  await saw('ready')
  child.kill('SIGTERM')

  assert.equal((await done).code, 42)
})

test('interrupt leaves the launcher running until the command ends by itself', async () => {
  const script = "setTimeout(() => process.exit(5), 400); console.log('ready')"
  const { child, done, saw } = start(['run', '--', process.execPath, '-e', script])
  await saw('ready')
  child.kill('SIGINT')

  assert.deepEqual(await done.then(({ code, signal }) => ({ code, signal })), { code: 5, signal: null })
})
