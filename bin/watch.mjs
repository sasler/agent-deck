// agent-deck watcher: tails Codex rollout files and agent-deck run folders,
// printing one compact JSON event per line for the hooks module to read.
//
//   node watch.mjs <codexSessionsDir> <runsDir> <projectCwd> <sinceMs>
//
// Rollouts whose cwd is inside the project (or inside a Claude scratchpad for
// this project) are tailed from the start; others only from their last 256 KB,
// and only their rate limits are reported.
import fs from 'node:fs'
import path from 'node:path'

import { limitsOf, newestLimits } from './codex-limits.mjs'

const [, , sessionsDir, runsDir, projectCwd, sinceArg] = process.argv
const since = Number(sinceArg) || Date.now() - 30 * 60_000
const TICK_MS = 1000
const MAX_CHUNK = 8 * 1024 * 1024

const norm = p =>
  String(p ?? '')
    .replace(/^file:\/\/\/?/i, '')
    .replace(/\\/g, '/')
    .replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:')
    .replace(/\/+$/, '')
    .toLowerCase()
const project = norm(projectCwd)
const slug = project.replace(/[^a-z0-9]/g, '-')
const isOurs = cwd => {
  const c = norm(cwd)
  return (project && (c === project || c.startsWith(project + '/'))) || (slug && c.includes(`/claude/${slug}/`))
}

const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n')
const base = p => String(p ?? '').replace(/^file:\/\/\/?/i, '').split(/[\\/]/).pop()
const clip = (s, n = 4000) => (s.length > n ? s.slice(0, n) + '…' : s)

/** @type {Map<string, {offset: number, matched: boolean, thread: string, partial: string, skipFirst: boolean}>} */
const files = new Map()
const runs = new Map() // run id -> thread id once known

const dayDirs = () => {
  const out = []
  for (const back of [0, 1]) {
    const d = new Date(Date.now() - back * 86_400_000)
    const p = path.join(
      sessionsDir,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    )
    out.push(p)
  }
  return out
}

