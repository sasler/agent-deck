// agent-deck: Codex's usage limits, read live from `codex app-server` with a
// fallback to its newest rollout file.
//
//   node codex-limits.mjs <codexSessionsDir> [codexCommand]
//
// Starts `codex app-server` without a shell (via launch.mjs), initializes it,
// calls `account/rateLimits/read`, and kills it as soon as it answers. On any
// failure (missing CLI, not signed in, error, old CLI, timeout), falls back to
// the newest rollout file that has a `rate_limits` reading. Prints
// {"ts": <epoch ms>, "limits": {...}, "source": "live"|"rollout"} on one line,
// or {"error": "..."}. Never logs raw responses.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { launchArgv } from './launch.mjs'

const TAIL_BYTES = 262_144
const MAX_FILES = 8
const LIVE_TIMEOUT_MS = 20_000

const pluginVersion = () => {
  try {
    const raw = fs.readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')
    return String(JSON.parse(raw).version || '0.0.0')
  } catch {
    return '0.0.0'
  }
}

/** A token_count's rate_limits as the meters read them: used percent per window, reset time in ms. */
export const limitsOf = rl => {
  if (!rl) return undefined
  const ws = []
  for (const w of [rl.primary, rl.secondary]) {
    if (w && typeof w.used_percent === 'number') {
      ws.push({ minutes: w.window_minutes, percent: w.used_percent, resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : undefined })
    }
  }
  return ws.length ? { windows: ws, plan: rl.plan_type ?? undefined } : undefined
}

/** An app-server account/rateLimits/read `rateLimits` object mapped to the same meter shape (resetsAt in ms). */
export const liveLimitsOf = rl => {
  if (!rl || typeof rl !== 'object') return undefined
  const ws = []
  for (const w of [rl.primary, rl.secondary]) {
    if (w && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent)) {
      ws.push({
        minutes: typeof w.windowDurationMins === 'number' && Number.isFinite(w.windowDurationMins) ? w.windowDurationMins : undefined,
        percent: w.usedPercent,
        resetsAt: typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : undefined,
      })
    }
  }
  return ws.length ? { windows: ws, plan: typeof rl.planType === 'string' && rl.planType ? rl.planType : undefined } : undefined
}

const liveLimitsFromResult = result => {
  if (!result || typeof result !== 'object') return undefined
  const direct = liveLimitsOf(result.rateLimits)
  if (direct) return direct
  const byId = result.rateLimitsByLimitId
  if (byId && typeof byId === 'object') {
    if (byId.codex) {
      const codex = liveLimitsOf(byId.codex)
      if (codex) return codex
    }
    for (const v of Object.values(byId)) {
      const found = liveLimitsOf(v)
      if (found) return found
    }
  }
  return undefined
}

/** Asks `codex app-server` for the current rate limits over stdio JSON lines, then kills it. */
export const readLiveLimits = (command = 'codex', { timeoutMs = LIVE_TIMEOUT_MS, version = pluginVersion(), now = () => Date.now() } = {}) =>
  new Promise((resolve, reject) => {
    let argv
    try {
      argv = launchArgv(command, ['app-server'])
    } catch (err) {
      return reject(err)
    }
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false })
    } catch (err) {
      return reject(err)
    }
    let settled = false
    let buf = ''
    let isInitialized = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.stdin?.end()
      } catch {}
      try {
        child.kill()
      } catch {}
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, new Error(`no answer within ${timeoutMs / 1000}s`)), timeoutMs)
    timer.unref()
    const send = msg => {
      if (settled) return
      try {
        child.stdin.write(`${JSON.stringify(msg)}\n`)
      } catch (err) {
        finish(reject, err)
      }
    }
    child.stdin.on('error', () => {})
    child.on('error', err => finish(reject, err))
    child.on('close', code => finish(reject, new Error(`codex app-server exited ${code ?? '?'} before answering`)))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (settled) return
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) continue
        let msg
        try {
          msg = JSON.parse(trimmed)
        } catch {
          continue
        }
        if (msg.id === 1 && !isInitialized) {
          if (msg.error) return finish(reject, new Error('initialize failed'))
          isInitialized = true
          send({ method: 'initialized' })
          send({ id: 2, method: 'account/rateLimits/read' })
        } else if (msg.id === 2) {
          if (msg.error) return finish(reject, new Error('rate limits read failed'))
          const limits = liveLimitsFromResult(msg.result)
          if (!limits) return finish(reject, new Error('no rate limits in response'))
          return finish(resolve, { ts: now(), limits, source: 'live' })
        }
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-deck', version } } })
  })

/** The day folders (sessions/YYYY/MM/DD) of the last `days` days, newest first. */
export const dayDirs = (sessionsDir, now = Date.now(), days = 2) => {
  const out = []
  for (let back = 0; back < days; back++) {
    const d = new Date(now - back * 86_400_000)
    out.push(path.join(sessionsDir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')))
  }
  return out
}

const tail = (file, size) => {
  const start = Math.max(0, size - TAIL_BYTES)
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    const n = fs.readSync(fd, buf, 0, buf.length, start)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The newest reading on the machine: the last rate_limits line of the most recently
 * written rollout that has one, looking back `days` days. `ts` is the line's own time.
 */
export const newestLimits = (sessionsDir, { now = Date.now(), days = 7 } = {}) => {
  const files = []
  for (const dir of dayDirs(sessionsDir, now, days)) {
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(dir, name)
      try {
        const stat = fs.statSync(file)
        files.push({ file, size: stat.size, mtimeMs: stat.mtimeMs })
      } catch {}
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const f of files.slice(0, MAX_FILES)) {
    let lines
    try {
      lines = tail(f.file, f.size).split('\n')
    } catch {
      continue
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue
      try {
        const o = JSON.parse(lines[i])
        const limits = limitsOf(o.payload?.rate_limits)
        if (limits) return { ts: Date.parse(o.timestamp) || f.mtimeMs, limits, file: f.file }
      } catch {}
    }
  }
  return undefined
}

/** Tries `codex app-server` live first; on any failure falls back to the newest rollout file. */
export const readCodexLimits = async (sessionsDir, { command = 'codex', timeoutMs = LIVE_TIMEOUT_MS, now } = {}) => {
  if (command) {
    try {
      return await readLiveLimits(command, { timeoutMs, ...(now ? { now: () => now } : {}) })
    } catch {}
  }
  const found = sessionsDir ? newestLimits(sessionsDir, now ? { now } : undefined) : undefined
  return found ? { ...found, source: 'rollout' } : undefined
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , sessionsDir, codexCommand] = process.argv
  const out = obj => process.stdout.write(JSON.stringify(obj) + '\n', () => process.exit(0))
  readCodexLimits(sessionsDir, { command: codexCommand || 'codex' })
    .then(found =>
      out(
        found ?? {
          error: sessionsDir
            ? 'Could not read Codex usage limits live, and no Codex session file has a reading yet.'
            : 'Could not read Codex usage limits.',
        },
      ),
    )
    .catch(() => out({ error: 'Could not read Codex usage limits.' }))
}
