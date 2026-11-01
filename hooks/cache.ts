import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheState } from '../types'

// The main conversation's prompt cache: its state, a keep-warm window that pings it
// with a tool-less fork before it lapses, and a guard that refuses one cold send.
// Modelled on cache-tax (github.com/karanb192/cache-tax).

type $T = EngineInterface
type On = Parameters<Register>[0]
type Timer = { cancel: () => void }

const HOUR = 60 * 60_000
const MIN_PING_MS = 60_000
const MAX_RETRIES = 3
const BIG_TOKENS = 50_000
const PING_PROMPT = 'Reply with the single word: warm'
export const DEFAULT_WINDOW_MS = 2 * HOUR
const KEY_DEADLINE = 'keepwarm-deadline'
const KEY_GUARD = 'cache-guard'

const FIVE_MIN = 5 * 60_000

/**
 * The main conversation's cache TTL, as Claude Code picks it: FORCE_PROMPT_CACHING_5M,
 * then CLAUDE_CODE_PROMPT_CACHE_TTL, then the promptCacheTtl setting, then
 * ENABLE_PROMPT_CACHING_1H; else one hour on a subscription within its plan, five
 * minutes on an API key, a cloud provider, a gateway or usage credits.
 */
export type TtlInputs = { force5m?: string; envTtl?: string; settingTtl?: unknown; enable1h?: string; isMetered: boolean }

export const ttlFor = (i: TtlInputs): number => {
  if (i.force5m === '1') return FIVE_MIN
  for (const v of [i.envTtl, i.settingTtl]) {
    if (v === '5m') return FIVE_MIN
    if (v === '1h') return HOUR
  }
  if (i.enable1h === '1') return HOUR
  return i.isMetered ? FIVE_MIN : HOUR
}

export const isGatewayUrl = (url: string | undefined): boolean =>
  !!url?.trim() && !/^https:\/\/api\.anthropic\.com(\/v1)?\/?$/i.test(url.trim())

async function resolveTtl($: $T): Promise<number> {
  const metered = await Promise.all([
    $.env.get('ANTHROPIC_API_KEY'),
    $.env.get('ANTHROPIC_AUTH_TOKEN'),
    $.env.get('CLAUDE_CODE_USE_BEDROCK'),
    $.env.get('CLAUDE_CODE_USE_VERTEX'),
    $.env.get('CLAUDE_CODE_USE_FOUNDRY'),
  ])
  // The desktop app sets the base URL to Anthropic's own API; only another host is a gateway.
  metered.push(isGatewayUrl(await $.env.get('ANTHROPIC_BASE_URL')) ? 'gateway' : undefined)
  const usage = await $.session.usage().catch(() => undefined)
  // Past a plan's limit the session draws on usage credits, which drop it to five minutes.
  const isOverPlan = usage?.rateLimits.some(r => r.percentUsed >= 100) ?? false
  return ttlFor({
    force5m: await $.env.get('FORCE_PROMPT_CACHING_5M'),
    envTtl: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
    settingTtl: await $.settings.read({ key: 'promptCacheTtl' }).catch(() => undefined),
    enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
    isMetered: metered.some(Boolean) || isOverPlan,
  })
}

// Prompts no person sent: refusing one would lose it, so the guard only logs the price.
const UNATTENDED = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity'])

// ---------- prices (USD per million tokens, list prices) ----------

export type Price = { input: number; output: number; cacheRead: number }

export const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 1 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus-4(?:-[01])?(?:$|[^-\d]|-20\d{6})/, { input: 15, output: 75, cacheRead: 1.5 }],
  [/opus/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/sonnet-5-5/, { input: 2, output: 10, cacheRead: 0.1 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/3-5-haiku|haiku-3-5/, { input: 0.8, output: 4, cacheRead: 0.08 }],
  [/haiku/, { input: 1, output: 5, cacheRead: 0.1 }],
]

export const priceOf = (model: string | undefined): Price | undefined => {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  return PRICES.find(([re]) => re.test(m))?.[1]
}

