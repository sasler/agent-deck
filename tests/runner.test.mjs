import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { liveLimitsOf, newestLimits } from '../bin/codex-limits.mjs'
import { launchEnv } from '../bin/launch.mjs'

const runner = fileURLToPath(new URL('../bin/run.mjs', import.meta.url))
const modelLister = fileURLToPath(new URL('../bin/models.mjs', import.meta.url))
const watcher = fileURLToPath(new URL('../bin/watch.mjs', import.meta.url))
const codexLimitsScript = fileURLToPath(new URL('../bin/codex-limits.mjs', import.meta.url))
const pluginVersion = JSON.parse(fs.readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version
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

test('Codex limits are read on demand from the newest rollout that has a reading, with the time it was written', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-limits-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const now = Date.parse('2026-11-21T12:00:00Z')
  const day = d => path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
  const today = day(new Date(now))
  const threeDaysAgo = day(new Date(now - 3 * 86_400_000))
  fs.mkdirSync(today, { recursive: true })
  fs.mkdirSync(threeDaysAgo, { recursive: true })
  const reading = (timestamp, primary, secondary) =>
    JSON.stringify({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          plan_type: 'plus',
          primary: { used_percent: primary, window_minutes: 300, resets_at: 1_800_000_000 },
          secondary: { used_percent: secondary, window_minutes: 10080 },
        },
      },
    })
  const write = (file, lines, mtime) => {
    fs.writeFileSync(file, lines.join('\n') + '\n')
    fs.utimesSync(file, mtime / 1000, mtime / 1000)
  }
  write(path.join(threeDaysAgo, 'old.jsonl'), [reading('2026-11-18T08:00:00Z', 90, 95)], now - 3 * 86_400_000)
  write(path.join(today, 'older.jsonl'), [reading('2026-11-21T09:00:00Z', 10, 20), reading('2026-11-21T09:30:00Z', 12, 21)], now - 2 * 3_600_000)
  // The newest file has no reading yet: the one before it answers.
  write(path.join(today, 'newest.jsonl'), ['{"type":"session_meta","payload":{"id":"x"}}'], now - 60_000)

  const found = newestLimits(root, { now })
  assert.equal(found.ts, Date.parse('2026-11-21T09:30:00Z'))
  assert.deepEqual(found.limits, {
    windows: [{ minutes: 300, percent: 12, resetsAt: 1_800_000_000_000 }, { minutes: 10080, percent: 21, resetsAt: undefined }],
    plan: 'plus',
  })
  assert.equal(path.basename(found.file), 'older.jsonl')
  assert.equal(newestLimits(path.join(root, 'missing'), { now }), undefined)
})

const makeFakeCodex = (dir, body) => {
  if (process.platform === 'win32') {
    const script = path.join(dir, 'fake-codex.mjs')
    const shim = path.join(dir, 'codex.cmd')
    fs.writeFileSync(script, body)
    fs.writeFileSync(shim, '@echo off\r\n"node" "%dp0%\\fake-codex.mjs" %*\r\n')
    return shim
  }
  const bin = path.join(dir, 'codex')
  fs.writeFileSync(bin, `#!${process.execPath}\n${body}`)
  fs.chmodSync(bin, 0o755)
  return bin
}

test('Codex limits read live from codex app-server and map to meter windows', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-codex-live-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const fakeCodex = makeFakeCodex(
    root,
    `
import readline from 'node:readline'
if (process.argv[2] !== 'app-server') process.exit(2)
let sawInitialized = false
const keepAlive = setInterval(() => {}, 60_000)
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  const msg = JSON.parse(line)
  if (msg.id === 1 && msg.method === 'initialize') {
    if (msg.params?.clientInfo?.name !== 'agent-deck' || msg.params?.clientInfo?.version !== ${JSON.stringify(pluginVersion)}) process.exit(3)
    process.stdout.write(JSON.stringify({ id: 1, result: { userAgent: 'fake-codex/0.160.1' } }) + '\\n')
  } else if (msg.method === 'initialized' && msg.id === undefined) {
    sawInitialized = true
  } else if (msg.id === 2 && msg.method === 'account/rateLimits/read') {
    if (!sawInitialized) process.exit(4)
    process.stdout.write(JSON.stringify({
      id: 2,
      result: {
        rateLimits: {
          primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 1_800_500_000 },
          planType: 'plus',
          credits: { hasCredits: false },
        },
        rateLimitsByLimitId: { codex: { primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1_800_000_000 } } },
      },
    }) + '\\n')
  }
})
rl.on('close', () => clearInterval(keepAlive))
`,
  )
  const before = Date.now()
  const result = spawnSync(process.execPath, [codexLimitsScript, path.join(root, 'empty-sessions'), fakeCodex], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  const after = Date.now()
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const out = JSON.parse(result.stdout)
  assert.equal(out.source, 'live')
  assert.ok(out.ts >= before && out.ts <= after)
  assert.deepEqual(out.limits, {
    windows: [
      { minutes: 300, percent: 24, resetsAt: 1_800_000_000_000 },
      { minutes: 10080, percent: 61, resetsAt: 1_800_500_000_000 },
    ],
    plan: 'plus',
  })
  assert.equal(result.stdout.includes('userAgent'), false)
  assert.equal(result.stdout.includes('hasCredits'), false)
  assert.deepEqual(
    liveLimitsOf({ primary: { usedPercent: 10, windowDurationMins: 300 }, planType: 'team' }),
    { windows: [{ minutes: 300, percent: 10, resetsAt: undefined }], plan: 'team' },
  )
})

