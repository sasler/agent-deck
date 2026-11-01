import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolSpec } from 'claude-code'

import type { Activity, AgentCard, Harness, HarnessModel, HarnessParser, HarnessProvider, HarnessView, LimitWindow, Limits, MeterChoice, MeterProvider, Tokens } from '../types'
import {
  AGENT_RESULT_SPEC,
  PARSERS,
  PRESETS,
  PROVIDER_TYPES,
  agentRunSpec,
  applyHarnessEvent,
  expandArgs,
  fromPreset,
  harnessError,
  modelLabel,
  modelQuery,
  parseLine,
  parseModels,
  providerEnv,
  providerTypesFor,
  type ModelQuery,
  slugId,
} from './harness'
import {
  DEFAULT_WINDOW_MS,
  cacheAfterTurn,
  cacheBeforeStep,
  cacheSessionEnd,
  cacheSessionStart,
  cacheView,
  discardHeld,
  fmtDuration,
  fmtTok,
  fmtUsd,
  freshCache,
  priceOf,
  registerCache,
  sendHeld,
  startKeepWarm,
  stopKeepWarm,
} from './cache'

const PLUGIN = 'agent-deck'
const PANE = 'agent-deck'
const TOOL = `mcp__${PLUGIN}__codex`
const RESULT_TOOL = `mcp__${PLUGIN}__codex_result`
const CODEX_ACCENT = '#10A37F'
const MAX_OUTPUT = 6000
const MAX_CARDS = 40
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

const agents = atom({ plugin: 'agent-deck', key: 'agents' } as const, [] as AgentCard[])
const limits = atom({ plugin: 'agent-deck', key: 'limits' } as const, { codex: [], claude: [] } as Limits)
const expanded = atom({ plugin: 'agent-deck', key: 'expanded' } as const, [] as string[])
const tick = atom({ plugin: 'agent-deck', key: 'tick' } as const, 0)
// The same value ./cache keeps; read here for drawing.
const cacheAtom = atom({ plugin: 'agent-deck', key: 'cache' } as const, freshCache())
const harnessesAtom = atom({ plugin: 'agent-deck', key: 'harnesses' } as const, [] as Harness[])
const viewAtom = atom({ plugin: 'agent-deck', key: 'harnessView' } as const, { mode: 'cards' } as HarnessView)
const foundAtom = atom({ plugin: 'agent-deck', key: 'found' } as const, {} as Record<string, boolean>)
const codexAtom = atom({ plugin: 'agent-deck', key: 'codexEnabled' } as const, false)
const DEFAULT_METERS: MeterChoice = { mode: 'all', selected: ['claude', 'codex', 'copilot'] }
const metersAtom = atom({ plugin: 'agent-deck', key: 'meters' } as const, DEFAULT_METERS)
const COPILOT_ACCENT = '#8957E5'

type $T = EngineInterface

// ---------- pricing (API-equivalent estimate; the table lives in ./cache) ----------

/** A subagent's cost: its cache writes at the 5-minute rate (1.25x input). */
export const costOf = (model: string, t: Omit<Tokens, 'reasoning'>): number | undefined => {
  const p = priceOf(model)
  if (!p) return undefined
  return (
    (t.input * p.input +
      t.output * p.output +
      t.cacheRead * p.cacheRead +
      t.cacheWrite * p.input * 1.25) /
    1_000_000
  )
}

// ---------- formatting ----------

export const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`

export const fmtElapsed = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

/** Cells of a meter `width` wide that `percent` fills. */
export const filledCells = (percent: number, width: number): number =>
  Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)

/** The pane's keep-warm picker: off, or a window in hours. */
export const KEEPWARM_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: '2', label: '2 hours' },
  { value: '4', label: '4 hours' },
  { value: '6', label: '6 hours' },
]

/** The option a running window shows: the smallest that holds what is left. */
export const keepWarmValue = (leftMs?: number): string => {
  if (leftMs === undefined) return 'off'
  const hours = [2, 4, 6].find(h => leftMs <= h * 3_600_000) ?? 6
  return String(hours)
}

async function pickKeepWarm($: $T, value: string) {
  const hours = Number(value)
  if (value === 'off' || !hours) await stopKeepWarm($)
  else await startKeepWarm($, hours * 3_600_000)
}

/** Share of a card's prompt tokens served from cache, in percent; undefined before any. */
export const cacheHitPercent = (t: Tokens): number | undefined => {
  const prompt = t.input + t.cacheRead + t.cacheWrite
  return prompt > 0 ? (t.cacheRead / prompt) * 100 : undefined
}

/** Cuts `text` to `max` characters with an ellipsis. */
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`

const limitColor = (p: number) => (p >= 80 ? 'error' : p >= 50 ? 'warning' : 'success')

/** The theme's status colors as hex, for SVG, which cannot name a theme color. */
const SVG_COLORS = { success: '#3FB950', warning: '#D29922', error: '#F85149' } as const

/** A thick rounded progress bar, stretched to whatever width its slot gives it. */
export const barSvg = (percent: number, fill: string): string => {
  const w = Math.round(Math.min(100, Math.max(0, percent)) * 10)
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="8" viewBox="0 0 1000 8" preserveAspectRatio="none">' +
    '<rect width="1000" height="8" rx="4" fill="#8B949E" fill-opacity="0.3"/>' +
    (w > 0 ? `<rect width="${Math.max(w, 8)}" height="8" rx="4" fill="${fill}"/>` : '') +
    '</svg>'
  )
}

const windowName = (label: string) =>
  label === '5h' ? '5-hour limit' : label === '7d' ? 'Weekly limit' : label === 'mo' ? 'Monthly premium requests' : `${label} limit`

/**
 * Copilot's premium-request window from `gh api copilot_internal/user`: percent used,
 * the monthly reset, and "used of entitlement". Undefined when unlimited or absent.
 */
export const copilotLimits = (d: unknown): { windows: LimitWindow[]; plan: string } | undefined => {
  const o = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>
  const q = ((o.quota_snapshots ?? {}) as Record<string, Record<string, unknown>>).premium_interactions
  if (!q || q.unlimited === true || typeof q.entitlement !== 'number' || q.entitlement <= 0) return undefined
  const remaining = typeof q.remaining === 'number' ? q.remaining : q.entitlement
  const percent = typeof q.percent_remaining === 'number' ? 100 - q.percent_remaining : ((q.entitlement - remaining) / q.entitlement) * 100
  const reset = typeof o.quota_reset_date_utc === 'string' ? Date.parse(o.quota_reset_date_utc) : NaN
  return {
    windows: [{ label: 'mo', percent: Math.max(0, percent), resetsAt: Number.isNaN(reset) ? undefined : reset }],
    plan: `${Math.max(0, q.entitlement - remaining)} of ${q.entitlement}`,
  }
}

/** Whether a provider's meter shows, by the person's choice and what this session used. */
export const isMeterShown = (choice: MeterChoice, p: MeterProvider, used: ReadonlySet<MeterProvider>): boolean =>
  choice.mode === 'all' || (choice.mode === 'session' ? used.has(p) : choice.selected.includes(p))

const toneColor = (tone: 'warm' | 'cold' | 'unknown') => (tone === 'warm' ? 'success' : tone === 'cold' ? 'error' : undefined)