/** A cache write's rate per million tokens: twice the input rate for the 1-hour cache, 1.25x for the 5-minute one. */
export const writeRate = (p: Price, ttlMs: number) => p.input * (ttlMs >= HOUR ? 2 : 1.25)

// ---------- formatting ----------

export const fmtDuration = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 48) return `${Math.floor(h / 24)}d${h % 24}h`
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

export const fmtUsd = (usd: number | undefined): string =>
  usd === undefined ? 'n/a' : `$${usd >= 100 ? usd.toFixed(0) : usd >= 0.1 ? usd.toFixed(2) : usd.toFixed(3)}`

export const fmtTok = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

/** Parses `90m`, `2h`, `2h30m`. */
export const parseDuration = (text: string): number | undefined => {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return undefined
  const ms = (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000
  return ms > 0 ? ms : undefined
}

// ---------- state ----------

export const freshCache = (sid = ''): CacheState => ({
  sid,
  ctx: 0,
  ttlMs: HOUR,
  lastRequestAt: 0,
  isReset: false,
  deadline: 0,
  every: 0,
  pings: 0,
  pingUsd: 0,
  retries: 0,
  isWaitingForTurn: false,
  guard: 'refuse',
  ackedAt: 0,
  coldWrites: [],
  transcript: 0,
})

export const cacheAtom = atom({ plugin: 'agent-deck', key: 'cache' } as const, freshCache())

/** The ping period: ten minutes before a 1-hour cache lapses, one minute before a 5-minute one. */
export const pingEvery = (s: CacheState) => s.every || (s.ttlMs >= HOUR ? s.ttlMs - 10 * 60_000 : s.ttlMs - 60_000)

export const isCold = (s: CacheState, now: number) => s.lastRequestAt > 0 && !s.isReset && now - s.lastRequestAt >= s.ttlMs

export const coldUsd = (s: CacheState): number | undefined => {
  const p = priceOf(s.model)
  return p ? (s.ctx * writeRate(p, s.ttlMs)) / 1e6 : undefined
}

export const warmUsd = (s: CacheState): number | undefined => {
  const p = priceOf(s.model)
  return p ? (s.ctx * p.cacheRead) / 1e6 : undefined
}

export type CacheTone = 'warm' | 'cold' | 'unknown'

/** What the pane and the band draw. */
export const cacheView = (s: CacheState, now: number) => {
  const tone: CacheTone = !s.lastRequestAt || s.isReset ? 'unknown' : isCold(s, now) ? 'cold' : 'warm'
  const leftMs = tone === 'warm' ? s.lastRequestAt + s.ttlMs - now : 0
  const label =
    tone === 'warm'
      ? `warm · ${fmtDuration(leftMs)} left`
      : tone === 'cold'
        ? `cold · ${fmtDuration(now - s.lastRequestAt - s.ttlMs)} ago`
        : s.isReset
          ? 'rebuilt on the next turn'
          : 'no request yet'
  const every = pingEvery(s)
  const keepwarm = !s.deadline
    ? undefined
    : {
        leftMs: s.deadline - now,
        next: !s.lastRequestAt || s.isReset || s.isWaitingForTurn
          ? 'first ping after the next turn'
          : tone === 'cold'
            ? 'cache is cold, waiting for the next turn'
            : s.retries
              ? `API busy, retry ${s.retries} of ${MAX_RETRIES}`
              : `next ping in ${fmtDuration(Math.max(0, s.lastRequestAt + every - now))}`,
      }
  const paid = s.coldWrites.reduce((a, w) => a + (w.usd ?? 0), 0)
  return { tone, leftMs, label, keepwarm, coldUsd: coldUsd(s), warmUsd: warmUsd(s), paid, ttlPercent: tone === 'warm' ? (leftMs / s.ttlMs) * 100 : 0 }
}

// ---------- the engine side ----------

let s: CacheState = freshCache()
let pending: Timer | undefined
let isInFlight = false
let gen = 0
let tick = 0
let retryReason = ''
let isColdWritePending = false

function save($: $T) {
  return update($, cacheAtom, () => ({ ...s, coldWrites: [...s.coldWrites] }))
}

const deadlineKey = () => `${KEY_DEADLINE}:${s.sid}`

async function ensureSid($: $T) {
  if (!s.sid) s.sid = await $.session.id()
}

/** Cancels the timer; the tick tells a timer that already fired that the schedule changed. */
const disarm = () => {
  pending?.cancel()
  pending = undefined
  tick++
}

const markReset = () => {
  s.isReset = true
  s.transcript = 0
  s.ackedAt = 0
  gen++
}

export async function stopKeepWarm($: $T, why?: string) {
  s.deadline = 0
  s.every = 0
  s.stopped = why
  s.retries = 0
  gen++
  disarm()
  if (s.sid) await $.store.delete(deadlineKey())
  await save($)
}

async function arm($: $T): Promise<void> {
  disarm()
  s.retries = 0
  if (!s.deadline) {
    await save($)
    return
  }
  const now = await $.clock.now()
  // A timer set while the clock was read is replaced, never left beside this one.
  disarm()
  s.retries = 0
  if (now >= s.deadline) return stopKeepWarm($)
  if (s.lastRequestAt && !s.isReset && !isCold(s, now)) {
    const untilCold = s.lastRequestAt + s.ttlMs - now
    if (s.isWaitingForTurn) pending = $.clock.after(Math.min(s.deadline - now, untilCold), () => void arm($))
    else {
      const delay = Math.min(s.deadline - now, untilCold, Math.max(1000, s.lastRequestAt + pingEvery(s) - now))
      pending = $.clock.after(delay, () => void ping($))
    }
  } else {
    // Nothing warm to ping: wake at the deadline to close the window.
    pending = $.clock.after(s.deadline - now, () => void arm($))
  }
  await save($)
}

const afterRetries = (n: number) => (n ? ` after ${n} ${n === 1 ? 'retry' : 'retries'}` : '')

async function ping($: $T): Promise<void> {
  pending = undefined
  if (!s.deadline) return
  const t = tick
  const now = await $.clock.now()
  if (tick !== t) return pending || isInFlight ? undefined : arm($)
  if (isInFlight) return
  if (now >= s.deadline || isCold(s, now) || s.isReset || s.isWaitingForTurn || !s.lastRequestAt) return arm($)
  // A request since this timer was set moved the cache clock.
  if (now - s.lastRequestAt < pingEvery(s) - 1000) return arm($)
  if (s.retries && now >= s.lastRequestAt + s.ttlMs - MIN_PING_MS) return stopKeepWarm($, retryReason + afterRetries(s.retries))
  const sentGen = gen
  const sentAt = s.lastRequestAt
  isInFlight = true
  const sent = await $.model.fork({ prompt: PING_PROMPT }).then(
    reply => ({ reply }),
    (err: unknown) => ({ err }),
  )
  const at = await $.clock.now()
  isInFlight = false
  // A stop, /clear, compaction or a real request replaced what this ping was for.
  if (sentGen !== gen || s.lastRequestAt !== sentAt) return pending ? undefined : arm($)
  if ('err' in sent) return stopKeepWarm($, `the ping failed: ${sent.err instanceof Error ? sent.err.message : String(sent.err)}`)
  const reply = sent.reply
  if (!reply) return stopKeepWarm($, 'the engine did not send the ping')
  if (reply.isAnswered === false) {
    if (reply.reason === 'nothing-to-fork') {
      s.isWaitingForTurn = true
      return arm($)
    }
    const status = 'status' in reply ? reply.status : null
    const reason =
      reply.reason === 'api-error'
        ? `the API call failed${status === null || status === undefined ? '' : ` (${status})`}`
        : reply.reason === 'aborted'
          ? 'the ping was interrupted'
          : 'the ping returned no text'
    // A busy API is usually brief: retry while a ping can still land before the cache lapses.
    if (reply.reason === 'api-error' && (status == null || status === 429 || status >= 500)) {
      const wait = MIN_PING_MS * 2 ** s.retries
      if (s.retries < MAX_RETRIES && at + wait < Math.min(s.deadline, s.lastRequestAt + s.ttlMs - MIN_PING_MS)) {
        s.retries++
        retryReason = reason
        disarm()
        pending = $.clock.after(wait, () => void ping($))
        await save($)
        return
      }
    }
    return stopKeepWarm($, reason + afterRetries(s.retries))
  }
  const u = reply.usage
  const p = priceOf(s.model)
  // A warm ping reads the prefix and writes only its own message.
  const isWarm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  const usd = p
    ? (u.cache_read_input_tokens * p.cacheRead +
        u.cache_creation_input_tokens * writeRate(p, s.ttlMs) +
        u.input_tokens * p.input +
        u.output_tokens * p.output) /
      1e6
    : undefined
  s.lastPing = { at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, isWarm }
  s.pings++
  s.pingUsd += usd ?? 0
  if (!isWarm) {
    return stopKeepWarm($, `the ping read ${fmtTok(u.cache_read_input_tokens)} and wrote ${fmtTok(u.cache_creation_input_tokens)} tokens (${fmtUsd(usd)}): the cache was already gone`)
  }
  s.lastRequestAt = now
  await arm($)
}

/** Arms (or re-arms) a keep-warm window of `ms` from now. */
export async function startKeepWarm($: $T, ms: number, every = 0) {
  await ensureSid($)
  const now = await $.clock.now()
  s.deadline = now + ms
  s.every = every
  s.stopped = undefined
  await $.store.set(deadlineKey(), s.deadline)
  await arm($)
}

export async function setGuard($: $T, guard: CacheState['guard']) {
  s.guard = guard
  await $.store.set(KEY_GUARD, guard)
  await save($)
}

/** The band's Send anyway: submits the held cold send, which the guard lets through as a plugin's prompt. */
export async function sendHeld($: $T) {
  const held = s.held
  if (!held) return
  s.held = undefined
  s.ackedAt = 0
  // The band says so at once: a cold re-write can take a while before any reply shows.
  s.sending = { text: held.text, at: await $.clock.now(), tokens: s.ctx }
  isColdWritePending = true
  await save($)
  $.ui.toast(`agent-deck: sent. Re-writing ${fmtTok(s.ctx)} tokens of cache first, so the reply can take a minute.`)
  const r = await $.prompt
    .submit({ text: held.text, asUser: true, wait: false })
    .catch((err: unknown) => ({ drop: String((err as Error)?.message ?? err) }))
  if (r?.drop !== undefined) {
    isColdWritePending = false
    s.held = held
    s.sending = undefined
    await save($)
    $.ui.toast(`agent-deck: the held prompt was not sent: ${r.drop}`)
  }
}

export async function discardHeld($: $T) {
  s.held = undefined
  s.ackedAt = 0
  await save($)
}

const guardText = (now: number) => {
  const p = priceOf(s.model)
  const rate = p ? `$${writeRate(p, s.ttlMs)}/MTok` : 'the cache-write rate'
  const warm = warmUsd(s)
  return (
    `the prompt cache went cold ${fmtDuration(now - s.lastRequestAt - s.ttlMs)} ago. Sending this re-writes up to ` +
    `${s.ctx.toLocaleString('en-US')} tokens at ${rate} = ${fmtUsd(coldUsd(s))}` +
    (warm === undefined ? '' : ` (a warm turn would have cost ${fmtUsd(warm)})`)
  )
}

/** The `/cache` card. */
export const cacheCard = (now: number): string => {
  const v = cacheView(s, now)
  const lines = [
    `model       ${s.model ?? 'not seen yet'} · ${s.ttlMs >= HOUR ? '1h' : '5m'} cache`,
    `state       ${v.label}`,
    `context     ${s.ctx.toLocaleString('en-US')} tokens`,
    `cold cost   ${fmtUsd(v.coldUsd)} to re-write it (warm turn ${fmtUsd(v.warmUsd)})`,
    `keep-warm   ${v.keepwarm ? `on, ${fmtDuration(v.keepwarm.leftMs)} left, ${v.keepwarm.next}` : s.stopped ? `stopped: ${s.stopped}` : 'off (/keepwarm 2h to arm it)'}`,
    `pings       ${s.pings}${s.pings ? `, ${fmtUsd(s.pingUsd)}` : ''}${s.lastPing ? `; last read ${fmtTok(s.lastPing.read)} for ${fmtUsd(s.lastPing.usd)}` : ''}`,
    `guard       ${s.guard === 'refuse' ? 'refuse a cold send once' : s.guard === 'warn' ? 'warn only' : 'off'} (/cache guard refuse|warn|off)`,
    `cold writes ${s.coldWrites.length} this session, ${fmtUsd(v.paid)}`,
  ]
  return lines.join('\n')
}

/** session.start's part, run after the engine's start. */
export async function cacheSessionStart($: $T) {
  const sid = await $.session.id()
  const prev = await read($, cacheAtom)
  // A reload keeps the session's figures; a new session starts fresh.
  s = prev.sid === sid ? { ...freshCache(sid), ...prev, coldWrites: [...prev.coldWrites] } : freshCache(sid)
  gen++
  s.model ??= await $.session.model()
  s.ttlMs = await resolveTtl($).catch(() => s.ttlMs)
  const usage = await $.session.usage().catch(() => undefined)
  if (usage?.context.tokens) s.ctx = usage.context.tokens
  const now = await $.clock.now()
  const saved = await $.store.get(deadlineKey())
  s.deadline = typeof saved === 'number' && saved > now ? saved : 0
  if (!s.deadline && saved !== undefined) await $.store.delete(deadlineKey())
  const guard = await $.store.get(KEY_GUARD)
  s.guard = guard === 'warn' || guard === 'off' ? guard : 'refuse'
  await $.command.register({
    name: 'keepwarm',
    description: 'Keep the prompt cache warm: a window such as 90m or 2h (bare: 2h), off, or status (agent-deck)',
    argumentHint: '[2h | 90m | off | status]',
    immediate: true,
  })
  await $.command.register({
    name: 'cache',
    description: 'Prompt cache state, cold re-write price and keep-warm; guard refuse|warn|off (agent-deck)',
    argumentHint: '[status | guard refuse | guard warn | guard off]',
    immediate: true,
  })
  await arm($)
}

export const cacheSessionEnd = () => disarm()

/** A main-thread request is going out: it refreshes the cache clock. */
export async function cacheBeforeStep($: $T, e: { messageCount: number; model?: string }) {
  await ensureSid($)
  // A request over fewer than half the last one's messages follows a compaction.
  if (e.messageCount * 2 < s.transcript) markReset()
  s.transcript = e.messageCount
  s.lastRequestAt = await $.clock.now()
  if (e.model) s.model = e.model
  void save($)
}

type TurnUsage = { model?: string; input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/** A main-thread turn ended: re-reads the context, scores a cold write, re-arms keep-warm. */
export async function cacheAfterTurn($: $T, e: { usage?: TurnUsage | null; isAborted?: boolean; durationMs: number }) {
  const now = await $.clock.now()
  if ((e.usage || !e.isAborted) && now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
  const wasReset = s.isReset
  s.isReset = false
  // Crossing a plan's limit mid-session changes the TTL of the next writes.
  s.ttlMs = await resolveTtl($).catch(() => s.ttlMs)
  s.isWaitingForTurn = false
  s.ackedAt = 0
  s.held = undefined
  s.sending = undefined
  const u = e.usage
  if (u) {
    if (u.model) s.model = u.model
    const prev = s.ctx
    const live = (await $.session.usage().catch(() => undefined))?.context.tokens
    s.ctx = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
    const written = wasReset ? 0 : u.cache_creation_input_tokens
    if ((prev > 20_000 && written >= 0.5 * prev) || (isColdWritePending && written > 0)) {
      const p = priceOf(s.model)
      const usd = p ? (written * writeRate(p, s.ttlMs)) / 1e6 : undefined
      s.coldWrites = [...s.coldWrites, { at: now, tokens: written, usd }].slice(-20)
      $.ui.log(`agent-deck: cold cache write of ${fmtTok(written)} tokens paid (${fmtUsd(usd)}). /keepwarm 2h keeps it warm through a break.`)
    }
  }
  isColdWritePending = false
  await arm($)
}

export const registerCache = (on: On) => {
  // /clear, a resume or a fork: the resume fields say how old the cache is.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    gen++
    if (e.source === 'clear') {
      const keepGuard = s.guard
      disarm()
      if (s.sid) await $.store.delete(deadlineKey())
      s = { ...freshCache(), guard: keepGuard }
      await save($)
      return r
    }
    if (e.source === 'resume' || e.source === 'fork') {
      if (typeof e.context_tokens === 'number' && e.context_tokens > 0) s.ctx = e.context_tokens
      if (typeof e.seconds_since_last_response === 'number') s.lastRequestAt = (await $.clock.now()) - e.seconds_since_last_response * 1000
      if (typeof e.model === 'string') s.model = e.model
      s.isReset = false
    }
    await arm($)
    return r
  })

  // A model switch forfeits the cache: the next request writes it afresh, and is never a "cold send".
  on('classic.PostModelSwitch', async ($, e, next) => {
    const r = await next(e)
    s.model = e.to_model
    s.ttlMs = e.cache_ttl === '5m' ? 5 * 60_000 : HOUR
    if (e.context_tokens) s.ctx = e.context_tokens
    markReset()
    await arm($)
    return r
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    await ensureSid($)
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'off') {
      await stopKeepWarm($)
      return { text: 'keep-warm is off' }
    }
    if (words[0] === 'status') return { text: cacheCard(now) }
    const ms = words.length ? parseDuration(words[0]!) : DEFAULT_WINDOW_MS
    if (!ms) return { text: 'keepwarm takes a window such as 2h or 90m, or off, or status' }
    let every = 0
    if (words[1] === 'every') {
      const period = parseDuration(words[2] ?? '')
      if (!period || period < MIN_PING_MS || period >= s.ttlMs) return { text: `every takes a period from 1m to under the cache's ${fmtDuration(s.ttlMs)}` }
      every = period
    }
    await startKeepWarm($, ms, every)
    const cold = isCold(s, now) ? ' The cache is cold now, so the first ping comes after the next turn.' : ''
    return { text: `keep-warm on for ${fmtDuration(ms)}: a ping ${fmtDuration(pingEvery(s))} after each idle stretch keeps the cache read, not re-written.${cold}` }
  })

  on('command.run', { command: 'cache' }, async ($, e) => {
    await ensureSid($)
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    if (words[0] === 'guard') {
      const g = words[1]
      if (g !== 'refuse' && g !== 'warn' && g !== 'off') return { text: '/cache guard takes refuse, warn or off' }
      await setGuard($, g)
      return {
        text:
          g === 'refuse'
            ? 'cold guard: refuse once. A cold send is dropped with its price; sending it again goes through.'
            : g === 'warn'
              ? 'cold guard: warn. A cold send goes through with its price logged.'
              : 'cold guard: off.',
      }
    }
    return { text: cacheCard(await $.clock.now()) }
  })

  // The guard: only the first character of the prompt is read, for a slash.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' || s.guard === 'off') return next(e)
    if (typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    const now = await $.clock.now()
    if (!isCold(s, now) || s.ctx < BIG_TOKENS) return next(e)
    const isUnattended = UNATTENDED.has(e.origin.kind)
    if (s.guard === 'warn' || isUnattended) {
      $.ui.log(`agent-deck: ${guardText(now)}. Sending anyway${isUnattended ? `, since this ${e.origin.kind} prompt cannot be sent again` : ''}.`)
      isColdWritePending = true
      return next(e)
    }
    if (s.ackedAt === s.lastRequestAt) {
      s.ackedAt = 0
      s.held = undefined
      isColdWritePending = true
      await save($)
      return next(e)
    }
    s.ackedAt = s.lastRequestAt
    // Attachments can't be sent again by a plugin, so a prompt with any is only refused.
    s.held = e.attachments?.length ? undefined : { text: e.text, usd: coldUsd(s) }
    await save($)
    const again = s.held ? 'Press Send anyway above the prompt, or send it again,' : 'Send it again'
    return { drop: `agent-deck: ${guardText(now)}. ${again} to pay it, or /clear and start from a note. /keepwarm keeps it warm through your next break.` }
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      markReset()
      s.ctx = 0
      await arm($)
    }
    return r
  })
}