test('Codex limits fall back to the newest rollout file when app-server errors', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-codex-fallback-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sessionsDir = path.join(root, 'sessions')
  const now = new Date()
  const dayDir = path.join(
    sessionsDir,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  )
  fs.mkdirSync(dayDir, { recursive: true })
  const tsIso = new Date(now.getTime() - 2 * 3_600_000).toISOString()
  fs.writeFileSync(
    path.join(dayDir, 'last.jsonl'),
    JSON.stringify({
      timestamp: tsIso,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          plan_type: 'pro',
          primary: { used_percent: 33, window_minutes: 300, resets_at: 1_800_000_000 },
          secondary: { used_percent: 55, window_minutes: 10080 },
        },
      },
    }) + '\n',
  )
  const fakeCodex = makeFakeCodex(
    root,
    `
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  const msg = JSON.parse(line)
  if (msg.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n')
  else if (msg.id === 2) process.stdout.write(JSON.stringify({ id: 2, error: { code: -32603, message: 'not logged in raw-secret-value' } }) + '\\n')
})
`,
  )
  const result = spawnSync(process.execPath, [codexLimitsScript, sessionsDir, fakeCodex], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const out = JSON.parse(result.stdout)
  assert.equal(out.source, 'rollout')
  assert.equal(out.liveError, 'not logged in')
  assert.equal(out.ts, Date.parse(tsIso))
  assert.deepEqual(out.limits, {
    windows: [
      { minutes: 300, percent: 33, resetsAt: 1_800_000_000_000 },
      { minutes: 10080, percent: 55 },
    ],
    plan: 'pro',
  })
  assert.equal(result.stdout.includes('raw-secret-value'), false)
  assert.equal(result.stderr.includes('raw-secret-value'), false)
})

test('Codex limits exits and closes stdout even when app-server leaves a child process running', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-codex-tree-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pidFile = path.join(root, 'grandchild.pid')
  const sleeper = path.join(root, 'sleeper.mjs')
  fs.writeFileSync(
    sleeper,
    `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 60_000)\n`,
  )
  const fakeCodex = makeFakeCodex(
    root,
    `
import { spawn } from 'node:child_process'
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
let child
rl.on('line', line => {
  const msg = JSON.parse(line)
  if (msg.id === 1) {
    child = spawn(process.execPath, [${JSON.stringify(sleeper)}], { stdio: 'inherit', windowsHide: true })
    process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n')
  } else if (msg.id === 2) {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        id: 2,
        result: { rateLimits: { primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 1_800_000_000 }, planType: 'plus' } },
      }) + '\\n')
    }, 150)
  }
})
`,
  )
  const started = Date.now()
  const proc = spawn(process.execPath, [codexLimitsScript, path.join(root, 'empty-sessions'), fakeCodex], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  })
  proc.stdin.end()
  let stdout = ''
  let stderr = ''
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', chunk => { stdout += chunk })
  proc.stderr.on('data', chunk => { stderr += chunk })
  const [code] = await Promise.race([
    once(proc, 'close'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('codex-limits.mjs did not close stdout within 5s')), 5_000)),
  ])
  const elapsed = Date.now() - started
  assert.equal(code, 0, stderr)
  assert.ok(elapsed < 5_000, `expected prompt exit, took ${elapsed}ms`)
  const out = JSON.parse(stdout)
  assert.equal(out.source, 'live')
  assert.equal(out.limits.windows[0].percent, 18)
  if (fs.existsSync(pidFile)) {
    const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    if (grandchildPid > 0) {
      let alive = true
      try {
        process.kill(grandchildPid, 0)
      } catch {
        alive = false
      }
      if (alive) {
        try { process.kill(grandchildPid, 'SIGKILL') } catch {}
      }
      assert.equal(alive, false, `grandchild process ${grandchildPid} was left running`)
    }
  }
})

