export type Provider = 'codex' | 'claude' | 'strata' | 'harness'

/** How a harness's stdout is read. */
export type HarnessParser = 'codex' | 'copilot' | 'opencode' | 'gemini' | 'cursor' | 'claude' | 'text'

/** A CLI agent agent-deck can start, as the person set it up in the Harnesses view. */
export type Harness = {
  /** Lowercase, letters, digits and dashes: what `agent_run` names. */
  id: string
  name: string
  /** A theme color name or #rrggbb. */
  color: string
  command: string
  /**
   * The arguments, shell-like: quotes group words. {prompt}, {model}, {session} and {cwd}
   * are filled in; a word whose placeholder is empty is left out with the flag before it.
   */
  args: string
  model?: string
  parser: HarnessParser
  isEnabled: boolean
  /** The preset it came from, if any. */
  preset?: string
}

export type HarnessView =
  | { mode: 'cards' }
  | { mode: 'list' }
  /** The built-in Codex: built in, or a custom harness. */
  | { mode: 'codex' }
  | { mode: 'edit'; draft: Harness; originalId?: string; error?: string }

export type AgentStatus = 'running' | 'done' | 'error' | 'aborted'

export type Activity = {
  id: string
  label: string
  status: 'running' | 'done' | 'error'
}

export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

export type AgentCard = {
  id: string
  provider: Provider
  title: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  /** Streamed text, newest last, capped. */
  output: string
  isThinking: boolean
  activity: Activity[]
  tokens: Tokens
  /** API-equivalent estimate in USD; absent where no price is known. */
  costUsd?: number
  /** Codex thread id, to resume a run. */
  threadId?: string
  /** agent-deck run id when started through the codex tool. */
  runId?: string
  /** Started outside the codex tool (Bash, terminal, Codex app). */
  isExternal?: boolean
  /** A harness card: which harness, its name and color as they were at start. */
  harness?: string
  providerName?: string
  accent?: string
  /** The harness's own session id, to resume it. */
  sessionRef?: string
  /** Copilot's premium requests used. */
  premiumRequests?: number
  error?: string
}

export type LimitWindow = {
  label: string
  percent: number
  /** Epoch milliseconds. */
  resetsAt?: number
}

export type Limits = {
  codex: LimitWindow[]
  claude: LimitWindow[]
  codexPlan?: string
  /** Copilot's monthly premium requests, read with `gh api copilot_internal/user`. */
  copilot?: LimitWindow[]
  copilotPlan?: string
}

export type MeterProvider = 'claude' | 'codex' | 'copilot'

/** Which usage meters the pane shows. */
export type MeterChoice = {
  /** all: every provider with a reading; session: those used in this session; selected: the list below. */
  mode: 'all' | 'session' | 'selected'
  selected: MeterProvider[]
}

export type CachePing = {
  at: number
  read: number
  write: number
  usd?: number
  isWarm: boolean
}

export type ColdWrite = { at: number; tokens: number; usd?: number }

/** The main conversation's prompt cache, as agent-deck tracks it. */
export type CacheState = {
  sid: string
  model?: string
  /** Context tokens the next request re-sends. */
  ctx: number
  ttlMs: number
  /** Epoch ms of the last main-thread request (or warm ping); 0 before the first. */
  lastRequestAt: number
  /** Compaction, /clear or a model switch: the next request writes the cache afresh. */
  isReset: boolean
  /** Keep-warm window end, epoch ms; 0 when off. */
  deadline: number
  /** Ping period override in ms; 0 for the default. */
  every: number
  /** Why keep-warm stopped by itself. */
  stopped?: string
  lastPing?: CachePing
  pings: number
  pingUsd: number
  retries: number
  isWaitingForTurn: boolean
  guard: 'refuse' | 'warn' | 'off'
  /** The lastRequestAt a refused cold send was refused at; the resend goes through. */
  ackedAt: number
  coldWrites: ColdWrite[]
  /** Message count of the last main request, to spot a compaction. */
  transcript: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-deck': {
      agents: AgentCard[]
      limits: Limits
      expanded: string[]
      tick: number
      cache: CacheState
      harnesses: Harness[]
      harnessView: HarnessView
      /** Harness id → whether its command was found on PATH. */
      found: Record<string, boolean>
      /** Whether the built-in Codex (codex tools, live view, usage meters) is on. */
      codexEnabled: boolean
      meters: MeterChoice
    }
  }
}