const fmtReset = (at: number | undefined, now: number): string => {
  if (!at) return ''
  const mins = Math.max(0, Math.round((at - now) / 60000))
  return mins < 60 ? `${mins}m` : mins < 2880 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`
}

const windowLabel = (minutes: number | undefined): string =>
  minutes === undefined ? '?' : minutes <= 300 ? `${Math.round(minutes / 60)}h` : minutes >= 10080 ? '7d' : `${Math.round(minutes / 1440)}d`

const statusText = (l: Limits): string | undefined => {
  const part = (name: string, ws: LimitWindow[]) =>
    ws.length ? `${name} ${ws.map(w => `${w.label} ${Math.round(w.percent)}%`).join(' · ')}` : ''
  const text = [part('Codex', l.codex), part('Claude', l.claude), part('Copilot', l.copilot ?? [])].filter(Boolean).join('  │  ')
  return text || undefined
}

const emptyTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })

const appendOutput = (card: AgentCard, text: string) => {
  card.output = (card.output + text).slice(-MAX_OUTPUT)
}

/** Strips Codex's `pwsh -Command '...'` / `bash -lc '...'` wrapper from a command. */
export const shortCommand = (cmd: string): string => {
  const m = cmd.match(/(?:-Command|-lc|-c)\s+(['"])([\s\S]*)\1\s*$/)
  return (m?.[2] ?? cmd).replace(/\s+/g, ' ').trim()
}

const summarizeInput = (tool: string, input: Record<string, unknown>): string => {
  for (const k of ['command', 'file_path', 'pattern', 'url', 'query', 'path', 'description', 'prompt']) {
    const v = input[k]
    if (typeof v === 'string' && v) return `${tool} ${v.replace(/\s+/g, ' ')}`
  }
  return tool
}

// ---------- Codex config + rollout files ----------

export const parseCodexConfig = (toml: string): { model?: string; effort?: string } => {
  const top = toml.split(/^\s*\[/m)[0] ?? ''
  return {
    model: top.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1],
    effort: top.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1],
  }
}

// ---------- paths ----------

const homeDir = async ($: $T): Promise<string | undefined> =>
  (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

const codexHome = async ($: $T): Promise<string | undefined> => {
  const explicit = await $.env.get('CODEX_HOME')
  if (explicit) return explicit
  const home = await homeDir($)
  return home ? `${home}/.codex` : undefined
}

const runsRoot = async ($: $T): Promise<string | undefined> => {
  const home = await homeDir($)
  return home ? `${home}/.claude/agent-deck/runs` : undefined
}

const isWindows = async ($: $T) => (await $.env.get('OS')) === 'Windows_NT'

const winPath = (p: string) => p.replace(/\//g, '\\')

// ---------- module state (restarts on reload; $.state keeps the cards) ----------

type RunMeta = {
  id: string
  title: string
  cwd: string
  sessionId: string
  startedAt: number
  model?: string
  effort?: string
  sandbox?: string
  resume?: string
}

type Run = RunMeta & { dir: string; threadId?: string; isFinished: boolean; isDelivered?: boolean }

const cards = new Map<string, AgentCard>()
const threadToCard = new Map<string, string>()
const runs = new Map<string, Run>()
let flushPending = false
let ticker: { cancel: () => void } | undefined
let poller: { cancel: () => void } | undefined
let runPoller: { cancel: () => void } | undefined
let cacheTicker: { cancel: () => void } | undefined
let codexDefaults: { model?: string; effort?: string } = {}
let sessionId = ''

const CODEX_TOOL_SPEC: ToolSpec = {
  name: 'codex',
  isDeferred: false,
  description:
    'Start a task with OpenAI Codex CLI (codex exec) in the background and return immediately with a run id. ' +
    'Codex runs as its own process, so it survives session drops; its live output, model, tokens and rate limits show in the Agents pane. ' +
    "When it finishes, its final report is delivered to you as a new message automatically: don't poll, sleep or wait for it; continue with other work or end your turn. " +
    'Use codex_result to read a run\'s report or progress on demand. Prefer this over running `codex` through Bash. ' +
    'Leave model/effort/sandbox unset to use ~/.codex/config.toml. Pass `resume` with a thread id from an earlier report to continue that Codex conversation.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The task for Codex.' },
      title: { type: 'string', description: 'A few words shown on the card.' },
      model: { type: 'string', description: 'Codex model override.' },
      effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
      sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
      cwd: { type: 'string', description: 'Working directory; defaults to the session cwd.' },
      resume: { type: 'string', description: 'Codex thread id to continue.' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
}

const CODEX_RESULT_SPEC: ToolSpec = {
  name: 'codex_result',
  isDeferred: false,
  description:
    "Read a background Codex run's report (when finished) or its progress so far. Without `id`, lists this session's Codex runs.",
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The run id the codex tool returned.' } },
    additionalProperties: false,
  },
}

const persist = ($: $T) =>
  update($, agents, () => [...cards.values()].slice(-MAX_CARDS))

const schedule = ($: $T) => {
  if (flushPending) return
  flushPending = true
  $.clock.after(200, () => {
    flushPending = false
    void persist($)
  })
}

const anyRunning = () => [...cards.values()].some(c => c.status === 'running')

const startTicking = ($: $T) => {
  if (ticker) return
  ticker = $.clock.every(1000, () => {
    if (!anyRunning()) {
      ticker?.cancel()
      ticker = undefined
    }
    void update($, tick, n => n + 1)
  })
}

const setLimits = async ($: $T, fn: (l: Limits) => Limits) => {
  const next = await update($, limits, fn)
  $.ui.status(statusText(next ?? (await read($, limits))))
}

const refreshClaudeLimits = async ($: $T) => {
  const usage = await $.session.usage().catch(() => undefined)
  if (!usage) return
  const claude: LimitWindow[] = usage.rateLimits
    .filter(r => r.kind === 'five_hour' || r.kind === 'seven_day')
    .map(r => ({
      label: r.kind === 'five_hour' ? '5h' : '7d',
      percent: r.percentUsed,
      resetsAt: r.resetsAt ? Date.parse(r.resetsAt) || undefined : undefined,
    }))
  await setLimits($, l => ({ ...l, claude }))
}

let version: string | undefined

/** "Agent Deck 0.9.1": the pane's title, with the version read from the plugin's manifest. */
const paneTitle = async ($: $T): Promise<string> => {
  if (version === undefined) {
    try {
      version = String(JSON.parse((await readText($, `${$.plugin.root}/.claude-plugin/plugin.json`)) ?? '{}').version ?? '')
    } catch {
      version = ''
    }
  }
  return version ? `Agent Deck ${version}` : 'Agent Deck'
}

const openPane = ($: $T) => {
  try {
    void paneTitle($)
      .then(title => $.ui.open({ id: PANE, title }))
      .catch(() => {})
  } catch {}
}

const addCard = async ($: $T, card: AgentCard) => {
  cards.set(card.id, card)
  while (cards.size > MAX_CARDS) {
    const oldest = [...cards.values()].find(c => c.status !== 'running')
    if (!oldest) break
    cards.delete(oldest.id)
  }
  openPane($)
  startTicking($)
  await persist($)
}

export const newCodexCard = (id: string, title: string, startedAt: number, extra: Partial<AgentCard> = {}): AgentCard => ({
  id,
  provider: 'codex',
  title,
  model: codexDefaults.model ?? 'codex',
  effort: codexDefaults.effort,
  status: 'running',
  startedAt,
  output: '',
  isThinking: true,
  activity: [],
  tokens: emptyTokens(),
  ...extra,
})

// ---------- the watcher's events ----------

export type WatchEvent =
  | { t: 'hello' }
  | { t: 'limits'; ts: number; limits: WatchLimits }
  | { t: 'run'; run: string; thread: string }
  | { t: 'meta'; f: string; ts: number; cwd: string }
  | { t: 'ctx'; f: string; ts: number; model?: string; effort?: string }
  | { t: 'prompt'; f: string; ts: number; text: string }
  | { t: 'msg'; f: string; ts: number; text: string; phase?: string }
  | { t: 'reason'; f: string; ts: number; text: string }
  | { t: 'act'; f: string; ts: number; id: string; label: string; status: Activity['status'] }
  | { t: 'tok'; f: string; ts: number; tokens?: Omit<Tokens, never>; limits?: WatchLimits }
  | { t: 'task'; f: string; ts: number; state: 'running' | 'done' | 'aborted' }
  | { t: 'err'; f: string; ts: number; text: string }

type WatchLimits = { windows: { minutes?: number; percent: number; resetsAt?: number }[]; plan?: string }

export const toLimitWindows = (l: WatchLimits): LimitWindow[] =>
  l.windows.map(w => ({ label: windowLabel(w.minutes), percent: w.percent, resetsAt: w.resetsAt }))

/** The card a Codex thread feeds: a run's card when the thread is one of ours, else an external one. */
const cardForThread = async ($: $T, thread: string, ts: number): Promise<AgentCard> => {
  const known = threadToCard.get(thread)
  const existing = known ? cards.get(known) : undefined
  if (existing) return existing
  const card = newCodexCard(`codex-${thread}`, 'Codex', ts, { threadId: thread, isExternal: true })
  threadToCard.set(thread, card.id)
  await addCard($, card)
  return card
}

/** Folds an external card that turned out to be one of our runs into the run's card. */
const adoptThread = ($: $T, runId: string, thread: string) => {
  const run = runs.get(runId)
  if (!run) return
  run.threadId = thread
  const runCard = cards.get(`codex-run-${runId}`)
  if (!runCard) return
  runCard.threadId = thread
  const stray = cards.get(`codex-${thread}`)
  if (stray && stray !== runCard) {
    runCard.output = stray.output
    runCard.activity = stray.activity
    runCard.tokens = stray.tokens
    runCard.model = stray.model
    runCard.effort = stray.effort ?? runCard.effort
    runCard.isThinking = stray.isThinking
    cards.delete(stray.id)
  }
  threadToCard.set(thread, runCard.id)
  schedule($)
}

/** Folds one watcher event about a Codex thread into its card. */
export const applyToCard = (card: AgentCard, ev: Extract<WatchEvent, { f: string }>) => {
  const isRunCard = card.runId !== undefined
  switch (ev.t) {
    case 'meta':
      if (card.isExternal) card.startedAt = ev.ts
      break
    case 'ctx':
      if (ev.model) card.model = ev.model
      if (ev.effort) card.effort = ev.effort
      break
    case 'prompt':
      if (card.isExternal && card.title === 'Codex') card.title = ev.text.split('\n')[0]!.slice(0, 70)
      break
    case 'msg':
      card.isThinking = false
      appendOutput(card, `${ev.text.trimEnd()}\n`)
      break
    case 'reason':
      appendOutput(card, `${ev.text.split('\n').map(l => `∴ ${l}`).join('\n')}\n`)
      break
    case 'act': {
      card.isThinking = ev.status !== 'running'
      const has = card.activity.some(a => a.id === ev.id)
      card.activity = has
        ? card.activity.map(a => (a.id === ev.id ? { ...a, label: ev.label, status: ev.status } : a))
        : [...card.activity, { id: ev.id, label: ev.label, status: ev.status }].slice(-30)
      break
    }
    case 'tok':
      if (ev.tokens) card.tokens = { ...ev.tokens }
      break
    case 'task':
      // A run's card is finished by its exit file; an external one by its rollout.
      if (!isRunCard) {
        card.status = ev.state
        card.endedAt = ev.state === 'running' ? undefined : ev.ts
        card.isThinking = ev.state === 'running'
      }
      break
    case 'err':
      card.error = ev.text
      break
  }
}

export const applyWatchEvent = async ($: $T, ev: WatchEvent) => {
  if (ev.t === 'hello') return
  if (ev.t === 'limits') {
    const codex = toLimitWindows(ev.limits)
    if (codex.length) await setLimits($, l => ({ ...l, codex, codexPlan: ev.limits.plan }))
    return
  }
  if (ev.t === 'run') {
    adoptThread($, ev.run, ev.thread)
    return
  }
  const card = await cardForThread($, ev.f, ev.ts)
  applyToCard(card, ev)
  if (ev.t === 'tok' && ev.limits) {
    const codex = toLimitWindows(ev.limits)
    if (codex.length) await setLimits($, l => ({ ...l, codex, codexPlan: ev.limits!.plan }))
  }
  if (ev.t === 'task' && ev.state === 'running') startTicking($)
  schedule($)
}

let watcher: { return?: (value?: unknown) => unknown } | undefined

const stopWatcher = () => {
  void watcher?.return?.(undefined)
  watcher = undefined
}

const startWatcher = ($: $T, args: string[]) => {
  if (watcher) return
  void (async () => {
    let buffer = ''
    try {
      const child = $.process.spawn({ argv: ['node', `${$.plugin.root}/bin/watch.mjs`, ...args] })
      watcher = child as unknown as { return?: (value?: unknown) => unknown }
      for await (const piece of child) {
        if (piece.stream !== 'stdout') continue
        buffer += piece.text
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('{')) continue
          try {
            await applyWatchEvent($, JSON.parse(line) as WatchEvent)
          } catch {}
        }
      }
    } catch (err) {
      if (watcher) $.ui.toast(`agent-deck: live Codex view is off (needs Node.js on PATH): ${String((err as Error)?.message ?? err).slice(0, 120)}`)
    }
    watcher = undefined
  })()
}

// ---------- background runs ----------

const readText = async ($: $T, path: string): Promise<string | undefined> => {
  const text = await $.fs.read(path).catch(() => undefined)
  return typeof text === 'string' ? text : undefined
}

const newRunId = async ($: $T) => {
  const now = await $.clock.now()
  return `${now.toString(36)}-${Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0')}`
}

export const codexArgs = (run: RunMeta, lastFile: string): string[] => {
  const args = ['exec']
  if (run.resume) args.push('resume')
  args.push('--json', '--skip-git-repo-check')
  if (run.model) args.push('-m', run.model)
  if (run.effort) args.push('-c', `model_reasoning_effort=${run.effort}`)
  if (run.sandbox) args.push('-c', `sandbox_mode=${run.sandbox}`)
  args.push('-o', lastFile)
  if (run.resume) args.push(run.resume)
  args.push('-')
  return args
}

const quoteCmd = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)
const quoteSh = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`

/** Writes the run's folder and starts Codex as a process of its own, detached from this session. */
const launchRun = async ($: $T, meta: RunMeta, prompt: string, dir: string) => {
  await $.fs.write(`${dir}/prompt.txt`, prompt)
  await $.fs.write(`${dir}/meta.json`, JSON.stringify(meta, null, 2))
  if (await isWindows($)) {
    const d = winPath(dir)
    const args = codexArgs(meta, `${d}\\last.txt`).map(quoteCmd).join(' ')
    const runner = [
      '@echo off',
      `cd /d ${quoteCmd(winPath(meta.cwd))}`,
      `codex ${args} < "${d}\\prompt.txt" > "${d}\\events.jsonl" 2> "${d}\\stderr.log"`,
      `>"${d}\\exit.txt" echo %ERRORLEVEL%`,
      '',
    ].join('\r\n')
    await $.fs.write(`${dir}/runner.cmd`, runner)
    const started = await $.process.run([
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process -FilePath cmd.exe -ArgumentList '/d /c "${d}\\runner.cmd"' -WindowStyle Hidden`,
    ])
    if (started.exitCode !== 0) throw new Error(started.stderr.trim() || `Start-Process exited ${started.exitCode}`)
  } else {
    const args = codexArgs(meta, `${dir}/last.txt`).map(quoteSh).join(' ')
    const runner = [
      `cd ${quoteSh(meta.cwd)} || exit 1`,
      `codex ${args} < ${quoteSh(`${dir}/prompt.txt`)} > ${quoteSh(`${dir}/events.jsonl`)} 2> ${quoteSh(`${dir}/stderr.log`)}`,
      `echo $? > ${quoteSh(`${dir}/exit.txt`)}`,
      '',
    ].join('\n')
    await $.fs.write(`${dir}/runner.sh`, runner)
    const started = await $.process.run(['sh', '-c', `nohup sh ${quoteSh(`${dir}/runner.sh`)} >/dev/null 2>&1 &`])
    if (started.exitCode !== 0) throw new Error(started.stderr.trim() || `sh exited ${started.exitCode}`)
  }
}

type RunOutcome = { status: 'running' | 'done' | 'error'; report: string; code?: number; error?: string }

const outcomeOf = async ($: $T, run: Run): Promise<RunOutcome> => {
  const exit = await readText($, `${run.dir}/exit.txt`)
  if (exit === undefined) return { status: 'running', report: '' }
  const code = Number.parseInt(exit.trim(), 10)
  const report = ((await readText($, `${run.dir}/last.txt`)) ?? '').trim()
  if (code === 0 && report) return { status: 'done', report, code }
  const stderr = (await readText($, `${run.dir}/stderr.log`)) ?? ''
  const error =
    stderr
      .split('\n')
      .filter(l => l.trim() && !/^\d{4}-\d\d-\d\dT/.test(l) && !l.startsWith('Reading additional input'))
      .slice(-4)
      .join(' ')
      .slice(0, 600) || `codex exited ${Number.isNaN(code) ? '?' : code}`
  return { status: 'error', report, code, error }
}

