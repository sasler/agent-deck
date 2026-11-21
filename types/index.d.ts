export type Provider = 'codex' | 'claude' | 'strata' | 'harness'

/** How a harness's stdout is read. */
export type HarnessParser = 'codex' | 'copilot' | 'opencode' | 'gemini' | 'antigravity' | 'cursor' | 'claude' | 'text'

/** The API a harness's CLI sends its model calls to, instead of the CLI's own service (BYOK). */
export type HarnessProvider = {
  type: 'openai' | 'azure' | 'anthropic'
  /** The endpoint, for example https://openrouter.ai/api/v1 or http://127.0.0.1:11434/v1. */
  baseUrl: string
  /** Kept in agent-deck's settings as plain text; never written into a run's files or shown in its command. */
  apiKey?: string
  /** Copilot only: the OpenAI wire format, completions (the default) or responses. */
  wireApi?: 'completions' | 'responses'
  /** Copilot only: transport for the Responses API. */
  transport?: 'http' | 'websockets'
  /** Copilot only: a known base model for tool support and token limits. */
  modelId?: string
  /** Copilot only: deployment or fine-tuned model name sent to the API. */
  wireModel?: string
}

/** One model a harness can run, as its CLI or API reported it. */
export type HarnessModel = { id: string; name?: string; note?: string }

/** A CLI agent agent-deck can start, as the person set it up in the Harnesses view. */
export type Harness = {
  /** Lowercase, letters, digits and dashes: what `agent_run` names. */
  id: string
  name: string
  /** A theme color name or #rrggbb. */
  color: string
  command: string
  /**
   * The arguments, shell-like: quotes group words. {prompt}, {model}, {session}, {cwd} and
   * {effort} are filled in; a word whose placeholder is empty is left out with the flag before it.
   */
  args: string
  model?: string
  /** Copilot Auto routing preference; the CLI validates account availability. */
  autoTier?: string
  /** Copilot's session-wide soft limit, including subagents; at least 30 credits. */
  maxAiCredits?: number
  parser: HarnessParser
  /** Set: the CLI runs against this API. Copilot and Claude Code read it from environment variables. */
  provider?: HarnessProvider
  /** The models it last reported, from List models in the edit form. */
  models?: HarnessModel[]
  isEnabled: boolean
  /** The preset it came from, if any. */
  preset?: string
}

/**
 * Who does one kind of task: a harness id, `codex` (the built-in codex tool) or `claude`
 * (a Claude subagent). An empty target means no preference. `effort` is a reasoning effort
 * the target takes: a harness CLI's flag, the codex tool's effort, or the Agent tool's.
 */
export type TaskRoute = { task: string; target: string; model?: string; effort?: string }

/** Task routing: the table, and whether Claude is told to follow it. */
export type Routing = { isOn: boolean; routes: TaskRoute[] }

/** The settings pane's sections, one tab each. */
export type SettingsSection = 'harnesses' | 'routing' | 'meters' | 'codex'

/** What settings show: nothing (the deck), a section's list, or the form that adds or edits a harness. */
export type HarnessView =
  | { mode: 'cards' }
  | { mode: 'list' }
  | {
      mode: 'edit'
      draft: Harness
      originalId?: string
      error?: string
      /** List models: asking, or what went wrong. */
      modelsState?: 'loading' | { error: string }
      /** Other… was picked: the model is typed rather than chosen from the list. */
      isTypingModel?: boolean
    }

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

export type CopilotModelUsage = {
  tokens: Tokens
  aiCredits?: number
  aiCreditsStatus?: 'complete' | 'partial' | 'unavailable'
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
  /** Copilot's AI credits used (its nano AI units / 10^9). */
  aiCredits?: number
  aiCreditsStatus?: 'complete' | 'partial' | 'unavailable'
  /** Reported usage by concrete model, including Fusion phases and subagents. */
  modelUsage?: Record<string, CopilotModelUsage>
  /** The CLI a run started with, e.g. "codex-cli 0.170.0 · C:\\...\\codex.cmd". */
  binary?: string
  /** Epoch ms of the last rollout line a Codex card got. */
  lastEventAt?: number
  error?: string
}

/** The Codex CLIs agent-deck found and the one runs start with. */
export type CodexBin = {
  candidates?: { path: string; version?: string; models?: string[]; error?: string }[]
  chosen?: { path: string; version?: string; models?: string[] }
  latest?: string
  override?: string
  /** The override came from CODEX_PATH, not the settings. */
  isEnvOverride?: boolean
  updateError?: string
  at?: number
  isChecking?: boolean
  isUpdating?: boolean
}

export type LimitWindow = {
  /** Short tag for the one-line meter: 5h, 7d, mo. */
  label: string
  /** Full name for the bar meter; absent, one is made from the label. */
  name?: string
  percent: number
  /** Epoch milliseconds. */
  resetsAt?: number
  /** A stable model-group key where a provider has groups: Antigravity's gemini, argon or other, from agy's bucket ids. */
  group?: string
  /** The window's length as a stable key: 5h, 7d, or the provider's own. */
  span?: string
}

export type CodexLimitSource = 'live' | 'rollout'

export type Limits = {
  codex: LimitWindow[]
  claude: LimitWindow[]
  codexPlan?: string
  /** Where Codex's reading came from: live from `codex app-server`, or a fallback session file. */
  codexSource?: CodexLimitSource
  /** Copilot's monthly AI credits, read with `gh api copilot_internal/user`. */
  copilot?: LimitWindow[]
  copilotPlan?: string
  /** Antigravity's weekly and 5-hour limits, per model group, from agy's own language server. */
  antigravity?: LimitWindow[]
  /** When each provider's reading was taken, epoch ms; a rollout fallback uses the time of the rollout line. */
  readAt?: Partial<Record<MeterProvider, number>>
  /** Refresh was pressed and the readings are being taken again. */
  isRefreshing?: boolean
}

export type MeterProvider = 'claude' | 'codex' | 'copilot' | 'antigravity'

/** Which usage meters the pane shows. */
export type MeterChoice = {
  /** all: every provider with a reading; session: those used in this session; selected: the list below. */
  mode: 'all' | 'session' | 'selected'
  selected: MeterProvider[]
  /** The usage limits are folded into one line. */
  isCollapsed?: boolean
  /** Which Antigravity windows show: Gemini's (basic, the default), Gemini's and Argon's, or all. */
  agyView?: AgyView
}

export type AgyView = 'basic' | 'gemini' | 'all'

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
  /** The cold send the guard held back, for the band's Send anyway button; absent when it had attachments. */
  held?: { text: string; usd?: number }
  /** A held send that Send anyway just submitted, shown in the band until its turn ends. */
  sending?: { text: string; at: number; tokens: number }
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
      /** Cards whose output shows in full, not just its last lines. */
      fullOutput: string[]
      tick: number
      cache: CacheState
      harnesses: Harness[]
      harnessView: HarnessView
      /** The settings tab that shows. */
      settingsSection: SettingsSection
      /** Settings draw in the main pane, because a second pane could not open. */
      settingsInline: boolean
      /** What is typed in Task routing's Add a task field. */
      taskDraft: string
      /** Harness id → whether its command was found on PATH. */
      found: Record<string, boolean>
      /** Whether the built-in Codex (codex tools, live view, usage meters) is on. */
      codexEnabled: boolean
      /** The Codex CLIs found and the one runs start with. */
      codexBin: CodexBin
      meters: MeterChoice
      /** Task routing: who does each kind of task, and whether Claude is told. */
      routing: Routing
    }
  }
}
