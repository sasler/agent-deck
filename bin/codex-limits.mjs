// agent-deck: Codex's usage limits, read now from its newest rollout file.
//
//   node codex-limits.mjs <codexSessionsDir>
//
// Codex writes its rate limits into each session's rollout (a token_count event);
// there is no command that asks for them. This finds the newest rollout that has a
// reading and prints {"ts": <when it was written>, "limits": {...}} on one line,
// or {"error": "..."}. The watcher seeds its meters with the same reading.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TAIL_BYTES = 262_144
const MAX_FILES = 8

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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , sessionsDir] = process.argv
  try {
    const found = sessionsDir ? newestLimits(sessionsDir) : undefined
    process.stdout.write(JSON.stringify(found ?? { error: sessionsDir ? 'No Codex session file has a usage reading yet.' : 'usage: codex-limits.mjs <codexSessionsDir>' }) + '\n')
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: String(err?.message ?? err) }) + '\n')
  }
}
