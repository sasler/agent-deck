// agent-deck: Codex's usage limits, read live from `codex app-server` with a
// fallback to its newest rollout file.
//
//   node codex-limits.mjs <codexSessionsDir> [codexCommand]
//
// Starts `codex app-server` without a shell (via launch.mjs), initializes it,
// calls `account/rateLimits/read`, and kills its whole process tree as soon as
// it answers. On any failure (missing CLI, not signed in, error, old CLI,
// timeout), falls back to the newest rollout file that has a `rate_limits`
// reading, recording a short safe reason in `liveError`. Prints
// {"ts": <epoch ms>, "limits": {...}, "source": "live"|"rollout", "liveError"?: "..."}
// on one line, or {"error": "..."}. Never logs raw responses or tokens.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { launchArgv } from './launch.mjs'

const isWindows = process.platform === 'win32'
const TAIL_BYTES = 262_144
const MAX_FILES = 8
/** Live read timeout: leaves margin for process-tree cleanup inside the 22s outer timeout. */
export const LIVE_TIMEOUT_MS = 12_000
const CLEANUP_TIMEOUT_MS = 3_000
const MAX_REASON = 80

const pluginVersion = () => {
  try {
    const raw = fs.readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')
    return String(JSON.parse(raw).version || '0.0.0')
  } catch {
    return '0.0.0'
  }
}

const clipReason = text => {
  const clean = String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return 'could not read live'
  return clean.length <= MAX_REASON ? clean : `${clean.slice(0, MAX_REASON - 1).trimEnd()}…`
}

/** Maps a JSON-RPC error from `codex app-server` to a short fixed category so raw messages/tokens never leak. */
const rpcReason = (rpcError, fallback) => {
  const code = typeof rpcError?.code === 'number' ? rpcError.code : undefined
  const msg = typeof rpcError?.message === 'string' ? rpcError.message : ''
  if (code === -32601 || /method not found|unknown method|unimplemented/i.test(msg)) return 'Codex CLI too old'
  if (/not logged in|not signed in|unauthenticated|unauthorized|login required|sign in|missing auth|no auth|\bauth\b/i.test(msg)) {
    return 'not logged in'
  }
  if (/rate.?limit|too many requests|\b429\b/i.test(msg)) return 'rate limited'
  if (/timed? ?out/i.test(msg)) return 'timed out'
  if (/network|econn|enotfound|dns|fetch|socket|offline/i.test(msg)) return 'network error'
  return fallback
}

/** Short, safe reason for a live read failure (max 80 chars, no raw responses or tokens). */
export const liveErrorReason = err => {
  if (!err) return 'could not read live'
  if (typeof err === 'object' && err.safeReason) return clipReason(err.safeReason)
  const code = typeof err === 'object' ? err.code : undefined
  if (code === 'ENOENT') return 'no codex CLI found'
  if (code === 'EACCES' || code === 'EPERM') return 'codex not executable'
  if (typeof code === 'string' && code) return clipReason(`could not start codex (${code})`)
  const msg = String(err?.message ?? err)
  if (/cannot start safely without a shell/i.test(msg)) return 'unsupported Codex script'
  if (/no answer within/i.test(msg) || /timed? ?out/i.test(msg)) return 'timed out'
  if (/exited \S+ before answering/i.test(msg)) {
    const m = /exited (\S+) before answering/.exec(msg)
    return clipReason(`codex exited ${m ? m[1] : '?'}`)
  }
  return 'could not read live'
}

const safeError = reason => {
  const err = new Error(reason)
  err.safeReason = reason
  return err
}

const closeStdio = child => {
  for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
    try {
      stream?.destroy()
    } catch {}
  }
}

/** Parses `pid,ppid` or WMIC CSV (`Node,ParentProcessId,ProcessId`) rows into descendant PIDs of `rootPid`, deepest first. */
export const collectDescendants = (rootPid, rows) => {
  const byParent = new Map()
  for (const { pid, ppid } of rows) {
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0) continue
    let list = byParent.get(ppid)
    if (!list) {
      list = []
      byParent.set(ppid, list)
    }
    list.push(pid)
  }
  const seen = new Set([rootPid])
  const order = []
  const queue = [rootPid]
  while (queue.length) {
    const cur = queue.shift()
    for (const childPid of byParent.get(cur) ?? []) {
      if (seen.has(childPid) || childPid === process.pid) continue
      seen.add(childPid)
      order.push(childPid)
      queue.push(childPid)
    }
  }
  return order.reverse()
}

const parseWmicCsv = text => {
  const rows = []
  let pidIdx = -1
  let ppidIdx = -1
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const cols = line.split(',').map(c => c.trim())
    if (pidIdx < 0) {
      pidIdx = cols.findIndex(c => c.toLowerCase() === 'processid')
      ppidIdx = cols.findIndex(c => c.toLowerCase() === 'parentprocessid')
      continue
    }
    const pid = Number.parseInt(cols[pidIdx] ?? '', 10)
    const ppid = Number.parseInt(cols[ppidIdx] ?? '', 10)
    if (Number.isInteger(pid) && Number.isInteger(ppid)) rows.push({ pid, ppid })
  }
  return rows
}

const parsePidPairs = text => {
  const rows = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(raw)
    if (m) rows.push({ pid: Number.parseInt(m[1], 10), ppid: Number.parseInt(m[2], 10) })
  }
  return rows
}