const footerOf = (run: Run, card: AgentCard | undefined) => {
  const t = card?.tokens
  return (
    `[codex run ${run.id} · model ${card?.model ?? run.model ?? 'default'}${card?.effort ? ` (${card.effort})` : ''}` +
    `${run.threadId ? ` · thread ${run.threadId}` : ''}` +
    (t ? ` · in ${fmtTokens(t.input + t.cacheRead)} out ${fmtTokens(t.output)}` : '') +
    ']'
  )
}

// ---------- delivering a finished run's report ----------

const MAX_DELIVERY_TRIES = 5
const deliveries = new Map<string, { tries: number; nextAt: number; isSending: boolean }>()

/**
 * Hands a finished run's report to the model as a new turn, once. The run's folder
 * records it only after the prompt entered; a refused or failed submit is tried again
 * later (30 s, 60 s, ...), five times at most. True once nothing is left to do.
 */
const deliverReport = async ($: $T, dir: string, what: string, text: string): Promise<boolean> => {
  const d = deliveries.get(dir) ?? { tries: 0, nextAt: 0, isSending: false }
  deliveries.set(dir, d)
  if (d.isSending) return false
  if (d.tries >= MAX_DELIVERY_TRIES || (await $.fs.exists(`${dir}/delivered.txt`))) return true
  const now = await $.clock.now()
  if (now < d.nextAt) return false
  d.isSending = true
  try {
    const entered = await $.prompt.submit({ text })
    if (entered?.drop !== undefined) throw new Error(`refused: ${entered.drop}`)
    await $.fs.write(`${dir}/delivered.txt`, String(now))
    return true
  } catch (err) {
    d.tries++
    d.nextAt = now + 30_000 * d.tries
    if (d.tries < MAX_DELIVERY_TRIES) return false
    $.ui.toast(`agent-deck: gave up delivering ${what} after ${d.tries} tries (${String((err as Error)?.message ?? err).slice(0, 120)}); its result tool still reads it.`)
    return true
  } finally {
    d.isSending = false
  }
}

/** Marks a finished run on its card and hands its report to the model as a new turn. */
const finishRun = async ($: $T, run: Run, outcome: RunOutcome) => {
  run.isFinished = true
  const card = cards.get(`codex-run-${run.id}`)
  if (card && card.status === 'running') {
    card.status = outcome.status === 'done' ? 'done' : 'error'
    card.endedAt = await $.clock.now()
    card.isThinking = false
    if (outcome.error) card.error = outcome.error
    schedule($)
  }
  if (run.sessionId !== sessionId) {
    run.isDelivered = true
    return
  }
  const elapsed = fmtElapsed((card?.endedAt ?? (await $.clock.now())) - run.startedAt)
  const head =
    outcome.status === 'done'
      ? `Background Codex run ${run.id} ("${run.title}") finished after ${elapsed}. Its report:`
      : `Background Codex run ${run.id} ("${run.title}") failed after ${elapsed}: ${outcome.error ?? 'unknown error'}${outcome.report ? '\n\nIts last message:' : ''}`
  const text = `[agent-deck] ${head}\n\n${outcome.report}\n\n${footerOf(run, card)}`.trim()
  run.isDelivered = await deliverReport($, run.dir, `Codex run ${run.id}`, text)
}

let isPollingRuns = false

const pollRuns = async ($: $T) => {
  // A slow pass must not overlap the next tick.
  if (isPollingRuns) return
  isPollingRuns = true
  try {
    for (const run of runs.values()) {
      if (run.isDelivered) continue
      const outcome = await outcomeOf($, run)
      if (outcome.status !== 'running') await finishRun($, run, outcome)
    }
    if (![...runs.values()].some(r => !r.isDelivered)) {
      runPoller?.cancel()
      runPoller = undefined
    }
  } finally {
    isPollingRuns = false
  }
}

const startRunPoller = ($: $T) => {
  if (runPoller) return
  runPoller = $.clock.every(2000, () => void pollRuns($))
}

/** Picks this session's runs back up after a reload or restart: cards, and reports not yet delivered. */
const loadRuns = async ($: $T, root: string) => {
  const entries = await $.fs.list(root).catch(() => [])
  const now = await $.clock.now()
  for (const entry of entries) {
    if (entry.kind !== 'dir' || runs.has(entry.name)) continue
    const dir = `${root}/${entry.name}`
    const raw = await readText($, `${dir}/meta.json`)
    if (!raw) continue
    let meta: RunMeta
    try {
      meta = JSON.parse(raw) as RunMeta
    } catch {
      continue
    }
    if (meta.sessionId !== sessionId || now - meta.startedAt > 3 * 86_400_000) continue
    const run: Run = { ...meta, dir, isFinished: false }
    runs.set(run.id, run)
    const cardId = `codex-run-${run.id}`
    if (!cards.has(cardId)) {
      cards.set(cardId, newCodexCard(cardId, run.title, run.startedAt, { runId: run.id, model: run.model ?? codexDefaults.model ?? 'codex' }))
    }
  }
  startRunPoller($)
  startTicking($)
  await persist($)
}

const progressOf = (card: AgentCard | undefined): string => {
  if (!card) return 'No live view yet.'
  const acts = card.activity.slice(-5).map(a => `  ${a.status === 'running' ? '…' : a.status === 'error' ? '✗' : '·'} ${a.label}`)
  const last = card.output.trim().split('\n').slice(-6).join('\n')
  return [acts.length ? `Recent activity:\n${acts.join('\n')}` : '', last ? `Latest output:\n${last}` : ''].filter(Boolean).join('\n\n')
}

// ---------- other harnesses (Copilot, OpenCode, ...): agent_run ----------

const KEY_HARNESSES = 'harnesses'
const AGENT_TOOL = `mcp__${PLUGIN}__agent_run`
const AGENT_RESULT_TOOL = `mcp__${PLUGIN}__agent_result`

type HarnessRunMeta = {
  id: string
  harness: string
  name: string
  color: string
  parser: HarnessParser
  title: string
  cwd: string
  sessionId: string
  startedAt: number
  model?: string
}

type HarnessRun = HarnessRunMeta & {
  dir: string
  /** Characters of events.jsonl already read, and the unfinished line after them. */
  offset: number
  partial: string
  final: string
  isFinished: boolean
  isDelivered?: boolean
}

const hruns = new Map<string, HarnessRun>()
let harnessList: Harness[] = []
let harnessPoller: { cancel: () => void } | undefined

const harnessRunsRoot = async ($: $T): Promise<string | undefined> => {
  const home = await homeDir($)
  return home ? `${home}/.claude/agent-deck/harness-runs` : undefined
}

const harnessCardId = (runId: string) => `h-run-${runId}`

const newHarnessCard = (meta: HarnessRunMeta): AgentCard => ({
  id: harnessCardId(meta.id),
  provider: 'harness',
  harness: meta.harness,
  providerName: meta.name,
  accent: meta.color,
  title: meta.title,
  model: meta.model ?? meta.name,
  status: 'running',
  startedAt: meta.startedAt,
  output: '',
  isThinking: true,
  activity: [],
  tokens: emptyTokens(),
  runId: meta.id,
})

/** Which harness commands are on PATH. */
const detectHarnesses = async ($: $T, list: readonly Harness[]) => {
  const finder = (await isWindows($)) ? 'where' : 'which'
  const found: Record<string, boolean> = {}
  await Promise.all(
    list.map(async h => {
      const r = await $.process.run([finder, h.command], { timeoutMs: 10_000 }).catch(() => undefined)
      found[h.id] = r?.exitCode === 0
    }),
  )
  await update($, foundAtom, cur => ({ ...cur, ...found }))
  return found
}

const registerAgentTools = async ($: $T) => {
  for (const spec of [agentRunSpec(harnessList.filter(h => h.isEnabled)), AGENT_RESULT_SPEC]) {
    await $.tool.register(spec).catch(err =>
      $.ui.toast(`agent-deck: ${spec.name} tool not registered: ${String((err as Error)?.message ?? err)}`),
    )
  }
}

async function saveHarnesses($: $T, list: Harness[]) {
  harnessList = list
  await $.store.set(KEY_HARNESSES, list)
  await update($, harnessesAtom, () => list)
  await registerAgentTools($)
  void detectHarnesses($, list)
}

/** The stored harnesses; on first use, the presets whose CLI is installed. */
async function loadHarnesses($: $T) {
  const stored = await $.store.get(KEY_HARNESSES)
  if (Array.isArray(stored)) {
    harnessList = stored as Harness[]
    await update($, harnessesAtom, () => harnessList)
    await registerAgentTools($)
    void detectHarnesses($, harnessList)
    return
  }
  // Codex has its own built-in mode; Claude Code, Custom and the own-API Copilot are added by hand.
  const candidates = PRESETS.filter(p => !['custom', 'claude-cli', 'codex-cli', 'copilot-api'].includes(p.id)).map(p => fromPreset(p))
  const found = await detectHarnesses($, candidates)
  await saveHarnesses($, candidates.filter(h => found[h.id]))
}

/** Reads what a run wrote since the last look and folds it into its card. */
const readHarnessEvents = async ($: $T, run: HarnessRun, card: AgentCard, isLast: boolean) => {
  const text = (await readText($, `${run.dir}/events.jsonl`)) ?? ''
  if (text.length < run.offset) {
    run.offset = 0
    run.partial = ''
  }
  const fresh = run.partial + text.slice(run.offset)
  run.offset = text.length
  const lines = fresh.split('\n')
  run.partial = isLast ? '' : (lines.pop() ?? '')
  for (const line of lines) {
    for (const ev of parseLine(run.parser, line.replace(/\r$/, ''))) {
      if (ev.kind === 'final') run.final = ev.text
      else applyHarnessEvent(card, ev)
    }
  }
}

const harnessReport = (run: HarnessRun, card: AgentCard | undefined) =>
  (run.final || card?.output.split('\n').filter(l => !l.startsWith('∴')).slice(-40).join('\n') || '').trim()

const harnessFooter = (run: HarnessRun, card: AgentCard | undefined) => {
  const t = card?.tokens
  return (
    `[${run.name} run ${run.id} · harness ${run.harness} · model ${card?.model ?? run.model ?? 'default'}` +
    (card?.sessionRef ? ` · session ${card.sessionRef}` : '') +
    (t && t.input + t.output > 0 ? ` · in ${fmtTokens(t.input + t.cacheRead + t.cacheWrite)} out ${fmtTokens(t.output)}` : '') +
    (card?.premiumRequests ? ` · ${card.premiumRequests} premium request${card.premiumRequests === 1 ? '' : 's'}` : '') +
    ']'
  )
}

const finishHarnessRun = async ($: $T, run: HarnessRun, card: AgentCard, code: number) => {
  run.isFinished = true
  const stderr = (await readText($, `${run.dir}/stderr.log`)) ?? ''
  const isOk = code === 0 && !card.error
  if (card.status === 'running') {
    card.status = isOk ? 'done' : 'error'
    card.endedAt = await $.clock.now()
    card.isThinking = false
    if (!isOk && !card.error) {
      card.error =
        stderr
          .split('\n')
          .filter(l => l.trim())
          .slice(-4)
          .join(' ')
          .slice(0, 600) || `${run.name} exited ${Number.isNaN(code) ? '?' : code}`
    }
    schedule($)
  }
  await deliverHarnessRun($, run, card)
}

const deliverHarnessRun = async ($: $T, run: HarnessRun, card: AgentCard) => {
  if (run.sessionId !== sessionId) {
    run.isDelivered = true
    return
  }
  const isOk = card.status === 'done'
  const elapsed = fmtElapsed((card.endedAt ?? (await $.clock.now())) - run.startedAt)
  const report = harnessReport(run, card)
  const head = isOk
    ? `Background ${run.name} run ${run.id} ("${run.title}") finished after ${elapsed}. Its report:`
    : `Background ${run.name} run ${run.id} ("${run.title}") failed after ${elapsed}: ${card.error ?? 'unknown error'}${report ? '\n\nIts last output:' : ''}`
  const text = `[agent-deck] ${head}\n\n${report}\n\n${harnessFooter(run, card)}`.trim()
  run.isDelivered = await deliverReport($, run.dir, `${run.name} run ${run.id}`, text)
}

let isPollingHarness = false

