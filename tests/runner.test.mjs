import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { launchEnv } from '../bin/launch.mjs'

const runner = fileURLToPath(new URL('../bin/run.mjs', import.meta.url))
const modelLister = fileURLToPath(new URL('../bin/models.mjs', import.meta.url))
const watcher = fileURLToPath(new URL('../bin/watch.mjs', import.meta.url))
const fixture = `
import fs from 'node:fs'
if (process.env.COPILOT_PROVIDER_API_KEY !== 'fixture-key' || process.env.COPILOT_PROVIDER_API_KEY_COMMAND) {
  process.stderr.write('provider environment was not isolated\\n')
  process.exit(19)
}
const flag = process.argv[4]
const file = flag.startsWith('--usage-output-file=') ? flag.slice('--usage-output-file='.length) : process.argv[5]
const mode = process.env.AGENT_DECK_FIXTURE_MODE
if (mode !== 'missing' && mode !== 'stale' && mode !== 'failed-stale') {
  const usage = mode === 'malformed' ? '{not JSON fixture-key' : mode === 'unexpected' ? '{}' : JSON.stringify({
    modelMetrics: { 'fixture-model': { totalNanoAiu: 250000000, usage: { inputTokens: 11, outputTokens: 3 } } },
    totalNanoAiu: 250000000,
    aiCreditsStatus: 'complete',
  })
  fs.writeFileSync(file, usage)
}
process.stdout.write('{"type":"result","exitCode":0}\\n')
if (mode === 'failed' || mode === 'failed-stale') process.exitCode = 7
`

const setup = (t, mode, options = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'run')
  const cwd = path.join(root, 'project')
  const cli = path.join(root, 'fixture.mjs')
  fs.mkdirSync(dir)
  fs.mkdirSync(cwd)
  fs.writeFileSync(cli, fixture)
  const usageFile = 'relative-usage.json'
  if (options.preExisting) fs.writeFileSync(path.join(cwd, usageFile), JSON.stringify({
    modelMetrics: { 'old-model': { totalNanoAiu: 9000000000, usage: { inputTokens: 100 } } },
    totalNanoAiu: 9000000000,
    aiCreditsStatus: 'complete',
  }))
  const usageFlag = options.equals ? `--usage-output-file=${usageFile}` : '--usage-output-file'
  const argv = [process.execPath, cli, '-p', '--usage-output-file=not-a-flag', usageFlag]
  if (!options.equals) argv.push(usageFile)
  fs.writeFileSync(path.join(dir, 'spec.json'), options.specText ?? JSON.stringify({
    argv,
    cwd,
    parser: 'copilot',
    usageFile: options.noUsageFile ? undefined : usageFile,
    isolateProvider: true,
  }))
  const envFile = path.join(dir, 'env.json')
  if (options.envDirectory) fs.mkdirSync(envFile)
  else fs.writeFileSync(envFile, options.envText ?? JSON.stringify({
    COPILOT_PROVIDER_API_KEY: 'fixture-key',
    AGENT_DECK_FIXTURE_MODE: mode,
  }))
  const result = spawnSync(process.execPath, [runner, dir], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, AGENT_DECK_DETACHED: '1', COPILOT_PROVIDER_API_KEY_COMMAND: 'must-not-be-inherited' },
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const stderr = fs.readFileSync(path.join(dir, 'stderr.log'), 'utf8')
  const output = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
  return {
    cwd,
    envFile,
    stderr,
    output,
    events: output.split('\n').filter(Boolean).map(line => JSON.parse(line)),
    exit: fs.readFileSync(path.join(dir, 'exit.txt'), 'utf8'),
  }
}