const resolveSystemTool = (relPath, fallback) => {
  if (process.env.SystemRoot) {
    const full = path.join(process.env.SystemRoot, relPath)
    if (fs.existsSync(full)) return full
  }
  return fallback
}

/** Lists `(pid, ppid)` rows on Windows without a shell: WMIC first where installed, else CIM via PowerShell. */
const listWindowsProcesses = ({ wmicPath, powershellPath, timeoutMs = CLEANUP_TIMEOUT_MS } = {}) => {
  const wmic = wmicPath ?? resolveSystemTool(path.join('System32', 'wbem', 'WMIC.exe'), 'wmic.exe')
  try {
    const r = spawnSync(wmic, ['process', 'get', 'ProcessId,ParentProcessId', '/format:csv'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      shell: false,
      timeout: timeoutMs,
    })
    if (!r.error && r.status === 0 && r.stdout) {
      const rows = parseWmicCsv(r.stdout)
      if (rows.length) return rows
    }
  } catch {}
  const ps = powershellPath ?? resolveSystemTool(path.join('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), 'powershell.exe')
  try {
    const r = spawnSync(
      ps,
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        shell: false,
        timeout: timeoutMs,
      },
    )
    if (!r.error && r.status === 0 && r.stdout) return parsePidPairs(r.stdout)
  } catch {}
  return []
}

/** Kills `child` and every descendant it started, without a shell, then closes its stdio pipes. */
export const killTree = (child, { taskkillPath, wmicPath, powershellPath, timeoutMs = CLEANUP_TIMEOUT_MS } = {}) => {
  const pid = child?.pid
  if (pid) {
    if (isWindows) {
      let taskkillOk = false
      try {
        const taskkill =
          taskkillPath ??
          (process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'taskkill.exe') : 'taskkill')
        const r = spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          shell: false,
          timeout: timeoutMs,
        })
        taskkillOk = !r.error && r.status === 0
      } catch {}
      if (!taskkillOk) {
        const descendants = collectDescendants(pid, listWindowsProcesses({ wmicPath, powershellPath, timeoutMs }))
        for (const descPid of descendants) {
          try {
            process.kill(descPid, 'SIGKILL')
          } catch {}
        }
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
    }
  }
  try {
    child?.kill('SIGKILL')
  } catch {}
  closeStdio(child)
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

/** Asks `codex app-server` for the current rate limits over stdio JSON lines, then kills its whole tree. */
export const readLiveLimits = (
  command = 'codex',
  { timeoutMs = LIVE_TIMEOUT_MS, version = pluginVersion(), now = () => Date.now(), taskkillPath, wmicPath, powershellPath } = {},
) =>
  new Promise((resolve, reject) => {
    let argv
    try {
      argv = launchArgv(command, ['app-server'])
    } catch (err) {
      return reject(err)
    }
    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: !isWindows,
        windowsHide: true,
        shell: false,
      })
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
      killTree(child, { taskkillPath, wmicPath, powershellPath })
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, safeError('timed out')), timeoutMs)
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
    child.stdout.on('error', () => {})
    child.on('error', err => finish(reject, err))
    child.on('close', code => finish(reject, safeError(`codex exited ${code ?? '?'}`)))
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
          if (msg.error) return finish(reject, safeError(rpcReason(msg.error, 'initialize failed')))
          isInitialized = true
          send({ method: 'initialized' })
          send({ id: 2, method: 'account/rateLimits/read' })
        } else if (msg.id === 2) {
          if (msg.error) return finish(reject, safeError(rpcReason(msg.error, 'rate limits read failed')))
          const limits = liveLimitsFromResult(msg.result)
          if (!limits) return finish(reject, safeError('no rate limits in response'))
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

/** Tries `codex app-server` live first; on any failure falls back to the newest rollout file with `liveError`. */
export const readCodexLimits = async (sessionsDir, { command = 'codex', timeoutMs = LIVE_TIMEOUT_MS, now } = {}) => {
  let liveError
  if (command) {
    try {
      return await readLiveLimits(command, { timeoutMs, ...(now ? { now: () => now } : {}) })
    } catch (err) {
      liveError = liveErrorReason(err)
    }
  } else {
    liveError = 'no codex CLI found'
  }
  const found = sessionsDir ? newestLimits(sessionsDir, now ? { now } : undefined) : undefined
  return found ? { ...found, source: 'rollout', liveError } : { error: liveError }
}

const realPath = p => {
  const resolved = path.resolve(p)
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

/** True when this file was invoked directly, also through a symlink or Windows directory junction. */
const isMain = () => {
  if (!process.argv[1]) return false
  const a = realPath(process.argv[1])
  const b = realPath(fileURLToPath(import.meta.url))
  return isWindows ? a.toLowerCase() === b.toLowerCase() : a === b
}

if (isMain()) {
  const [, , sessionsDir, codexCommand] = process.argv
  const out = obj => process.stdout.write(JSON.stringify(obj) + '\n', () => process.exit(0))
  readCodexLimits(sessionsDir, { command: codexCommand || 'codex' })
    .then(found => out(found ?? { error: 'could not read live' }))
    .catch(err => out({ error: liveErrorReason(err) }))
}