const pollHarnessRuns = async ($: $T) => {
  // A slow pass must not overlap the next tick.
  if (isPollingHarness) return
  isPollingHarness = true
  try {
    for (const run of hruns.values()) {
      if (run.isDelivered) continue
      const card = cards.get(harnessCardId(run.id))
      if (!card) continue
      if (run.isFinished) {
        await deliverHarnessRun($, run, card)
        continue
      }
      const exit = await readText($, `${run.dir}/exit.txt`)
      await readHarnessEvents($, run, card, exit !== undefined)
      if (exit !== undefined) await finishHarnessRun($, run, card, Number.parseInt(exit.trim(), 10))
      schedule($)
    }
    if (![...hruns.values()].some(r => !r.isDelivered)) {
      harnessPoller?.cancel()
      harnessPoller = undefined
    }
  } finally {
    isPollingHarness = false
  }
}

const startHarnessPoller = ($: $T) => {
  if (harnessPoller) return
  harnessPoller = $.clock.every(1000, () => void pollHarnessRuns($))
}

/** Picks this session's harness runs back up after a reload: each card is rebuilt from its events file. */
const loadHarnessRuns = async ($: $T) => {
  const root = await harnessRunsRoot($)
  if (!root) return
  const entries = await $.fs.list(root).catch(() => [])
  const now = await $.clock.now()
  for (const entry of entries) {
    if (entry.kind !== 'dir' || hruns.has(entry.name)) continue
    const dir = `${root}/${entry.name}`
    let meta: HarnessRunMeta
    try {
      meta = JSON.parse((await readText($, `${dir}/meta.json`)) ?? '') as HarnessRunMeta
    } catch {
      continue
    }
    if (meta.sessionId !== sessionId || now - meta.startedAt > 3 * 86_400_000) continue
    const run: HarnessRun = { ...meta, dir, offset: 0, partial: '', final: '', isFinished: false }
    hruns.set(run.id, run)
    const old = cards.get(harnessCardId(run.id))
    cards.set(harnessCardId(run.id), { ...newHarnessCard(meta), ...(old?.status !== 'running' && old ? { status: old.status, endedAt: old.endedAt, error: old.error } : {}) })
  }
  startHarnessPoller($)
  startTicking($)
  await persist($)
}

const launchHarnessRun = async ($: $T, h: Harness, input: AgentRunInput): Promise<HarnessRun> => {
  const root = await harnessRunsRoot($)
  if (!root) throw new Error('no home directory (USERPROFILE/HOME) to keep runs in')
  if (!sessionId) sessionId = await $.session.id()
  const id = await newRunId($)
  const cwd = input.cwd ?? (await $.session.cwd())
  const model = input.model ?? h.model
  const meta: HarnessRunMeta = {
    id,
    harness: h.id,
    name: h.name,
    color: h.color,
    parser: h.parser,
    title: input.title ?? (input.resume ? `resume ${input.resume.slice(0, 8)}` : input.prompt.replace(/\s+/g, ' ').slice(0, 60)),
    cwd,
    sessionId,
    startedAt: await $.clock.now(),
    model,
  }
  const dir = `${root}/${id}`
  const argv = [h.command, ...expandArgs(h.args, { prompt: input.prompt, model, session: input.resume, cwd })]
  await $.fs.write(`${dir}/prompt.txt`, input.prompt)
  await $.fs.write(`${dir}/meta.json`, JSON.stringify(meta, null, 2))
  await $.fs.write(`${dir}/spec.json`, JSON.stringify({ argv, cwd }, null, 2))
  // The runner reads and deletes env.json before the CLI starts, so a key does not stay in the run's folder.
  const env = providerEnv(h, model)
  if (Object.keys(env).length) await $.fs.write(`${dir}/env.json`, JSON.stringify(env))
  const started = await $.process.run(['node', `${$.plugin.root}/bin/run.mjs`, dir], { timeoutMs: 20_000 })
  if (started.exitCode !== 0) throw new Error(started.stderr.trim() || `node exited ${started.exitCode} (agent_run needs Node.js on PATH)`)
  const run: HarnessRun = { ...meta, dir, offset: 0, partial: '', final: '', isFinished: false }
  hruns.set(id, run)
  await addCard($, newHarnessCard(meta))
  startHarnessPoller($)
  return run
}

/** Runs bin/models.mjs for a harness. The query can hold a key, so it goes through a file the script deletes. */
const queryModels = async ($: $T, q: ModelQuery, h: Harness): Promise<{ models: HarnessModel[] } | { error: string }> => {
  const root = await harnessRunsRoot($)
  if (!root) return { error: 'no home directory (USERPROFILE/HOME)' }
  const file = `${root}/models-${await newRunId($)}.json`
  await $.fs.write(file, JSON.stringify({ ...q, env: { ...providerEnv(h, h.model), ...q.env } }))
  const r = await $.process
    .run(['node', `${$.plugin.root}/bin/models.mjs`, file], { timeoutMs: 60_000 })
    .catch(err => ({ exitCode: 1, stdout: '', stderr: String((err as Error)?.message ?? err) }))
  return parseModels(r.stdout || r.stderr)
}

type AgentRunInput = { harness: string; prompt: string; title?: string; model?: string; cwd?: string; resume?: string }

// ---------- Copilot's premium requests, and which meters show ----------

const KEY_METERS = 'meters'
let copilotPoller: { cancel: () => void } | undefined

/** Reads Copilot's quota through the GitHub CLI; false where gh is missing, signed out or has no Copilot. */
const refreshCopilotLimits = async ($: $T): Promise<boolean> => {
  const r = await $.process.run(['gh', 'api', 'copilot_internal/user'], { timeoutMs: 20_000 }).catch(() => undefined)
  if (!r || r.exitCode !== 0) return false
  let reading: ReturnType<typeof copilotLimits>
  try {
    reading = copilotLimits(JSON.parse(r.stdout))
  } catch {
    return false
  }
  if (!reading) return false
  const { windows, plan } = reading
  await setLimits($, l => ({ ...l, copilot: windows, copilotPlan: plan }))
  return true
}

const startCopilotLimits = async ($: $T) => {
  if (copilotPoller || !(await refreshCopilotLimits($))) return
  copilotPoller = $.clock.every(5 * 60_000, () => void refreshCopilotLimits($))
}

async function loadMeters($: $T) {
  const stored = await $.store.get(KEY_METERS)
  const o = (stored && typeof stored === 'object' ? stored : {}) as Partial<MeterChoice>
  const mode = o.mode === 'session' || o.mode === 'selected' ? o.mode : 'all'
  const selected = Array.isArray(o.selected) ? o.selected.filter(x => ['claude', 'codex', 'copilot'].includes(x)) : DEFAULT_METERS.selected
  await update($, metersAtom, () => ({ mode, selected }))
}

async function saveMeters($: $T, choice: MeterChoice) {
  await $.store.set(KEY_METERS, choice)
  await update($, metersAtom, () => choice)
}

// ---------- the built-in Codex: on or off ----------

const KEY_CODEX = 'codex-enabled'
let codexOn = false

const registerCodexTools = async ($: $T) => {
  for (const spec of [CODEX_TOOL_SPEC, CODEX_RESULT_SPEC]) {
    await $.tool.register(spec).catch(err =>
      $.ui.toast(`agent-deck: ${spec.name} tool not registered: ${String((err as Error)?.message ?? err)}`),
    )
  }
}

/** Starts the live view of Codex's own session files: every Codex run, and its usage limits. */
const startCodexWatcher = async ($: $T) => {
  const home = await codexHome($)
  const root = await runsRoot($)
  if (!home || !root) return
  const since = (await $.clock.now()) - 30 * 60_000
  startWatcher($, [`${home}/sessions`, root, await $.session.cwd(), String(since)])
}

/** The stored switch; on first use, on when `codex` is on PATH. */
async function loadCodexEnabled($: $T) {
  const stored = await $.store.get(KEY_CODEX)
  const r = await $.process.run([(await isWindows($)) ? 'where' : 'which', 'codex'], { timeoutMs: 10_000 }).catch(() => undefined)
  const isFound = r?.exitCode === 0
  await update($, foundAtom, cur => ({ ...cur, codex: isFound }))
  codexOn = typeof stored === 'boolean' ? stored : isFound
  await update($, codexAtom, () => codexOn)
}

async function setCodexEnabled($: $T, on: boolean) {
  codexOn = on
  await $.store.set(KEY_CODEX, on)
  await update($, codexAtom, () => on)
  if (on) {
    await registerCodexTools($)
    await startCodexWatcher($)
  } else {
    stopWatcher()
    await setLimits($, l => ({ ...l, codex: [], codexPlan: undefined }))
  }
}

// ---------- Strata (the local model): one live card per request, read from its API monitor ----------

const STRATA_URL = 'http://127.0.0.1:8080'
const STRATA_ACCENT = '#8B5CF6'
let strataTimer: { cancel: () => void } | undefined
let isStrataPolling = false
let strataTicks = 0
let isStrataMonitorOff = false
let strataSince = 0

export type StrataRecord = {
  id: string
  path?: string
  model?: string
  started_at?: number
  finished_at?: number
  state?: string
  error?: unknown
  usage?: Record<string, number>
  input?: string
  output?: string
  reasoning?: string
}

const STRATA_API: Record<string, string> = {
  '/v1/messages': 'Anthropic API',
  '/v1/chat/completions': 'OpenAI API',
  '/v1/responses': 'Responses API',
  '/v1/completions': 'Completions API',
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => {
      const block = b as { type?: string; text?: unknown }
      return block && (block.type === 'text' || block.type === 'input_text') ? String(block.text ?? '') : ''
    })
    .join('\n')
}

/** The last thing the user asked in a request body (reminder tags dropped), for the card's title. */
export const strataTitle = (input: string | undefined): string => {
  let req: { messages?: { role?: string; content?: unknown }[]; input?: unknown; prompt?: unknown } = {}
  try {
    req = JSON.parse(input ?? '{}')
  } catch {}
  const asked = [
    ...(req.messages ?? []).filter(m => m.role === 'user').map(m => textOf(m.content)),
    Array.isArray(req.input)
      ? (req.input as { role?: string; content?: unknown }[]).filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n')
      : textOf(req.input),
    textOf(req.prompt),
  ]
    .map(t => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim())
    .filter(Boolean)
  const last = asked.pop()
  return last ? last.split('\n')[0]!.slice(0, 70) : 'Strata request'
}

export const strataTokens = (u: Record<string, number> | undefined): Tokens => ({
  input: u?.input_tokens ?? u?.prompt_tokens ?? 0,
  output: u?.output_tokens ?? u?.completion_tokens ?? 0,
  cacheRead: u?.cache_read_input_tokens ?? 0,
  cacheWrite: 0,
  reasoning: 0,
})

export const newStrataCard = (r: StrataRecord): AgentCard => ({
  id: `strata-${r.id}`,
  provider: 'strata',
  title: strataTitle(r.input),
  model: [r.model ?? 'strata', STRATA_API[r.path ?? ''] ?? r.path].filter(Boolean).join(' · '),
  status: 'running',
  startedAt: Math.round((r.started_at ?? 0) * 1000),
  output: '',
  isThinking: true,
  activity: [],
  tokens: emptyTokens(),
})

/** Folds Strata's record of a request (its output so far) into the card. */
export const applyStrataRecord = (card: AgentCard, r: StrataRecord) => {
  const isDone = r.finished_at !== undefined
  const reasoning = (r.reasoning ?? '').trim()
  const thought = reasoning ? `${reasoning.split('\n').slice(-12).map(l => `∴ ${l}`).join('\n')}\n` : ''
  card.output = (thought + (r.output ?? '')).slice(-MAX_OUTPUT)
  card.isThinking = !isDone && !r.output
  if (r.usage) card.tokens = strataTokens(r.usage)
  card.status = !isDone ? 'running' : r.state === 'error' ? 'error' : r.state === 'disconnected' ? 'aborted' : 'done'
  card.endedAt = isDone ? Math.round(r.finished_at! * 1000) : undefined
  const phase = r.state === 'generating' && !r.output && !reasoning ? 'reading the prompt' : r.state
  card.activity = !isDone && phase ? [{ id: 'state', label: phase, status: 'running' }] : []
  if (r.error) card.error = (typeof r.error === 'string' ? r.error : JSON.stringify(r.error)).slice(0, 300)
}

const fetchStrata = async ($: $T, path: string): Promise<{ status: number; body?: unknown }> => {
  try {
    const res = await $.http.fetch(`${STRATA_URL}${path}`)
    return { status: res.status, body: res.ok ? JSON.parse(res.text) : undefined }
  } catch {
    return { status: 0 }
  }
}

