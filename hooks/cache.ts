import type { CacheState } from '../types'

// The main conversation's prompt cache: its state, a keep-warm window that pings it
// with a tool-less fork before it lapses, and a guard that refuses one cold send.
// Modelled on cache-tax (github.com/karanb192/cache-tax).

const HOUR = 60 * 60_000
const MAX_RETRIES = 3
export const DEFAULT_WINDOW_MS = 2 * HOUR

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