test('Codex limits runs when invoked through a directory junction or symlink', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-codex-link-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const fakeCodex = makeFakeCodex(
    root,
    `
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  const msg = JSON.parse(line)
  if (msg.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n')
  else if (msg.id === 2) process.stdout.write(JSON.stringify({
    id: 2,
    result: { rateLimits: { primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1_800_000_000 }, planType: 'plus' } },
  }) + '\\n')
})
`,
  )
  const linkDir = path.join(root, 'linked-plugin')
  const repoRoot = path.resolve(path.dirname(codexLimitsScript), '..')
  fs.symlinkSync(repoRoot, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
  const result = spawnSync(process.execPath, [path.join(linkDir, 'bin', 'codex-limits.mjs'), path.join(root, 'empty'), fakeCodex], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const out = JSON.parse(result.stdout)
  assert.equal(out.source, 'live')
  assert.equal(out.limits.windows[0].percent, 7)
})

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

test('2 (runner): run.mjs scrubs known credential values from env.json before writing stderr.log', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-scrub-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'run')
  const cwd = path.join(root, 'project')
  const cli = path.join(root, 'leaky.mjs')
  fs.mkdirSync(dir)
  fs.mkdirSync(cwd)
  // Emits a short, odd-shaped secret directly and across chunks.
  fs.writeFileSync(cli, `
    process.stderr.write('x-api-key: ' + process.env.COPILOT_PROVIDER_API_KEY + '\\n')
    process.stderr.write('raw leak: ' + process.env.COPILOT_PROVIDER_API_KEY.slice(0, 2))
    setTimeout(() => {
      process.stderr.write(process.env.COPILOT_PROVIDER_API_KEY.slice(2) + ' end\\n')
      process.exit(1)
    }, 20)
  `)
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ argv: [process.execPath, cli], cwd, parser: 'text' }))
  fs.writeFileSync(path.join(dir, 'env.json'), JSON.stringify({ COPILOT_PROVIDER_API_KEY: 'q7!z' }))
  const res = spawnSync(process.execPath, [runner, dir], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, AGENT_DECK_DETACHED: '1' },
  })
  assert.ifError(res.error)
  assert.equal(res.status, 0, res.stderr)
  assert.equal(fs.existsSync(path.join(dir, 'env.json')), false)
  const stderr = fs.readFileSync(path.join(dir, 'stderr.log'), 'utf8')
  assert.equal(stderr.includes('q7!z'), false, `expected secret scrubbed from stderr.log, got: ${stderr}`)
  assert.match(stderr, /\[redacted\]/)
})

test('4 (runner): Codex limits cleans up grandchild processes even when taskkill fails, and read timeout leaves cleanup margin', async t => {
  const mod = await import('../bin/codex-limits.mjs')
  if (process.platform === 'win32') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-codex-fallback-kill-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const pidFile = path.join(root, 'grandchild.pid')
    const sleeper = path.join(root, 'sleeper.mjs')
    fs.writeFileSync(
      sleeper,
      `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 60_000)\n`,
    )
    const fakeCodex = makeFakeCodex(
      root,
      `
import { spawn } from 'node:child_process'
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  const msg = JSON.parse(line)
  if (msg.id === 1) {
    spawn(process.execPath, [${JSON.stringify(sleeper)}], { stdio: 'ignore', windowsHide: true })
    process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n')
  } else if (msg.id === 2) {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        id: 2,
        result: { rateLimits: { primary: { usedPercent: 19, windowDurationMins: 300, resetsAt: 1_800_000_000 }, planType: 'plus' } },
      }) + '\\n')
    }, 200)
  }
})
`,
    )
    // Force taskkill to fail by pointing taskkillPath at a non-existent binary (without breaking SystemRoot for PowerShell).
    const res = await mod.readLiveLimits(fakeCodex, { taskkillPath: path.join(root, 'no-such-taskkill.exe') })
    assert.equal(res.source, 'live')
    assert.equal(res.limits.windows[0].percent, 19)
    assert.equal(fs.existsSync(pidFile), true, 'expected grandchild to have started')
    const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    let alive = true
    try {
      process.kill(grandchildPid, 0)
    } catch {
      alive = false
    }
    if (alive) {
      try { process.kill(grandchildPid, 'SIGKILL') } catch {}
    }
    assert.equal(alive, false, `grandchild process ${grandchildPid} survived when taskkill failed`)
  }
  assert.ok(typeof mod.LIVE_TIMEOUT_MS === 'number' && mod.LIVE_TIMEOUT_MS <= 15_000, `expected LIVE_TIMEOUT_MS <= 15000, got ${mod.LIVE_TIMEOUT_MS}`)
})