const pollStrata = async ($: $T) => {
  if (isStrataPolling) return
  const isLive = [...cards.values()].some(c => c.provider === 'strata' && c.status === 'running')
  strataTicks++
  if (strataTicks % (isStrataMonitorOff ? 30 : isLive ? 1 : 3) !== 0) return
  isStrataPolling = true
  try {
    const list = await fetchStrata($, '/api/requests')
    if (list.status === 404) {
      if (!isStrataMonitorOff) $.ui.log('agent-deck: Strata runs but its API monitor is off ("api_monitor": true in strata-<model>.json)', { to: 'debug' })
      isStrataMonitorOff = true
      return
    }
    if (list.status !== 200) return
    isStrataMonitorOff = false
    const records = ((list.body as { requests?: StrataRecord[] })?.requests ?? []).filter(
      r => (r.started_at ?? 0) * 1000 >= strataSince,
    )
    let isChanged = false
    for (const summary of records.slice(0, MAX_CARDS).reverse()) {
      const id = `strata-${summary.id}`
      const card = cards.get(id)
      if (card && card.status !== 'running') continue
      const detail = await fetchStrata($, `/api/requests?id=${encodeURIComponent(summary.id)}`)
      if (detail.status !== 200) continue
      const record = detail.body as StrataRecord
      const target = card ?? newStrataCard(record)
      const before = `${target.status}|${target.output.length}`
      applyStrataRecord(target, record)
      if (!card) {
        await addCard($, target)
        $.ui.log(`agent-deck: Strata card ${id} opened: ${target.title}`, { to: 'debug' })
      } else if (`${target.status}|${target.output.length}` !== before) {
        isChanged = true
        $.ui.log(`agent-deck: Strata card ${id} ${target.status}, ${target.output.length} chars`, { to: 'debug' })
      }
      if (target.status === 'running') startTicking($)
    }
    if (isChanged) schedule($)
  } finally {
    isStrataPolling = false
  }
}

// ---------- the module ----------