const readHead = (file, bytes = 65536) => {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const n = fs.readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

const readRange = (file, start, length) => {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const n = fs.readSync(fd, buf, 0, length, start)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

const commandLabel = item => {
  const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd : []
  const fromParsed = parsed.map(p => p?.cmd).filter(Boolean).join(' && ')
  let cmd = fromParsed
  if (!cmd) {
    const c = item.command
    cmd = Array.isArray(c) ? String(c[c.length - 1] ?? '') : String(c ?? '')
    const m = cmd.match(/(?:-Command|-lc|-c)\s+(['"])([\s\S]*)\1\s*$/)
    if (m) cmd = m[2]
  }
  return '$ ' + cmd.replace(/\s+/g, ' ').trim()
}

const itemEvent = (f, ts, item, done) => {
  const id = item.id
  const status = !done
    ? 'running'
    : item.status === 'failed' || (item.exit_code !== undefined && item.exit_code !== null && Number(item.exit_code) !== 0)
      ? 'error'
      : 'done'
  switch (item.type) {
    case 'AgentMessage': {
      if (!done) return
      const text = (item.content ?? []).map(c => c?.text ?? '').join('')
      if (text.trim()) emit({ f, ts, t: 'msg', text: clip(text), phase: item.phase })
      return
    }
    case 'Reasoning': {
      if (!done) return
      const text = (item.summary_text ?? []).join('\n')
      if (text.trim()) emit({ f, ts, t: 'reason', text: clip(text, 1500) })
      return
    }
    case 'UserMessage': {
      const text = (item.content ?? []).map(c => c?.text ?? '').join('')
      if (text.trim()) emit({ f, ts, t: 'prompt', text: clip(text, 300) })
      return
    }
    case 'CommandExecution':
      return emit({ f, ts, t: 'act', id, label: commandLabel(item), status })
    case 'FileChange': {
      const changes = item.changes && typeof item.changes === 'object' ? Object.keys(item.changes) : []
      return emit({ f, ts, t: 'act', id, label: 'edit ' + (changes.map(base).join(', ') || 'files'), status })
    }
    case 'Extension':
      return emit({ f, ts, t: 'act', id, label: item.kind === 'web.search' ? `search ${item.query ?? ''}` : String(item.kind ?? 'extension'), status })
    case 'ImageView':
      return emit({ f, ts, t: 'act', id, label: 'view ' + base(item.path), status })
    case 'McpToolCall':
      return emit({ f, ts, t: 'act', id, label: `${item.server ?? 'mcp'}.${item.tool ?? ''}`, status })
    case 'ContextCompaction':
      return emit({ f, ts, t: 'act', id, label: 'compact context', status })
    default:
      return
  }
}

/** A short label for a custom_tool_call / function_call: what the cell or tool is doing. */
const callLabel = p => {
  const first = s => String(s ?? '').split('\n').map(l => l.trim()).find(l => l && !l.startsWith('//')) ?? ''
  if (p.type === 'custom_tool_call') {
    const line = first(p.input).replace(/\s+/g, ' ')
    return `${p.name ?? 'tool'} ${line.length > 90 ? line.slice(0, 90) + '…' : line}`.trim()
  }
  let args = {}
  try {
    args = JSON.parse(p.arguments ?? '{}') ?? {}
  } catch {}
  if (p.name === 'wait') return `wait for cell ${args.cell_id ?? ''}`.trim()
  const ns = String(p.namespace ?? '').replace(/^mcp__/, '')
  const what = args.title ?? first(args.code ?? args.cmd ?? args.command ?? '')
  return `${ns ? ns + '.' : ''}${p.name ?? 'tool'}${what ? ' ' + clip(String(what).replace(/\s+/g, ' '), 90) : ''}`
}


const handleLine = (state, line) => {
  if (!line.includes('"type"')) return
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return
  }
  const f = state.thread
  const ts = Date.parse(o.timestamp) || Date.now()
  const p = o.payload ?? {}

  if (o.type === 'event_msg' && p.type === 'token_count') {
    const limits = limitsOf(p.rate_limits)
    if (!state.matched) {
      if (limits) emit({ t: 'limits', ts, limits })
      return
    }
    const u = p.info?.total_token_usage
    emit({
      f,
      ts,
      t: 'tok',
      tokens: u
        ? {
            input: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)),
            cacheRead: u.cached_input_tokens ?? 0,
            cacheWrite: u.cache_write_input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            reasoning: u.reasoning_output_tokens ?? 0,
          }
        : undefined,
      limits,
    })
    return
  }
  if (!state.matched) return

  if (o.type === 'response_item') {
    // Code mode and namespaced tools: one call can run for minutes (a JS cell driving many tools,
    // a `wait` on a cell), so show it while it runs; its *_output line marks it done.
    if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      const label = callLabel(p)
      if (label && p.call_id) emit({ f, ts, t: 'act', id: p.call_id, label, status: 'running' })
    } else if ((p.type === 'custom_tool_call_output' || p.type === 'function_call_output') && p.call_id) {
      emit({ f, ts, t: 'act', id: p.call_id, status: 'done' })
    } else {
      emit({ f, ts, t: 'beat' })
    }
    return
  }
  if (o.type === 'turn_context') {
    emit({ f, ts, t: 'ctx', model: p.model, effort: p.effort ?? p.reasoning_effort })
  } else if (o.type === 'event_msg') {
    if (p.type === 'task_started') emit({ f, ts, t: 'task', state: 'running' })
    else if (p.type === 'task_complete') emit({ f, ts, t: 'task', state: 'done' })
    else if (p.type === 'turn_aborted') emit({ f, ts, t: 'task', state: 'aborted' })
    else if (p.type === 'error') emit({ f, ts, t: 'err', text: clip(String(p.message ?? 'error'), 500) })
    else if (p.type === 'item_started' && p.item) itemEvent(f, ts, p.item, false)
    else if (p.type === 'item_completed' && p.item) itemEvent(f, ts, p.item, true)
  }
}

const tailFile = (file, stat) => {
  let state = files.get(file)
  if (!state) {
    let meta
    try {
      meta = JSON.parse(readHead(file).split('\n')[0])
    } catch {
      return // first line not complete yet; try next tick
    }
    if (meta?.type !== 'session_meta') return
    const thread = meta.payload?.id ?? path.basename(file)
    const matched = isOurs(meta.payload?.cwd)
    const offset = matched ? 0 : Math.max(0, stat.size - 262_144)
    state = { offset, matched, thread, partial: '', skipFirst: offset > 0 }
    files.set(file, state)
    if (matched) {
      emit({ f: thread, ts: Date.parse(meta.payload?.timestamp ?? meta.timestamp) || stat.birthtimeMs, t: 'meta', cwd: meta.payload?.cwd, file })
    }
  }
  // Catch up in chunks, at most 8 per tick so one huge file can't stall the rest.
  for (let i = 0; i < 8 && stat.size > state.offset; i++) {
    const length = Math.min(MAX_CHUNK, stat.size - state.offset)
    const text = state.partial + readRange(file, state.offset, length)
    state.offset += length
    const lines = text.split('\n')
    state.partial = lines.pop() ?? ''
    if (state.skipFirst) {
      lines.shift()
      state.skipFirst = false
    }
    for (const line of lines) handleLine(state, line)
  }
}

const scanRuns = () => {
  let dirs = []
  try {
    dirs = fs.readdirSync(runsDir)
  } catch {
    return
  }
  for (const id of dirs) {
    if (runs.has(id)) continue
    const events = path.join(runsDir, id, 'events.jsonl')
    try {
      const first = readHead(events, 4096).split('\n')[0]
      const o = JSON.parse(first)
      if (o?.type === 'thread.started' && o.thread_id) {
        runs.set(id, o.thread_id)
        emit({ t: 'run', run: id, thread: o.thread_id })
      }
    } catch {}
  }
}

const tick = () => {
  for (const dir of dayDirs()) {
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(dir, name)
      let stat
      try {
        stat = fs.statSync(file)
      } catch {
        continue
      }
      if (stat.mtimeMs < since && !files.has(file)) continue
      try {
        tailFile(file, stat)
      } catch {}
    }
  }
  scanRuns()
}

// Seed the limit bars from the newest reading on the machine, whatever its age; ts is when Codex wrote it.
const seedLimits = () => {
  const found = newestLimits(sessionsDir)
  if (found) emit({ t: 'limits', ts: found.ts, limits: found.limits, source: 'rollout' })
}

emit({ t: 'hello', pid: process.pid })
try {
  seedLimits()
} catch {}
tick()
setInterval(tick, TICK_MS)
// Exit when the hooks module goes away (stdout closed).
process.stdout.on('error', () => process.exit(0))