test('only an explicitly configured provider replaces inherited Copilot provider settings', () => {
  const key = 'COPILOT_PROVIDER_AGENT_DECK_TEST'
  const original = process.env[key]
  process.env[key] = 'inherited'
  try {
    assert.equal(launchEnv({})[key], 'inherited')
    assert.equal(launchEnv({}, true)[key], undefined)
    assert.equal(launchEnv({ [key]: 'configured' }, true)[key], 'configured')
  } finally {
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
})

for (const equals of [false, true]) {
  test(`Copilot runner reads a relative usage file with ${equals ? 'equals' : 'separate'} flag syntax`, t => {
    const run = setup(t, 'valid', { equals })
    assert.equal(run.exit, '0')
    assert.equal(fs.existsSync(run.envFile), false)
    assert.equal(fs.existsSync(path.join(run.cwd, 'relative-usage.json')), true)
    assert.equal(run.output.includes('fixture-key'), false)
    assert.equal(run.stderr.includes('fixture-key'), false)
    assert.deepEqual(run.events.at(-1), {
      type: 'session.usage_checkpoint',
      data: {
        accountingSnapshot: {
          modelMetrics: { 'fixture-model': { totalNanoAiu: 250000000, usage: { inputTokens: 11, outputTokens: 3 } } },
          totalNanoAiu: 250000000,
          aiCreditsStatus: 'complete',
        },
      },
    })
  })
}

test('Copilot runner preserves final usage even when the CLI fails', t => {
  const run = setup(t, 'failed')
  assert.equal(run.exit, '7')
  assert.equal(run.events.at(-1).type, 'session.usage_checkpoint')
  assert.equal(run.events.at(-1).data.accountingSnapshot.totalNanoAiu, 250000000)
})

for (const mode of ['missing', 'malformed', 'unexpected']) {
  test(`Copilot runner reports a ${mode} usage file`, t => {
    const run = setup(t, mode)
    assert.equal(run.exit, '0')
    assert.equal(run.events.at(-1).type, 'agent-deck.usage_error')
    assert.ok(run.events.at(-1).data.message)
    assert.equal(run.output.includes('fixture-key'), false)
  })
}

test('Copilot runner reports a missing usage-file setting', t => {
  const run = setup(t, 'valid', { noUsageFile: true })
  assert.equal(run.events.at(-1).data.message, 'no usage output file was configured')
})

for (const mode of ['stale', 'failed-stale']) {
  test(`Copilot runner does not attribute an unchanged usage file to a ${mode} run`, t => {
    const run = setup(t, mode, { preExisting: true })
    assert.equal(run.exit, mode === 'stale' ? '0' : '7')
    assert.equal(run.events.at(-1).type, 'agent-deck.usage_error')
    assert.match(run.events.at(-1).data.message, /not updated/)
  })
}

test('runner deletes malformed credentials and refuses to start without leaking their content', t => {
  const run = setup(t, 'valid', { envText: '{"COPILOT_PROVIDER_API_KEY":"fixture-key" invalid' })
  assert.equal(run.exit, '127')
  assert.equal(fs.existsSync(run.envFile), false)
  assert.equal(run.events.length, 0)
  assert.match(run.stderr, /could not read the temporary environment file/)
  assert.equal(run.stderr.includes('fixture-key'), false)
})

test('runner refuses an environment file that is not an object of strings', t => {
  const run = setup(t, 'valid', { envText: 'null' })
  assert.equal(run.exit, '127')
  assert.equal(fs.existsSync(run.envFile), false)
  assert.equal(run.events.length, 0)
  assert.match(run.stderr, /could not read the temporary environment file/)
})

test('runner removes credentials even when its run specification is invalid', t => {
  const run = setup(t, 'valid', { specText: '{invalid specification' })
  assert.equal(run.exit, '127')
  assert.equal(fs.existsSync(run.envFile), false)
  assert.equal(run.events.length, 0)
  assert.match(run.stderr, /could not read the run specification/)
  assert.equal(run.stderr.includes('fixture-key'), false)
})

test('runner refuses to start when it cannot delete the temporary environment file', t => {
  const run = setup(t, 'valid', { envDirectory: true })
  assert.equal(run.exit, '127')
  assert.equal(run.events.length, 0)
  assert.match(run.stderr, /could not delete the temporary environment file/)
})

test('model lister deletes malformed query files without exposing their content', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-model-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'query.json')
  fs.writeFileSync(file, '{"apiKey":"fixture-key" invalid')
  const result = spawnSync(process.execPath, [modelLister, file], { encoding: 'utf8', timeout: 10_000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(JSON.parse(result.stdout), { error: 'The temporary model query file is not valid JSON.' })
  assert.equal(result.stdout.includes('fixture-key'), false)
})

test('model lister redacts a key echoed in an API error', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-model-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const server = createServer((_req, res) => {
    res.writeHead(401)
    res.end('bad credential fixture-key')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const file = path.join(root, 'query.json')
  fs.writeFileSync(file, JSON.stringify({
    source: 'api',
    provider: { type: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-key' },
  }))
  const child = spawn(process.execPath, [modelLister, file], { timeout: 10_000 })
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  const [code] = await once(child, 'close')
  assert.equal(code, 0)
  assert.equal(fs.existsSync(file), false)
  assert.match(JSON.parse(stdout).error, /\[redacted\]/)
  assert.equal(stdout.includes('fixture-key'), false)
})

test('model lister reads "id<TAB>name" lines and skips banners', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-model-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const cli = path.join(root, 'agy.mjs')
  fs.writeFileSync(cli, "process.stdout.write('Fetching available models...\\r\\ngemini-4-neon-high\\tGemini 4 Neon (High)\\r\\nplain-id\\r\\n')\n")
  const file = path.join(root, 'query.json')
  fs.writeFileSync(file, JSON.stringify({ source: 'lines', command: process.execPath, args: [cli] }))
  const result = spawnSync(process.execPath, [modelLister, file], { encoding: 'utf8', timeout: 10_000 })
  assert.ifError(result.error)
  assert.deepEqual(JSON.parse(result.stdout), { models: [{ id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' }, { id: 'plain-id' }] })
})

test('runner says a missing working folder is missing, not that the program is', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'run')
  fs.mkdirSync(dir)
  const cwd = path.join(root, 'no-such-folder')
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ argv: [process.execPath, '-e', ''], cwd, parser: 'text' }))
  const result = spawnSync(process.execPath, [runner, dir], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, AGENT_DECK_DETACHED: '1' } })
  assert.ifError(result.error)
  assert.equal(fs.readFileSync(path.join(dir, 'exit.txt'), 'utf8'), '127')
  const stderr = fs.readFileSync(path.join(dir, 'stderr.log'), 'utf8')
  assert.match(stderr, /the working folder .*no-such-folder does not exist/)
  assert.doesNotMatch(stderr, /ENOENT/)
})