export const register: Register = on => {
  // ---- the main conversation's prompt cache ----

  registerCache(on)

  // ---- session ----

  on('session.start', async ($, e, next) => {
    // Registered before next(e) so the tools are listed from the first turn.
    await loadCodexEnabled($).catch(() => undefined)
    if (codexOn) await registerCodexTools($)
    await loadHarnesses($).catch(err => $.ui.toast(`agent-deck: harnesses not loaded: ${String((err as Error)?.message ?? err)}`))
    const started = await next(e)
    sessionId = await $.session.id()
    for (const c of await read($, agents)) {
      // Claude subagents can't outlive a reload; Codex runs are re-read from disk below.
      const isStale = c.status === 'running' && c.provider === 'claude'
      cards.set(c.id, isStale ? { ...c, status: 'aborted' } : c)
      if (c.threadId) threadToCard.set(c.threadId, c.id)
    }
    await $.command.register({ name: 'agent-deck', description: 'Open the Agents pane (Codex, Claude subagents and other harnesses)' })
    const home = await codexHome($)
    if (home) {
      const toml = await readText($, `${home}/config.toml`)
      if (toml) codexDefaults = parseCodexConfig(toml)
    }
    const root = await runsRoot($)
    if (root) await loadRuns($, root)
    await loadHarnessRuns($)
    if (codexOn) await startCodexWatcher($)
    void refreshClaudeLimits($)
    poller = $.clock.every(60_000, () => void refreshClaudeLimits($))
    await loadMeters($).catch(() => undefined)
    void startCopilotLimits($)
    openPane($)
    strataSince = (await $.clock.now()) - 5000
    strataTimer = $.clock.every(1000, () => void pollStrata($))
    await cacheSessionStart($)
    // Redraws the cache countdown while nothing else ticks.
    cacheTicker = $.clock.every(30_000, () => {
      if (!ticker) void update($, tick, n => n + 1)
    })
    return started
  })

  on('session.end', async ($, e, next) => {
    cacheTicker?.cancel()
    cacheSessionEnd()
    strataTimer?.cancel()
    poller?.cancel()
    ticker?.cancel()
    runPoller?.cancel()
    harnessPoller?.cancel()
    copilotPoller?.cancel()
    copilotPoller = undefined
    return next(e)
  })

  on('command.run', { command: 'agent-deck' }, async $ => {
    await $.ui.open({ id: PANE, title: await paneTitle($) })
    return { text: 'Agent Deck pane opened.' }
  }).catch(() => ({ text: 'agent-deck: could not open the pane.' }))

  on('turn.complete', async ($, e, next) => {
    const card = e.agentId ? cards.get(e.agentId) : undefined
    if (card && card.status === 'running') {
      card.status = e.isAborted ? 'aborted' : e.reason === 'error' ? 'error' : 'done'
      card.endedAt = await $.clock.now()
      card.isThinking = false
      schedule($)
    }
    if (e.agentId) return next(e)
    void refreshClaudeLimits($)
    const done = await next(e)
    await cacheAfterTurn($, e)
    return done
  })

  // ---- Claude subagents ----

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId) {
      await addCard($, {
        id: spawned.agentId,
        provider: 'claude',
        title: `${e.subagentType} · ${e.description}`,
        model: spawned.model,
        status: 'running',
        startedAt: await $.clock.now(),
        output: '',
        isThinking: false,
        activity: [],
        tokens: emptyTokens(),
      })
    }
    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) await cacheBeforeStep($, e)
    const card = e.agentId ? cards.get(e.agentId) : undefined
    if (!card) return yield* next(e)

    card.model = e.model
    if (e.effort !== undefined) card.effort = String(e.effort)
    if (card.output && !card.output.endsWith('\n')) appendOutput(card, '\n')
    schedule($)

    const stream = next(e)
    while (true) {
      const step = await stream.next()
      if (step.done) return step.value
      const c = step.value
      if (c.kind === 'text') {
        card.isThinking = false
        appendOutput(card, c.text)
      } else if (c.kind === 'thinking') {
        card.isThinking = true
      } else if (c.kind === 'tool') {
        card.isThinking = false
        card.activity = [...card.activity, { id: c.id, label: c.name, status: 'running' as const }].slice(-30)
      } else if (c.kind === 'stop' && c.usage) {
        const u = c.usage
        const t = card.tokens
        t.input += u.input_tokens
        t.output += u.output_tokens
        t.cacheRead += u.cache_read_input_tokens
        t.cacheWrite += u.cache_creation_input_tokens
        const cost = costOf(u.model, {
          input: u.input_tokens,
          output: u.output_tokens,
          cacheRead: u.cache_read_input_tokens,
          cacheWrite: u.cache_creation_input_tokens,
        })
        if (cost !== undefined) card.costUsd = (card.costUsd ?? 0) + cost
        card.model = u.model
      }
      schedule($)
      yield c
    }
  })

  on('tool.call', async ($, e, next) => {
    const card = e.agentId ? cards.get(e.agentId) : undefined
    if (!card || [TOOL, RESULT_TOOL, AGENT_TOOL, AGENT_RESULT_TOOL].includes(e.tool)) return next(e)
    const mark = (status: Activity['status'], label?: string) => {
      card.activity = card.activity.map(a =>
        a.id === e.tool_use_id ? { ...a, status, label: label ?? a.label } : a,
      )
      schedule($)
    }
    mark('running', summarizeInput(e.tool, e as unknown as Record<string, unknown>))
    const ran = await next(e)
    mark(ran.deny !== undefined || ran.isError ? 'error' : 'done')
    return ran
  }).catch(($, e, next) => next(e))

  // ---- Codex ----

  on('tool.call', { tool: 'mcp__agent-deck__codex' }, async ($, e) => {
    if (!codexOn) return { deny: 'agent-deck: the built-in Codex is switched off under ⚙ Harnesses in the Agents pane.' }
    const input = e as unknown as {
      prompt: string
      title?: string
      model?: string
      effort?: string
      sandbox?: string
      cwd?: string
      resume?: string
    }
    const root = await runsRoot($)
    if (!root) return { deny: 'agent-deck: no home directory (USERPROFILE/HOME) to keep Codex runs in.' }
    if (!sessionId) sessionId = await $.session.id()

    const id = await newRunId($)
    const meta: RunMeta = {
      id,
      title: input.title ?? (input.resume ? `resume ${input.resume.slice(0, 8)}` : input.prompt.replace(/\s+/g, ' ').slice(0, 60)),
      cwd: input.cwd ?? (await $.session.cwd()),
      sessionId,
      startedAt: await $.clock.now(),
      model: input.model,
      effort: input.effort,
      sandbox: input.sandbox,
      resume: input.resume,
    }
    const run: Run = { ...meta, dir: `${root}/${id}`, threadId: input.resume, isFinished: false }

    await launchRun($, meta, input.prompt, run.dir)
    runs.set(id, run)
    await addCard(
      $,
      newCodexCard(`codex-run-${id}`, meta.title, meta.startedAt, {
        runId: id,
        model: input.model ?? codexDefaults.model ?? 'codex',
        effort: input.effort ?? codexDefaults.effort,
      }),
    )
    startRunPoller($)

    return {
      result:
        `Codex run ${id} started in the background (model ${input.model ?? codexDefaults.model ?? 'default'}). ` +
        `Its report will arrive as a new message when it finishes; don't wait or poll for it. ` +
        `Continue with other work, or end your turn if there is nothing else to do. codex_result with id "${id}" shows its progress.`,
    }
  }).catch(($, e, next) => ({ deny: `agent-deck: could not start Codex: ${String(next.error?.message ?? 'unknown error')}` }))

  on('tool.call', { tool: 'mcp__agent-deck__codex_result' }, async ($, e) => {
    const { id } = e as unknown as { id?: string }
    if (!id) {
      const mine = [...runs.values()].filter(r => r.sessionId === sessionId)
      if (mine.length === 0) return { result: 'No Codex runs in this session.' }
      const lines = await Promise.all(
        mine.map(async r => `${r.id} · ${(await outcomeOf($, r)).status} · ${r.title}`),
      )
      return { result: lines.join('\n') }
    }
    const run = runs.get(id)
    if (!run) return { result: `No Codex run with id ${id} in this session.` }
    const outcome = await outcomeOf($, run)
    const card = cards.get(`codex-run-${id}`)
    if (outcome.status === 'running') {
      const elapsed = fmtElapsed((await $.clock.now()) - run.startedAt)
      return { result: `Codex run ${id} is still running (${elapsed}).\n\n${progressOf(card)}\n\n${footerOf(run, card)}` }
    }
    if (!run.isFinished) await finishRun($, run, outcome)
    const head = outcome.status === 'done' ? `Codex run ${id} finished. Report:` : `Codex run ${id} failed: ${outcome.error ?? ''}`
    return { result: `${head}\n\n${outcome.report}\n\n${footerOf(run, card)}` }
  }).catch(() => ({ deny: 'agent-deck: could not read that Codex run.' }))

  // ---- other harnesses ----

  on('tool.call', { tool: 'mcp__agent-deck__agent_run' }, async ($, e) => {
    const input = e as unknown as AgentRunInput
    const h = harnessList.find(x => x.id === input.harness)
    if (!h) {
      const ids = harnessList.filter(x => x.isEnabled).map(x => x.id)
      return { deny: `agent-deck: no harness "${input.harness}". ${ids.length ? `Enabled: ${ids.join(', ')}.` : 'None is enabled: add one under ⚙ Harnesses in the Agents pane.'}` }
    }
    if (!h.isEnabled) return { deny: `agent-deck: the ${h.name} harness is switched off in the Agents pane.` }
    const run = await launchHarnessRun($, h, input)
    return {
      result:
        `${h.name} run ${run.id} started in the background (model ${run.model ?? 'default'}). ` +
        `Its report will arrive as a new message when it finishes; don't wait or poll for it. ` +
        `Continue with other work, or end your turn if there is nothing else to do. agent_result with id "${run.id}" shows its progress.`,
    }
  }).catch(($, e, next) => ({ deny: `agent-deck: could not start the run: ${String(next.error?.message ?? 'unknown error')}` }))

  on('tool.call', { tool: 'mcp__agent-deck__agent_result' }, async ($, e) => {
    const { id } = e as unknown as { id?: string }
    if (!id) {
      const mine = [...hruns.values()].filter(r => r.sessionId === sessionId)
      if (mine.length === 0) return { result: 'No agent_run runs in this session.' }
      return {
        result: mine.map(r => `${r.id} · ${r.name} · ${cards.get(harnessCardId(r.id))?.status ?? 'unknown'} · ${r.title}`).join('\n'),
      }
    }
    const run = hruns.get(id)
    if (!run) return { result: `No agent_run with id ${id} in this session.` }
    const card = cards.get(harnessCardId(id))
    if (!run.isFinished) {
      const elapsed = fmtElapsed((await $.clock.now()) - run.startedAt)
      return { result: `${run.name} run ${id} is still running (${elapsed}).\n\n${progressOf(card)}\n\n${harnessFooter(run, card)}` }
    }
    const head = card?.status === 'done' ? `${run.name} run ${id} finished. Report:` : `${run.name} run ${id} failed: ${card?.error ?? ''}`
    return { result: `${head}\n\n${harnessReport(run, card)}\n\n${harnessFooter(run, card)}` }
  }).catch(() => ({ deny: 'agent-deck: could not read that run.' }))

  // ---- the band above the prompt: opens the pane, shows the cache ----

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, agents)
    const n = await read($, tick)
    const cache = await read($, cacheAtom)
    const cv = cacheView(cache, await $.clock.now())
    const running = list.filter(c => c.status === 'running')
    const codex = running.filter(c => c.provider === 'codex').length
    const strata = running.filter(c => c.provider === 'strata').length
    const others = new Map<string, number>()
    for (const c of running) if (c.provider === 'harness') others.set(c.providerName ?? 'agent', (others.get(c.providerName ?? 'agent') ?? 0) + 1)
    const claude = running.filter(c => c.provider === 'claude').length
    const parts = [
      codex ? `${codex} Codex` : '',
      claude ? `${claude} Claude` : '',
      strata ? `${strata} Strata` : '',
      ...[...others].map(([name, count]) => `${count} ${name}`),
    ].filter(Boolean)
    const hasCache = cv.tone !== 'unknown' || cv.keepwarm !== undefined
    const held = cache.held
    const heldPreview = held ? held.text.replace(/\s+/g, ' ').trim() : ''
    const heldRow = held && (
      <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
        <Text color="warning" wrap="truncate-end">
          ⚠ Held: “{heldPreview.length > 40 ? `${heldPreview.slice(0, 40)}…` : heldPreview}” · cold cache, {fmtUsd(held.usd)} to re-write
        </Text>
        <Button key="held-send" label="Send anyway" variant="primary" onPress={() => void sendHeld($)} />
        <Button key="held-discard" label="Discard" onPress={() => void discardHeld($)} />
      </Box>
    )
    const band = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="agent-deck-open" label="Agents" plain onPress={() => openPane($)} />
        {running.length > 0 ? (
          <Text color={CODEX_ACCENT}>
            {SPIN[n % SPIN.length]} {parts.join(' · ')} running
          </Text>
        ) : (
          <Text dimColor>no agents running</Text>
        )}
        {hasCache && <Text dimColor>│</Text>}
        {hasCache && (
          <Text>
            <Text dimColor>cache </Text>
            <Text bold color={toneColor(cv.tone)}>
              ● {cv.tone}
            </Text>
            {cv.tone === 'warm' && <Text dimColor> {fmtDuration(cv.leftMs)}</Text>}
          </Text>
        )}
        {cv.keepwarm && <Text color="success">♨ {fmtDuration(cv.keepwarm.leftMs)}</Text>}
      </Box>
    )
    const sending = cache.sending
    const sendingPreview = sending ? sending.text.replace(/\s+/g, ' ').trim() : ''
    const sendingRow = sending && !held && (
      <Text color="success" wrap="truncate-end">
        ✓ Sent “{sendingPreview.length > 40 ? `${sendingPreview.slice(0, 40)}…` : sendingPreview}” · re-writing {fmtTok(sending.tokens)} tokens of
        cache first, so the reply can take a minute
      </Text>
    )
    if (!heldRow && !sendingRow) return band
    return (
      <Box flexDirection="column">
        {heldRow}
        {sendingRow}
        {band}
      </Box>
    )
  })

  // ---- the pane ----

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // Mobile draws no Select yet: it keeps the buttons.
    const Select = e.surface !== 'mobile' && 'Select' in ui ? ui.Select : undefined
    const list = await read($, agents)
    const lim = await read($, limits)
    const cache = await read($, cacheAtom)
    const open = new Set(await read($, expanded))
    const n = await read($, tick)
    const now = await $.clock.now()
    const view = await read($, viewAtom)
    const hs = await read($, harnessesAtom)
    const found = await read($, foundAtom)
    const isCodexOn = await read($, codexAtom)
    const meters = await read($, metersAtom)
    const Input = e.surface !== 'mobile' && 'Input' in ui ? ui.Input : undefined
    // Surfaces that draw SVG get thick bars; the terminal keeps its text meters.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
    // The body's own width: the viewport is the whole window, wider than a docked pane.
    const cols = Math.max(24, e.props.bodyColumns || e.viewport?.columns || 60)
    // Outside the terminal the font is proportional and '━' draws about two columns wide.
    const glyph = e.surface === 'terminal' ? 1 : 2
    const meterWidth = Math.max(4, Math.min(10, Math.floor((cols - 22) / glyph)))
    const spinner = SPIN[n % SPIN.length]

    const meter = (key: string, percent: number, color: string) => {
      const filled = filledCells(percent, meterWidth)
      return (
        <Text key={key}>
          <Text color={color}>{'━'.repeat(filled)}</Text>
          <Text dimColor>{'━'.repeat(meterWidth - filled)}</Text>
        </Text>
      )
    }

    // ---- rate limits: a provider's windows side by side when they surely fit, else one per row ----

    const windowCols = 2 + 1 + meterWidth * glyph + 1 + 5 + 1 + 4
    const maxWindows = Math.max(1, lim.codex.length, lim.claude.length)
    const isSideBySide = glyph === 1 && cols >= 7 + maxWindows * windowCols + (maxWindows - 1) * 2 + 2

    const limitWindow = (name: string, w: LimitWindow) => (
      <Box key={`${name}-${w.label}`} flexDirection="row" gap={1} flexShrink={0}>
        <Box width={2} flexShrink={0}>
          <Text dimColor>{w.label}</Text>
        </Box>
        {meter(`${name}-${w.label}-m`, w.percent, limitColor(w.percent))}
        <Box width={5} flexShrink={0} justifyContent="flex-end">
          <Text bold tabular color={limitColor(w.percent)}>
            {`${Math.round(w.percent)}%`}
          </Text>
        </Box>
        {w.resetsAt !== undefined && <Text dimColor>{`↻${fmtReset(w.resetsAt, now)}`}</Text>}
      </Box>
    )

    // A fixed-width name column keeps the meters aligned in a proportional font too.
    const nameCell = (name: string, color: string, isShown: boolean) => (
      <Box width={7} flexShrink={0}>
        {isShown && (
          <Text bold color={color}>
            {name}
          </Text>
        )}
      </Box>
    )

    const bar = (key: string, percent: number, fill: string) =>
      Svg && <Svg key={key} source={barSvg(percent, fill)} alt={`${Math.round(percent)}% used`} height={6} />

    const limitBars = (name: string, color: string, ws: LimitWindow[], extra?: string) => (
      <Box key={`lim-${name}`} flexDirection="column" marginBottom={1}>
        <Text>
          <Text bold color={color}>
            {name}
          </Text>
          {extra && <Text dimColor> · {extra}</Text>}
        </Text>
        {ws.length === 0 && <Text dimColor>no reading yet</Text>}
        {ws.map(w => (
          <Box key={`${name}-${w.label}`} flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
              <Text>{windowName(w.label)}</Text>
              <Box flexDirection="row" columnGap={1} flexShrink={0}>
                {w.resetsAt !== undefined && <Text dimColor>resets in {fmtReset(w.resetsAt, now)}</Text>}
                <Text bold tabular color={limitColor(w.percent)}>
                  {`${Math.round(w.percent)}%`}
                </Text>
              </Box>
            </Box>
            {bar(`${name}-${w.label}-bar`, w.percent, SVG_COLORS[limitColor(w.percent)])}
          </Box>
        ))}
      </Box>
    )

    const limitRow = (name: string, color: string, ws: LimitWindow[], extra?: string) =>
      Svg ? limitBars(name, color, ws, extra) : limitText(name, color, ws, extra)

    const limitText = (name: string, color: string, ws: LimitWindow[], extra?: string) =>
      isSideBySide || ws.length === 0 ? (
        <Box key={`lim-${name}`} flexDirection="row" columnGap={2}>
          {nameCell(name, color, true)}
          {ws.length === 0 && <Text dimColor>no reading yet</Text>}
          {ws.map(w => limitWindow(name, w))}
          {extra && <Text dimColor>{extra}</Text>}
        </Box>
      ) : (
        <Box key={`lim-${name}`} flexDirection="column">
          {ws.map((w, i) => (
            <Box key={`${name}-row-${w.label}`} flexDirection="row" columnGap={1}>
              {nameCell(name, color, i === 0)}
              {limitWindow(name, w)}
              {i === ws.length - 1 && extra && <Text dimColor>{extra}</Text>}
            </Box>
          ))}
        </Box>
      )

    // ---- the main conversation's prompt cache ----

    const cv = cacheView(cache, now)
    const tone = toneColor(cv.tone)
    const kw = cv.keepwarm
    const cacheBox = (
      <Box
        key="cache"
        flexDirection="column"
        borderStyle="round"
        borderColor={cv.tone === 'cold' ? 'error' : kw ? 'success' : 'subtle'}
        paddingX={1}
      >
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Text bold>Prompt cache</Text>
            <Text bold color={tone} dimColor={cv.tone === 'unknown'} wrap="truncate-end">
              ● {cv.label}
            </Text>
          </Box>
          {cv.tone === 'warm' && !Svg && <Box flexShrink={0}>{meter('ttl', cv.ttlPercent, 'success')}</Box>}
        </Box>
        {cv.tone === 'warm' && bar('ttl-bar', cv.ttlPercent, SVG_COLORS.success)}
        {cv.tone === 'unknown' && (
          <Text dimColor wrap="wrap">
            {cache.isReset
              ? 'Compacted, cleared or switched model: the next turn writes a fresh cache.'
              : 'Shows once this session has sent a request.'}
          </Text>
        )}
        {cache.ctx > 0 && (
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            <Text>
              <Text dimColor>context </Text>
              <Text bold>{fmtTokens(cache.ctx)}</Text>
            </Text>
            <Text>
              <Text dimColor>cold re-write </Text>
              <Text bold color={cv.tone === 'cold' ? 'error' : 'warning'}>
                {fmtUsd(cv.coldUsd)}
              </Text>
            </Text>
            <Text>
              <Text dimColor>warm turn </Text>
              <Text bold color="success">
                {fmtUsd(cv.warmUsd)}
              </Text>
            </Text>
          </Box>
        )}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1} flexWrap="wrap">
          <Box flexShrink={1} minWidth={0}>
            {kw ? (
              <Text wrap="wrap">
                <Text bold color="success">
                  ♨ keep-warm {fmtDuration(kw.leftMs)}
                </Text>
                <Text dimColor> · {kw.next}</Text>
              </Text>
            ) : (
              <Text dimColor wrap="wrap">
                keep-warm off
              </Text>
            )}
          </Box>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            {Select ? (
              <Select
                key="kw-window"
                label="Keep warm"
                options={KEEPWARM_OPTIONS}
                value={keepWarmValue(kw?.leftMs)}
                onSelect={v => void pickKeepWarm($, v)}
              />
            ) : kw ? (
              <Button key="kw-stop" label="Stop" onPress={() => void stopKeepWarm($)} />
            ) : (
              <Button key="kw-2h" label="Keep warm 2h" variant="primary" onPress={() => void startKeepWarm($, DEFAULT_WINDOW_MS)} />
            )}
            {!Select && !kw && <Button key="kw-6h" label="6h" onPress={() => void startKeepWarm($, 6 * 3_600_000)} />}
          </Box>
        </Box>
        {cache.stopped && (
          <Text color="warning" wrap="wrap">
            keep-warm stopped: {cache.stopped}
          </Text>
        )}
        {(cache.pings > 0 || cache.coldWrites.length > 0) && (
          <Text dimColor wrap="wrap">
            {[
              cache.pings ? `${cache.pings} ping${cache.pings === 1 ? '' : 's'} ${fmtUsd(cache.pingUsd)}` : '',
              cache.lastPing ? `last read ${fmtTokens(cache.lastPing.read)}` : '',
              cache.coldWrites.length ? `${cache.coldWrites.length} cold write${cache.coldWrites.length === 1 ? '' : 's'} ${fmtUsd(cv.paid)}` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        )}
      </Box>
    )

    // ---- agent cards ----

    const toggle = (id: string) =>
      update($, expanded, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))

    const stat = (key: string, label: string, value: string, color?: string) => (
      <Text key={key}>
        <Text dimColor>{label} </Text>
        <Text bold color={color}>
          {value}
        </Text>
      </Text>
    )

    const card = (c: AgentCard) => {
      const accent = c.accent ?? (c.provider === 'codex' ? CODEX_ACCENT : c.provider === 'strata' ? STRATA_ACCENT : 'claude')
      const isRunning = c.status === 'running'
      const isOpen = isRunning || open.has(c.id)
      const elapsed = fmtElapsed((c.endedAt ?? now) - c.startedAt)
      const glyph = isRunning ? spinner : c.status === 'done' ? '✓' : c.status === 'aborted' ? '■' : '✗'
      const glyphColor = isRunning ? accent : c.status === 'done' ? 'success' : c.status === 'aborted' ? 'warning' : 'error'
      const provider = (c.providerName ?? c.provider).toUpperCase()
      const fullTitle = `${c.title}${c.isExternal ? ' (outside tool)' : ''}`
      // A collapsed row cuts its title to fit before the surface lays it out, so it never pushes past the frame;
      // an open card gives the title a wrapping line of its own.
      const room = cols - provider.length - elapsed.length - 12
      const title = isOpen ? '' : clip(fullTitle, Math.max(8, room))

      const header = (
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Text color={glyphColor}>{glyph}</Text>
            <Text bold color={accent}>
              {provider}
            </Text>
            {title && (
              <Text bold wrap="truncate-end">
                {title}
              </Text>
            )}
          </Box>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <Text dimColor tabular>
              {elapsed}
            </Text>
            {!isRunning && <Button key={`t-${c.id}`} label={isOpen ? '▾' : '▸'} plain onPress={() => toggle(c.id)} />}
          </Box>
        </Box>
      )

      if (!isOpen) {
        return (
          <Box key={c.id} flexDirection="column" paddingX={1}>
            {header}
          </Box>
        )
      }

      const t = c.tokens
      const hit = cacheHitPercent(t)
      const modelRow = (
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          <Text bold color={accent}>
            ◆ {c.model}
          </Text>
          {c.effort && (
            <Text bold inverse color={accent}>
              {` ${c.effort} `}
            </Text>
          )}
        </Box>
      )
      const statsRow = (
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          {stat('in', 'in', fmtTokens(t.input + t.cacheRead + t.cacheWrite))}
          {stat('out', 'out', fmtTokens(t.output))}
          {hit !== undefined && stat('hit', 'cache', `${Math.round(hit)}%`, hit >= 50 ? 'success' : 'warning')}
          {c.costUsd !== undefined && stat('cost', '≈', fmtUsd(c.costUsd))}
          {c.premiumRequests !== undefined && stat('prem', 'premium', String(c.premiumRequests))}
        </Box>
      )

      const lines = c.output.split('\n').filter(l => l.trim() !== '')
      const tail = lines.slice(isRunning ? -8 : -14)
      const acts = c.activity.slice(-5)
      return (
        <Box key={c.id} flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
          {header}
          <Text bold wrap="wrap">
            {fullTitle}
          </Text>
          {modelRow}
          {statsRow}
          {acts.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {acts.map(a => (
                <Text
                  key={`${c.id}-${a.id}`}
                  mono
                  wrap="truncate-end"
                  color={a.status === 'error' ? 'error' : undefined}
                  dimColor={a.status === 'done'}
                >
                  {a.status === 'running' ? spinner : a.status === 'done' ? '·' : '✗'} {a.label}
                </Text>
              ))}
            </Box>
          )}
          {tail.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {tail.map((l, i) => (
                <Text key={`${c.id}-o${i}`} dimColor={l.startsWith('∴')} italic={l.startsWith('∴')} wrap="wrap">
                  {l}
                </Text>
              ))}
            </Box>
          )}
          {isRunning && c.isThinking && (
            <Text dimColor italic>
              {spinner} thinking…
            </Text>
          )}
          {c.error && (
            <Text color="error" wrap="wrap">
              {c.error}
            </Text>
          )}
          {c.provider === 'harness' && (
            <Text dimColor wrap="truncate-end">
              {[`run ${c.runId}`, c.sessionRef ? `session ${c.sessionRef}` : ''].filter(Boolean).join(' · ')}
            </Text>
          )}
          {c.provider === 'codex' && (c.runId || c.threadId) && (
            <Text dimColor wrap="truncate-end">
              {[c.runId ? `run ${c.runId}` : '', c.threadId ? `thread ${c.threadId}` : ''].filter(Boolean).join(' · ')}
            </Text>
          )}
        </Box>
      )
    }

    // ---- harnesses: the list, and the form that adds or edits one ----

    const setView = (v: HarnessView) => update($, viewAtom, () => v)
    const patchDraft = (fn: (d: Harness) => Harness) =>
      update($, viewAtom, cur => (cur.mode === 'edit' ? { ...cur, draft: fn(cur.draft), error: undefined } : cur))
    const parserLabel = (p: HarnessParser) => PARSERS.find(x => x.value === p)?.label ?? p
    const showArgs = (words: string[]) => words.map(w => (/\s/.test(w) || !w ? `"${w}"` : w)).join(' ')

    const harnessRow = (hr: Harness) => (
      <Box key={`h-${hr.id}`} flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
        <Box flexDirection="column" flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end">
            <Text bold color={hr.color}>
              ● {hr.name}
            </Text>
            <Text dimColor> {hr.id}</Text>
          </Text>
          <Text dimColor wrap="truncate-end">
            {[hr.command, parserLabel(hr.parser), hr.model ?? '', hr.provider ? `API ${hr.provider.baseUrl}` : ''].filter(Boolean).join(' · ')}
          </Text>
          {found[hr.id] === false && <Text color="warning">{hr.command} is not on PATH</Text>}
        </Box>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          <Button
            key={`h-toggle-${hr.id}`}
            label={hr.isEnabled ? 'On' : 'Off'}
            variant={hr.isEnabled ? 'primary' : undefined}
            onPress={() => void saveHarnesses($, hs.map(x => (x.id === hr.id ? { ...x, isEnabled: !x.isEnabled } : x)))}
          />
          {Input && <Button key={`h-edit-${hr.id}`} label="Edit" onPress={() => void openEdit({ ...hr }, hr.id)} />}
        </Box>
      </Box>
    )

    const listView = () => (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold>Harnesses</Text>
          <Button key="h-done" label="Done" onPress={() => void setView({ mode: 'cards' })} />
        </Box>
        <Text dimColor wrap="wrap">
          Coding agents Claude can start in the background with agent_run. Each run gets a live card here.
        </Text>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
          <Box flexDirection="column" flexShrink={1} minWidth={0}>
            <Text wrap="truncate-end">
              <Text bold color={CODEX_ACCENT}>
                ● Codex
              </Text>
              <Text dimColor> built in</Text>
            </Text>
            <Text dimColor wrap="truncate-end">
              {isCodexOn ? 'the codex tool · live view of every Codex run · usage meters' : 'off'}
            </Text>
            {found.codex === false && <Text color="warning">codex is not on PATH</Text>}
          </Box>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <Button
              key="cx-toggle"
              label={isCodexOn ? 'On' : 'Off'}
              variant={isCodexOn ? 'primary' : undefined}
              onPress={() => void setCodexEnabled($, !isCodexOn)}
            />
            {Select && <Button key="cx-edit" label="Edit" onPress={() => void setView({ mode: 'codex' })} />}
          </Box>
        </Box>
        {hs.map(harnessRow)}
        {hs.length === 0 && <Text dimColor>No other harness yet.</Text>}
        {Select && Input && (
          <Text dimColor wrap="wrap">
            Edit a harness to pick its model from the ones it reports. Copilot and Claude Code can also run on your own API
            key (BYOK): Edit → Model API, or add the Copilot (own API) preset.
          </Text>
        )}
        {Select && Input ? (
          <Select
            key="h-add"
            label="Add"
            options={[{ value: '', label: 'Choose a preset…' }, ...PRESETS.map(p => ({ value: p.id, label: p.name }))]}
            value=""
            onSelect={v => {
              const p = PRESETS.find(x => x.id === v)
              if (p) void openEdit(fromPreset(p, hs.map(h => h.id)))
            }}
          />
        ) : (
          <Text dimColor wrap="wrap">
            Adding and editing harnesses needs the desktop app or the terminal.
          </Text>
        )}
        {metersSection()}
      </Box>
    )

    const field = (key: string, label: string, value: string, set: (d: Harness, v: string) => Harness, rows?: number) =>
      Input && (
        <Input
          key={key}
          label={label}
          value={value}
          rows={rows}
          submitLabel="keep"
          onInput={v => void patchDraft(d => set(d, v))}
          onSubmit={v => void patchDraft(d => set(d, v))}
        />
      )

    /** Where the CLI sends its model calls: its own service, or an API set here (BYOK). */
    const providerSection = (d: Harness) => {
      const types = providerTypesFor(d.parser)
      if (!types.length || !Select) return undefined
      const p = d.provider
      const setP = (x: Harness, patch: Partial<HarnessProvider>): Harness => ({
        ...x,
        provider: { type: x.provider?.type ?? types[0]!, baseUrl: x.provider?.baseUrl ?? '', ...x.provider, ...patch },
        // Another endpoint serves other models.
        models: 'baseUrl' in patch || 'type' in patch ? undefined : x.models,
      })
      return (
        <Box key="h-provider" flexDirection="column" gap={1}>
          <Select
            key="h-provider-type"
            label="Model API"
            options={[{ value: '', label: "The CLI's own service" }, ...PROVIDER_TYPES.filter(t => types.includes(t.value))]}
            value={p?.type ?? ''}
            onSelect={s =>
              void patchDraft(x => (s ? setP(x, { type: s as HarnessProvider['type'] }) : { ...x, provider: undefined, models: undefined }))
            }
          />
          {p && field('h-provider-url', 'API base URL', p.baseUrl, (x, s) => setP(x, { baseUrl: s }))}
          {p && field('h-provider-key', 'API key', p.apiKey ?? '', (x, s) => setP(x, { apiKey: s }))}
          {p && p.type === 'openai' && d.parser === 'copilot' && (
            <Select
              key="h-provider-wire"
              label="Wire format"
              options={[
                { value: 'completions', label: 'Chat Completions' },
                { value: 'responses', label: 'Responses (GPT-5 series)' },
              ]}
              value={p.wireApi ?? 'completions'}
              onSelect={s => void patchDraft(x => setP(x, { wireApi: s as HarnessProvider['wireApi'] }))}
            />
          )}
          {p && (
            <Text dimColor wrap="wrap">
              {`The key is kept in agent-deck's settings as plain text and handed to the CLI as ${
                d.parser === 'copilot' ? 'COPILOT_PROVIDER_API_KEY' : 'ANTHROPIC_API_KEY'
              }; it is not written into run files.`}
            </Text>
          )}
        </Box>
      )
    }

    /** Asks the harness for its models; a fixed list fills in at once. */
    const loadModels = async (d: Harness) => {
      const how = modelQuery(d)
      if (!how) return
      // An answer that comes back after the form moved on to another harness or endpoint is dropped.
      const isSame = (x: Harness) => x.parser === d.parser && x.command === d.command && x.provider?.baseUrl === d.provider?.baseUrl
      const patchEdit = (fn: (cur: Extract<HarnessView, { mode: 'edit' }>) => HarnessView) =>
        update($, viewAtom, cur => (cur.mode === 'edit' && isSame(cur.draft) ? fn(cur) : cur))
      if ('models' in how) return patchEdit(cur => ({ ...cur, modelsState: undefined, draft: { ...cur.draft, models: how.models } }))
      await patchEdit(cur => ({ ...cur, modelsState: 'loading' }))
      const r = await queryModels($, how.query, d)
      await patchEdit(cur =>
        'error' in r
          ? { ...cur, modelsState: { error: r.error } }
          : { ...cur, modelsState: undefined, draft: { ...cur.draft, models: r.models } },
      )
    }

    /** Opens the edit form, asking for the harness's models right away when it has none yet. */
    const openEdit = async (draft: Harness, originalId?: string) => {
      await setView({ mode: 'edit', draft, originalId })
      if (!draft.models?.length) await loadModels(draft)
    }

    const OTHER_MODEL = '__other__'

    /**
     * The model, as one control: a dropdown of what the harness reports (its default first,
     * Other… last), or a text field where it reports nothing.
     */
    const modelSection = (v: Extract<HarnessView, { mode: 'edit' }>) => {
      const d = v.draft
      const how = modelQuery(d)
      const known: HarnessModel[] = d.models ?? []
      const st = v.modelsState
      const isLoading = st === 'loading'
      const isCustom = !!d.model && !known.some(m => m.id === d.model)
      const typed = (label: string) => field('h-model', label, d.model ?? '', (x, s) => ({ ...x, model: s }))
      const refresh = (label: string) => (
        <Button key="h-models-list" label={label} onPress={() => void loadModels(d)} />
      )
      if (known.length && Select) {
        const options = [
          { value: '', label: "Default (the CLI's choice)" },
          ...known.map(m => ({ value: m.id, label: modelLabel(m) })),
          { value: OTHER_MODEL, label: 'Other…' },
        ]
        const isTyping = v.isTypingModel || isCustom
        return (
          <Box key="h-models" flexDirection="column" gap={1}>
            <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
              <Select
                key="h-model-pick"
                label="Model"
                options={options}
                value={isTyping ? OTHER_MODEL : (d.model ?? '')}
                onSelect={s =>
                  void update($, viewAtom, cur =>
                    cur.mode !== 'edit'
                      ? cur
                      : s === OTHER_MODEL
                        ? { ...cur, isTypingModel: true }
                        : { ...cur, isTypingModel: false, error: undefined, draft: { ...cur.draft, model: s || undefined } },
                  )
                }
              />
              {isLoading ? <Text dimColor>refreshing…</Text> : refresh('↻')}
            </Box>
            {isTyping && typed('Model id')}
            {st && st !== 'loading' && (
              <Text color="error" wrap="wrap">
                {`Could not refresh the models: ${st.error}`}
              </Text>
            )}
          </Box>
        )
      }
      return (
        <Box key="h-models" flexDirection="column" gap={1}>
          {isLoading ? (
            <Text>
              Model <Text dimColor>· asking {d.provider?.baseUrl ? 'the API' : d.command || 'the CLI'} which models it has…</Text>
            </Text>
          ) : (
            typed('Model')
          )}
          {!how && <Text dimColor wrap="wrap">This CLI can't list its models: type the id it takes, or leave it empty for its default.</Text>}
          {how && st && st !== 'loading' && (
            <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
              <Text color="error" wrap="wrap">
                {`Could not list models: ${st.error}`}
              </Text>
              {refresh('Try again')}
            </Box>
          )}
          {how && !st && refresh('List models')}
        </Box>
      )
    }

    const editView = (v: Extract<HarnessView, { mode: 'edit' }>) => {
      const d = v.draft
      const preset = PRESETS.find(p => p.id === d.preset)
      const others = hs.filter(h => h.id !== v.originalId)
      const save = async () => {
        const clean: Harness = {
          ...d,
          id: d.id.trim(),
          name: d.name.trim(),
          command: d.command.trim(),
          args: d.args.trim(),
          color: d.color.trim() || '#14B8A6',
          model: d.model?.trim() || undefined,
          provider: d.provider && {
            type: d.provider.type,
            baseUrl: d.provider.baseUrl.trim().replace(/\/+$/, ''),
            apiKey: d.provider.apiKey?.trim() || undefined,
            wireApi: d.provider.type === 'openai' && d.parser === 'copilot' ? d.provider.wireApi : undefined,
          },
        }
        const error = harnessError(clean, others)
        if (error) return setView({ ...v, error })
        await saveHarnesses($, v.originalId ? hs.map(h => (h.id === v.originalId ? clean : h)) : [...hs, clean])
        return setView({ mode: 'list' })
      }
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>
            {v.originalId ? 'Edit' : 'Add'} <Text color={d.color}>● {d.name || 'harness'}</Text>
          </Text>
          {preset && (
            <Text dimColor wrap="wrap">
              {preset.note}
            </Text>
          )}
          {field('h-name', 'Name', d.name, (x, s) => ({
            ...x,
            name: s,
            // A new harness's id follows its name until the id is edited.
            id: !v.originalId && (x.id === slugId(x.name) || !x.id) ? slugId(s) : x.id,
          }))}
          {field('h-id', 'Id', d.id, (x, s) => ({ ...x, id: s }))}
          {field('h-command', 'Command', d.command, (x, s) => ({ ...x, command: s }))}
          {field('h-args', 'Arguments', d.args, (x, s) => ({ ...x, args: s }), 2)}
          {Select && (
            <Select
              key="h-parser"
              label="Output"
              options={PARSERS}
              value={d.parser}
              onSelect={s => void patchDraft(x => ({ ...x, parser: s as HarnessParser, models: undefined }))}
            />
          )}
          {providerSection(d)}
          {modelSection(v)}
          {field('h-color', 'Color', d.color, (x, s) => ({ ...x, color: s }))}
          <Text dimColor wrap="wrap">
            {'{prompt} {model} {session} {cwd} are filled in; a flag whose value is empty is left out.'}
          </Text>
          <Text dimColor wrap="wrap">
            runs: <Text mono>{`${d.command} ${showArgs(expandArgs(d.args, { prompt: '<task>', model: d.model }))}`}</Text>
            {d.provider?.baseUrl.trim() ? ` against ${d.provider.baseUrl.trim()}` : ''}
          </Text>
          {v.error && (
            <Text color="error" wrap="wrap">
              {v.error}
            </Text>
          )}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="h-save" label="Save" variant="primary" onPress={() => void save()} />
            <Button key="h-cancel" label="Cancel" onPress={() => void setView({ mode: 'list' })} />
            {v.originalId && (
              <Button
                key="h-delete"
                label="Delete"
                onPress={() => {
                  void saveHarnesses($, hs.filter(h => h.id !== v.originalId)).then(() => setView({ mode: 'list' }))
                }}
              />
            )}
          </Box>
        </Box>
      )
    }

    const presetOf = (id?: string) => hs.find(x => x.id === id)?.preset
    const used = new Set<MeterProvider>(['claude'])
    for (const c of list) {
      if (c.provider === 'codex' || presetOf(c.harness) === 'codex-cli') used.add('codex')
      if (presetOf(c.harness) === 'copilot') used.add('copilot')
    }
    // A provider shows only with a reading: Codex also only while its built-in mode is on.
    const hasReading: Record<MeterProvider, boolean> = {
      claude: lim.claude.length > 0,
      codex: isCodexOn && lim.codex.length > 0,
      copilot: (lim.copilot ?? []).length > 0,
    }
    const shown = new Set((['codex', 'claude', 'copilot'] as const).filter(x => hasReading[x] && isMeterShown(meters, x, used)))

    const METER_NAMES: Record<MeterProvider, string> = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot' }
    const metersSection = () => (
      <Box flexDirection="column" gap={1} marginTop={1}>
        <Text bold>Usage meters</Text>
        {Select ? (
          <Select
            key="m-mode"
            label="Show"
            options={[
              { value: 'all', label: 'All connected' },
              { value: 'session', label: 'Used in this session' },
              { value: 'selected', label: 'Selected' },
            ]}
            value={meters.mode}
            onSelect={v => void saveMeters($, { ...meters, mode: v as MeterChoice['mode'] })}
          />
        ) : (
          <Text dimColor>{meters.mode === 'all' ? 'All connected' : meters.mode === 'session' ? 'Used in this session' : 'Selected'}</Text>
        )}
        {meters.mode === 'selected' && (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {(['claude', 'codex', 'copilot'] as const).map(x => {
              const isOn = meters.selected.includes(x)
              return (
                <Button
                  key={`m-${x}`}
                  label={`${METER_NAMES[x]} ${isOn ? '✓' : '·'}`}
                  variant={isOn ? 'primary' : undefined}
                  onPress={() =>
                    void saveMeters($, { ...meters, selected: isOn ? meters.selected.filter(y => y !== x) : [...meters.selected, x] })
                  }
                />
              )
            })}
          </Box>
        )}
        <Text dimColor wrap="wrap">
          {[
            'Claude: this session.',
            isCodexOn ? 'Codex: read from its session files.' : 'Codex: needs the built-in Codex on.',
            hasReading.copilot ? 'Copilot: premium requests via gh.' : 'Copilot: needs the GitHub CLI (gh) signed in to an account with Copilot.',
          ].join(' ')}
        </Text>
      </Box>
    )

    const codexHarnesses = hs.filter(x => x.preset === 'codex-cli')
    const codexMode = isCodexOn ? 'builtin' : codexHarnesses.some(x => x.isEnabled) ? 'custom' : 'off'

    const pickCodexMode = async (mode: string) => {
      if (mode === 'builtin' || mode === 'off') {
        if (codexHarnesses.some(x => x.isEnabled)) {
          await saveHarnesses($, hs.map(x => (x.preset === 'codex-cli' ? { ...x, isEnabled: false } : x)))
        }
        await setCodexEnabled($, mode === 'builtin')
        return setView({ mode: 'list' })
      }
      await setCodexEnabled($, false)
      const existing = codexHarnesses[0]
      if (existing) {
        await saveHarnesses($, hs.map(x => (x.id === existing.id ? { ...x, isEnabled: true } : x)))
        return openEdit({ ...existing, isEnabled: true }, existing.id)
      }
      const preset = PRESETS.find(x => x.id === 'codex-cli')
      if (preset) return openEdit(fromPreset(preset, hs.map(x => x.id)))
    }

    const codexView = () => (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold color={CODEX_ACCENT}>
            ● Codex
          </Text>
          <Button key="cx-back" label="Back" onPress={() => void setView({ mode: 'list' })} />
        </Box>
        {Select && (
          <Select
            key="cx-mode"
            label="Runs as"
            options={[
              { value: 'builtin', label: 'Built in' },
              { value: 'custom', label: 'Custom harness' },
              { value: 'off', label: 'Off' },
            ]}
            value={codexMode}
            onSelect={v => void pickCodexMode(v)}
          />
        )}
        <Text dimColor wrap="wrap">
          Built in: the codex tool (model, effort, sandbox, resume), a live card for every Codex run, also ones started in a
          terminal or the Codex app, and Codex usage meters.
        </Text>
        <Text dimColor wrap="wrap">
          Custom harness: Codex runs through agent_run like the other harnesses, with a command and arguments you edit.
          Only its own runs get cards, and there are no usage meters.
        </Text>
      </Box>
    )

    if (view.mode === 'codex') return codexView()
    if (view.mode === 'list') return listView()
    if (view.mode === 'edit') return editView(view)

    const running = list.filter(c => c.status === 'running')
    const finished = list.filter(c => c.status !== 'running').reverse()
    const totalCost = list.reduce((s, c) => s + (c.costUsd ?? 0), 0)

    return (
      <Box flexDirection="column" gap={0}>
        <Box flexDirection="row" justifyContent="flex-end">
          <Button key="h-open" label="⚙ Harnesses" plain onPress={() => void setView({ mode: 'list' })} />
        </Box>
        <Box flexDirection="column" marginBottom={Svg ? 0 : 1}>
          {shown.has('codex') && limitRow('Codex', CODEX_ACCENT, lim.codex, lim.codexPlan)}
          {shown.has('claude') && limitRow('Claude', 'claude', lim.claude)}
          {shown.has('copilot') && limitRow('Copilot', COPILOT_ACCENT, lim.copilot ?? [], lim.copilotPlan)}
        </Box>
        {cacheBox}
        {list.length === 0 && <Text dimColor>No subagents yet. Codex, Claude and harness runs appear here.</Text>}
        {running.map(card)}
        {finished.length > 0 && (
          <Box marginTop={1} paddingX={1}>
            <Text dimColor>
              Finished · {finished.length}
              {totalCost > 0 ? ` · ≈$${totalCost.toFixed(2)} API-equivalent` : ''}
            </Text>
          </Box>
        )}
        {finished.map(card)}
      </Box>
    )
  })
}