test('1 (runner): bin/claim.mjs serializes claim, refresh, deliver and release without overwriting delivered', t => {
  const claimScript = fileURLToPath(new URL('../bin/claim.mjs', import.meta.url))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-claim-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const call = args => {
    const r = spawnSync(process.execPath, [claimScript, ...args], { encoding: 'utf8', timeout: 5_000 })
    assert.ifError(r.error)
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout.trim())
  }
  assert.deepEqual(call(['claim', root, 'tok-a', '1000', '600000']), { state: 'claimed', token: 'tok-a', at: 1000 })
  assert.deepEqual(call(['claim', root, 'tok-b', '1500', '600000']), { state: 'taken', token: 'tok-a', at: 1000 })
  assert.deepEqual(call(['claim', root, 'tok-a', '1500', '600000']), { state: 'owned', token: 'tok-a', at: 1000 })
  assert.deepEqual(call(['refresh', root, 'tok-a', '2000']), { state: 'owned', token: 'tok-a', at: 2000 })
  assert.deepEqual(call(['release', root, 'tok-b']), { state: 'kept' })
  assert.deepEqual(call(['release', root, 'tok-a']), { state: 'released' })
  assert.deepEqual(call(['claim', root, 'tok-b', '3000', '600000']), { state: 'claimed', token: 'tok-b', at: 3000 })
  assert.deepEqual(call(['deliver', root, '3500']), { state: 'delivered' })
  // Delivered timestamp is never overwritten by claim, deliver, or release.
  assert.deepEqual(call(['claim', root, 'tok-a', '4000', '600000']), { state: 'delivered' })
  assert.deepEqual(call(['deliver', root, '5000']), { state: 'delivered' })
  assert.deepEqual(call(['release', root, 'tok-b']), { state: 'delivered' })
  assert.equal(fs.readFileSync(path.join(root, 'delivered.txt'), 'utf8'), '3500')
})

test('7 (runner): watch.mjs emits byte offsets and resumes from a saved offset without replaying old messages', async t => {
  const watchScript = fileURLToPath(new URL('../bin/watch.mjs', import.meta.url))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-watch-off-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const now = new Date()
  const dayDir = path.join(root, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
  fs.mkdirSync(dayDir, { recursive: true })
  fs.mkdirSync(path.join(root, 'runs'), { recursive: true })
  const rollout = path.join(dayDir, 'rollout-th-resume.jsonl')
  const line1 = JSON.stringify({ type: 'session_meta', timestamp: now.toISOString(), payload: { id: 'th-resume', cwd: 'C:\\src\\proj' } }) + '\n'
  const line2 = JSON.stringify({ type: 'event_msg', timestamp: now.toISOString(), payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'm1', content: [{ text: 'First line — utf8 ✓' }] } } }) + '\n'
  const line3 = JSON.stringify({ type: 'event_msg', timestamp: now.toISOString(), payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'm2', content: [{ text: 'Second line after reopen' }] } } }) + '\n'
  fs.writeFileSync(rollout, line1 + line2)

  const readWatch = extraArgs =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [watchScript, path.join(root, 'sessions'), path.join(root, 'runs'), 'C:\\src\\proj', String(Date.now() - 60_000), ...extraArgs], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      })
      const events = []
      let buf = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(events)
      }, 600)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        buf += chunk
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const l of lines) {
          if (l.startsWith('{')) events.push(JSON.parse(l))
        }
      })
      child.on('error', err => { clearTimeout(timer); reject(err) })
    })

  const first = await readWatch([])
  const firstMsg = first.find(e => e.t === 'msg')
  assert.ok(firstMsg, 'expected first message')
  assert.equal(firstMsg.text, 'First line — utf8 ✓')
  assert.equal(firstMsg.off, Buffer.byteLength(line1 + line2, 'utf8'))

  // Append a second message and start a fresh watcher with the saved byte offset.
  fs.appendFileSync(rollout, line3)
  const second = await readWatch([JSON.stringify({ 'th-resume': firstMsg.off })])
  const msgs = second.filter(e => e.t === 'msg')
  assert.deepEqual(msgs.map(m => m.text), ['Second line after reopen'])
  assert.equal(msgs[0].off, Buffer.byteLength(line1 + line2 + line3, 'utf8'))
})

test('9 (runner): bin/pid-alive.mjs reports alive for running pid and false for an exited process', async () => {
  const pidScript = fileURLToPath(new URL('../bin/pid-alive.mjs', import.meta.url))
  const check = pid => {
    const r = spawnSync(process.execPath, [pidScript, String(pid)], { encoding: 'utf8', timeout: 5_000 })
    assert.ifError(r.error)
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout.trim())
  }
  assert.deepEqual(check(process.pid), { alive: true })
  // Spawn a short-lived child, wait for it to exit, then verify pid-alive reports false.
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true })
  const deadPid = child.pid
  await once(child, 'close')
  assert.deepEqual(check(deadPid), { alive: false })
})