const runWatch = async (t, rollouts, projectCwd) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-watch-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const now = new Date()
  const sessionsDir = path.join(root, 'sessions')
  const dayDir = path.join(
    sessionsDir,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  )
  fs.mkdirSync(dayDir, { recursive: true })
  const ts = now.toISOString()
  for (const r of rollouts) {
    const line = JSON.stringify({ type: 'session_meta', timestamp: ts, payload: { id: r.id, cwd: r.cwd, timestamp: ts } })
    fs.writeFileSync(path.join(dayDir, `${r.id}.jsonl`), `${line}\n`)
  }
  // A sentinel run folder lets the test stop right after the watcher finishes its first scan.
  const runsDir = path.join(root, 'runs')
  fs.mkdirSync(path.join(runsDir, 'sentinel'), { recursive: true })
  fs.writeFileSync(path.join(runsDir, 'sentinel', 'events.jsonl'), '{"type":"thread.started","thread_id":"sentinel-thread"}\n')

  const child = spawn(process.execPath, [watcher, sessionsDir, runsDir, projectCwd, String(Date.now() - 60_000)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill())

  const events = []
  let buffer = ''
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('watcher timed out before finishing initial scan')), 10_000)
    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('exit', code => {
      clearTimeout(timer)
      if (!events.some(e => e.t === 'run' && e.run === 'sentinel')) reject(new Error(`watcher exited early (${code})`))
      else resolve()
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('{')) continue
        const ev = JSON.parse(line)
        events.push(ev)
        if (ev.t === 'run' && ev.run === 'sentinel') {
          clearTimeout(timer)
          child.kill()
          resolve()
        }
      }
    })
  })
  return events.filter(e => e.t === 'meta').map(e => e.f).sort()
}

test('watcher matches MSYS paths, trailing slashes, subfolders and scratchpads, and ignores sibling folders', async t => {
  const rollouts = [
    { id: 'th-root', cwd: 'C:\\src\\proj' },
    { id: 'th-sub', cwd: 'C:\\src\\proj\\packages\\app' },
    { id: 'th-msys-sub', cwd: '/c/src/proj/tools' },
    { id: 'th-scratch', cwd: 'C:\\Users\\me\\AppData\\Local\\Temp\\claude\\C--src-proj\\work' },
    { id: 'th-sibling-prefix', cwd: 'C:\\src\\proj-other' },
    { id: 'th-sibling', cwd: 'C:\\src\\other' },
  ]
  const expected = ['th-msys-sub', 'th-root', 'th-scratch', 'th-sub']
  assert.deepEqual(await runWatch(t, rollouts, '/c/src/proj'), expected)
  assert.deepEqual(await runWatch(t, rollouts, 'C:\\src\\proj\\'), expected)
  assert.deepEqual(await runWatch(t, rollouts, 'C:\\src\\proj'), expected)
})
