import type { ToolSpec } from 'claude-code'

import type { Activity, AgentCard, CopilotModelUsage, Harness, HarnessModel, HarnessParser, HarnessProvider, Tokens } from '../types'

// ---------- presets ----------

export type Preset = Omit<Harness, 'isEnabled' | 'preset'> & { note: string }

/** CLIs agent-deck knows how to read. Each one's args run it headless, printing JSON events. */
export const PRESETS: Preset[] = [
  {
    id: 'codex-cli',
    name: 'Codex',
    color: '#10A37F',
    command: 'codex',
    args: 'exec --json --skip-git-repo-check --model {model} {prompt}',
    parser: 'codex',
    note: 'OpenAI Codex CLI as a plain harness. Resuming a conversation and the usage meters need the built-in Codex.',
  },
  {
    id: 'copilot',
    name: 'Copilot',
    color: '#8957E5',
    command: 'copilot',
    args: '-p {prompt} --output-format json --allow-all-tools --model {model} --resume {session}',
    parser: 'copilot',
    note: 'GitHub Copilot CLI. --allow-all-tools lets it run any tool without asking; narrow it with --allow-tool/--deny-tool.',
  },
  {
    id: 'copilot-api',
    name: 'Copilot (own API)',
    color: '#6E40C9',
    command: 'copilot',
    args: '-p {prompt} --output-format json --allow-all-tools --model {model} --resume {session}',
    parser: 'copilot',
    provider: { type: 'openai', baseUrl: '' },
    note:
      "GitHub Copilot CLI's agent, with its model calls sent to your own API instead of GitHub (BYOK): OpenRouter, OpenAI, Azure, Anthropic, " +
      'or a local Ollama, vLLM or LM Studio. The model must support tool calls and streaming. Set the default model to the id the API expects.',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    color: '#F59E0B',
    command: 'opencode',
    args: 'run --format json --model {model} --session {session} {prompt}',
    parser: 'opencode',
    note: 'OpenCode. Model as provider/model, for example github-copilot/gpt-6.1.',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    color: '#4285F4',
    command: 'gemini',
    args: '-p {prompt} --output-format stream-json --yolo --model {model} --resume {session}',
    parser: 'gemini',
    note: 'Gemini CLI. --yolo approves every tool call.',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    color: '#9CA3AF',
    command: 'cursor-agent',
    args: '-p {prompt} --output-format stream-json --force --model {model} --resume {session}',
    parser: 'cursor',
    note: 'Cursor Agent CLI. --force allows commands without asking.',
  },
  {
    id: 'claude-cli',
    name: 'Claude Code',
    color: 'claude',
    command: 'claude',
    args: '-p {prompt} --output-format stream-json --verbose --model {model} --resume {session}',
    parser: 'claude',
    note: 'A separate Claude Code process, with its own context and permissions.',
  },
  {
    id: 'custom',
    name: 'Custom',
    color: '#14B8A6',
    command: '',
    args: '{prompt}',
    parser: 'text',
    note: 'Any CLI: its output shows as text, without tokens or cost.',
  },
]

export const PARSERS: { value: HarnessParser; label: string }[] = [
  { value: 'codex', label: 'Codex exec JSON' },
  { value: 'copilot', label: 'Copilot JSON' },
  { value: 'opencode', label: 'OpenCode JSON' },
  { value: 'gemini', label: 'Gemini stream-json' },
  { value: 'cursor', label: 'Cursor stream-json' },
  { value: 'claude', label: 'Claude stream-json' },
  { value: 'text', label: 'Plain text' },
]

export const fromPreset = (p: Preset, taken: readonly string[] = []): Harness => {
  let id = p.id === 'custom' ? 'custom' : p.id
  for (let i = 2; taken.includes(id); i++) id = `${p.id}-${i}`
  const { note: _note, ...rest } = p
  return { ...rest, id, isEnabled: true, preset: p.id }
}

// ---------- your own API (BYOK) ----------

export const PROVIDER_TYPES: { value: HarnessProvider['type']; label: string }[] = [
  { value: 'openai', label: 'OpenAI-compatible' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
]

/** The CLIs that can be pointed at another API, and the provider types each accepts. */
const PROVIDER_SUPPORT: Partial<Record<HarnessParser, readonly HarnessProvider['type'][]>> = {
  copilot: ['openai', 'azure', 'anthropic'],
  claude: ['anthropic'],
}

export const providerTypesFor = (parser: HarnessParser): readonly HarnessProvider['type'][] => PROVIDER_SUPPORT[parser] ?? []

/** The environment that points a harness's CLI at its provider; empty without one. */
export const providerEnv = (h: Pick<Harness, 'parser' | 'provider' | 'model'>, model?: string): Record<string, string> => {
  const p = h.provider
  if (!p?.baseUrl.trim()) return {}
  const env: Record<string, string> = {}
  const put = (k: string, v?: string) => {
    if (v?.trim()) env[k] = v.trim()
  }
  if (h.parser === 'copilot') {
    // Copilot's Anthropic client appends /v1 itself.
    const baseUrl = p.type === 'anthropic'
      ? p.baseUrl.trim().replace(/\/+$/, '').replace(/^(https?:\/\/[^/?#]+(?:\/[^/?#]+)*)\/v1$/, '$1')
      : p.baseUrl
    put('COPILOT_PROVIDER_BASE_URL', baseUrl)
    put('COPILOT_PROVIDER_TYPE', p.type)
    put('COPILOT_PROVIDER_API_KEY', p.apiKey)
    if (p.type !== 'anthropic') {
      put('COPILOT_PROVIDER_WIRE_API', p.wireApi)
      if (p.wireApi === 'responses') put('COPILOT_PROVIDER_TRANSPORT', p.transport)
    }
    if (!model || !h.model || model === h.model) {
      put('COPILOT_PROVIDER_MODEL_ID', p.modelId)
      put('COPILOT_PROVIDER_WIRE_MODEL', p.wireModel)
    }
    put('COPILOT_MODEL', model)
  } else if (h.parser === 'claude') {
    put('ANTHROPIC_BASE_URL', p.baseUrl)
    put('ANTHROPIC_API_KEY', p.apiKey)
    put('ANTHROPIC_MODEL', model)
  }
  return env
}

// ---------- which models a harness can run ----------

/** Claude Code takes these aliases and full ids; it has no command that lists them. */
const CLAUDE_MODELS: HarnessModel[] = [
  { id: 'opus', note: 'alias' },
  { id: 'sonnet', note: 'alias' },
  { id: 'haiku', note: 'alias' },
  { id: 'claude-fable-5-1', name: 'Fable 5.1' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5' },
]

/** What bin/models.mjs is asked to do; the env and provider can hold a key, so it goes through a file it deletes. */
export type ModelQuery = {
  source: 'acp' | 'lines' | 'codex' | 'api'
  command?: string
  args?: string[]
  env?: Record<string, string>
  provider?: HarnessProvider
}

/** How to find a harness's models: a fixed list, a query, or nothing this CLI offers. */
export const modelQuery = (h: Harness): { models: HarnessModel[] } | { query: ModelQuery } | undefined => {
  if (h.provider?.baseUrl.trim()) return { query: { source: 'api', provider: h.provider } }
  switch (h.parser) {
    case 'copilot':
      return { query: { source: 'acp', command: h.command } }
    case 'opencode':
      return { query: { source: 'lines', command: h.command, args: ['models'] } }
    case 'codex':
      return { query: { source: 'codex' } }
    case 'claude':
      return { models: CLAUDE_MODELS }
    default:
      return undefined
  }
}

/** Reads models.mjs's answer. */
export const parseModels = (stdout: string): { models: HarnessModel[] } | { error: string } => {
  try {
    const j = JSON.parse(stdout) as { models?: HarnessModel[]; error?: string }
    if (j.error) return { error: j.error }
    const seen = new Set<string>()
    const models = (j.models ?? []).filter(m => typeof m.id === 'string' && m.id && !seen.has(m.id) && seen.add(m.id))
    return models.length ? { models } : { error: 'It reported no models.' }
  } catch {
    return { error: stdout.trim().slice(0, 200) || 'No answer.' }
  }
}

/** Fusion selections also remain compatible with harnesses saved with the old virtual model ids. */
const COPILOT_FUSION: HarnessModel[] = [
  { id: 'hydrafusion', name: 'Copilot Fusion Standard', note: 'picks models per prompt' },
  { id: 'hydrafusion-max', name: 'Copilot Fusion Max', note: 'picks models per prompt' },
]

/** Auto and Fusion first; GitHub's own models only, not a harness on your own API. */
export const withFusion = (h: Pick<Harness, 'parser' | 'provider'>, models: HarnessModel[]): HarnessModel[] =>
  h.parser === 'copilot' && !h.provider?.baseUrl.trim()
    ? [{ id: 'auto', name: 'Auto', note: 'picks a model per prompt' }, ...COPILOT_FUSION, ...models.filter(m => m.id !== 'auto' && !COPILOT_FUSION.some(f => f.id === m.id))]
    : models

export const modelLabel = (m: HarnessModel) => [m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id, m.note].filter(Boolean).join(' · ')

// ---------- arguments ----------

/** Splits an args template into words: whitespace separates, single or double quotes group. */
export const tokenizeArgs = (s: string): string[] => {
  const words: string[] = []
  let word = ''
  let quote: string | undefined
  let has = false
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = undefined
      else word += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has || word) words.push(word)
      word = ''
      has = false
    } else {
      word += ch
    }
  }
  if (has || word) words.push(word)
  return words
}

export type ArgValues = { prompt: string; model?: string; session?: string; cwd?: string }

const PLACEHOLDER = /\{(prompt|model|session|cwd)\}/g

/**
 * Fills the template's placeholders. A word whose placeholders are all empty is
 * dropped; a word that is the placeholder alone takes the flag just before it along
 * (`--model {model}` goes whole), while `--model={model}` takes only itself.
 */
export const expandArgs = (template: string, v: ArgValues): string[] => {
  const out: string[] = []
  for (const word of tokenizeArgs(template)) {
    const names = [...word.matchAll(PLACEHOLDER)].map(m => m[1] as keyof ArgValues)
    if (names.length && names.every(n => !v[n])) {
      const isBare = /^\{(prompt|model|session|cwd)\}$/.test(word)
      const prev = out[out.length - 1]
      if (isBare && prev !== undefined && prev.startsWith('-') && !prev.includes('=')) out.pop()
      continue
    }
    out.push(word.replace(PLACEHOLDER, (_, n: keyof ArgValues) => v[n] ?? ''))
  }
  return out
}

export type CopilotRunOptions = { model?: string; autoTier?: string; maxAiCredits?: number }

const isFusionModel = (model: string | undefined) => COPILOT_FUSION.some(f => f.id === model)

const copilotRouting = (h: Harness, v: CopilotRunOptions) => {
  const model = v.autoTier && !v.model ? 'auto' : (v.model ?? h.model)
  const tier = v.autoTier ?? (isFusionModel(model) ? model : v.model && v.model !== 'auto' ? undefined : h.autoTier)
  return { model, tier }
}

export const copilotOptionsError = (h: Harness, v: CopilotRunOptions = {}): string | undefined => {
  const limit = v.maxAiCredits ?? h.maxAiCredits
  if (h.parser !== 'copilot') {
    return h.autoTier !== undefined || v.autoTier !== undefined || limit !== undefined
      ? 'Auto routing and AI credit limits need a Copilot harness.'
      : undefined
  }
  const { model, tier } = copilotRouting(h, v)
  if (tier !== undefined && (!tier.trim() || /\s/.test(tier))) return 'Give an Auto routing profile id without spaces.'
  if (h.provider && (tier || model === 'auto' || isFusionModel(model))) return 'Auto and Fusion use GitHub models, not your own API.'
  if (tier && model && model !== 'auto' && !isFusionModel(model)) return 'Pick Auto to use an Auto routing profile.'
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 30)) return 'The AI credit limit must be at least 30.'
  return undefined
}

const setArg = (args: string[], flag: string, value: string) => {
  let first = -1
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag && !args[i]?.startsWith(`${flag}=`)) continue
    const count = args[i] === flag && args[i + 1] && !args[i + 1]?.startsWith('-') ? 2 : 1
    args.splice(i, count)
    if (first < 0) first = i
    i--
  }
  args.splice(first < 0 ? args.length : first, 0, flag, value)
}

const removeArg = (args: string[], flag: string) => {
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] !== flag && !args[i]?.startsWith(`${flag}=`)) continue
    const count = args[i] === flag && args[i + 1] && !args[i + 1]?.startsWith('-') ? 2 : 1
    args.splice(i, count)
  }
}

const protectCopilotKey = (args: string[]) => {
  const key = 'COPILOT_PROVIDER_API_KEY'
  let found = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--secret-env-vars' && !args[i]?.startsWith('--secret-env-vars=')) continue
    found = true
    if ((args[i] === '--secret-env-vars' ? args[i + 1] : args[i]?.slice('--secret-env-vars='.length))?.split(',').includes(key)) continue
    if (args[i] === '--secret-env-vars') {
      if (args[i + 1] && !args[i + 1]?.startsWith('-')) args[i + 1] = `${args[i + 1]},${key}`
      else args.splice(i + 1, 0, key)
    } else args[i] = `${args[i]},${key}`
  }
  if (!found) args.push(`--secret-env-vars=${key}`)
}

type HarnessArgValues = ArgValues & CopilotRunOptions & { usageFile?: string }

/** Shared by the preview and runner, including old saved templates. No shell is involved. */
export const harnessCommand = (h: Harness, v: HarnessArgValues): { args: string[]; usageFile?: string } => {
  const error = copilotOptionsError(h, v)
  if (error) throw new Error(error)
  const { model, tier } = copilotRouting(h, v)
  if (h.parser !== 'copilot') return { args: expandArgs(h.args, { ...v, model }) }
  const values = { prompt: v.prompt, model: tier ? 'auto' : model, session: v.session, cwd: v.cwd }
  const markers = { prompt: '\0agent-deck-prompt\0', model: '\0agent-deck-model\0', session: '\0agent-deck-session\0', cwd: '\0agent-deck-cwd\0' }
  const expand = (arg: string) =>
    (Object.keys(markers) as (keyof typeof markers)[]).reduce((word, name) => word.split(markers[name]).join(values[name] ?? ''), arg)
  const args = expandArgs(h.args, {
    prompt: values.prompt ? markers.prompt : values.prompt,
    model: values.model ? markers.model : undefined,
    session: values.session ? markers.session : undefined,
    cwd: values.cwd ? markers.cwd : undefined,
  })
  for (let i = 0; i < args.length - 1; i++) {
    const prompt = args[i + 1]
    if ((args[i] === '-p' || args[i] === '--prompt') && prompt?.includes(markers.prompt) && expand(prompt).startsWith('-')) {
      args.splice(i, 2, `--prompt=${prompt}`)
    }
  }
  if (tier) {
    setArg(args, '--model', 'auto')
    setArg(args, '--auto-tier', tier)
    if (tier.startsWith('hydrafusion')) {
      for (let i = args.length - 1; i >= 0; i--) if (args[i] === '--no-experimental') args.splice(i, 1)
      if (!args.includes('--experimental')) args.push('--experimental')
    }
  } else if (v.model) {
    setArg(args, '--model', v.model)
    if (v.model !== 'auto') removeArg(args, '--auto-tier')
  }
  const limit = v.maxAiCredits ?? h.maxAiCredits
  if (limit !== undefined) setArg(args, '--max-ai-credits', String(limit))
  protectCopilotKey(args)
  if (v.usageFile && !args.some(a => a === '--usage-output-file' || a.startsWith('--usage-output-file='))) args.push('--usage-output-file', v.usageFile)
  let usageIndex = -1
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--usage-output-file' || args[i]?.startsWith('--usage-output-file=')) usageIndex = i
  }
  const usageArg = usageIndex < 0 ? undefined : args[usageIndex] === '--usage-output-file' ? args[usageIndex + 1] : args[usageIndex]?.slice('--usage-output-file='.length)
  return { args: args.map(expand), usageFile: usageArg ? expand(usageArg) : undefined }
}

export const harnessArgs = (h: Harness, v: HarnessArgValues): string[] => harnessCommand(h, v).args

// ---------- checking an edit ----------

export const slugId = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)

export const harnessError = (h: Harness, others: readonly Harness[]): string | undefined => {
  if (!h.name.trim()) return 'Give it a name.'
  if (!/^[a-z0-9][a-z0-9-]*$/.test(h.id)) return 'The id takes lowercase letters, digits and dashes.'
  if (h.id === 'codex') return '"codex" is the built-in Codex harness; pick another id.'
  if (others.some(o => o.id === h.id)) return `Another harness already has the id "${h.id}".`
  if (!h.command.trim()) return 'Name the command to run, for example copilot.'
  if (/\s/.test(h.command.trim())) return 'The command is one word; put its arguments under Arguments.'
  if (!h.args.includes('{prompt}')) return 'The arguments need {prompt} where the task goes.'
  const optionsError = copilotOptionsError(h)
  if (optionsError) return optionsError
  if (h.provider) {
    const types = providerTypesFor(h.parser)
    if (!types.length) return 'Only Copilot and Claude Code output can run against your own API; switch the API off or pick that output.'
    if (!types.includes(h.provider.type)) return `This CLI takes an ${types.join(' or ')} API, not ${h.provider.type}.`
    if (!/^https?:\/\/\S+$/.test(h.provider.baseUrl.trim())) return "Give the API's base URL, starting with http:// or https://."
    if (h.parser === 'copilot' && !h.model?.trim()) return 'Set the default model to the id your API expects; Copilot needs one with its own API.'
    if (h.provider.transport === 'websockets' && (h.provider.type === 'anthropic' || h.provider.wireApi !== 'responses')) return 'WebSockets needs the Responses wire format.'
  }
  return undefined
}

// ---------- reading a harness's output ----------

export type HarnessEvent =
  | { kind: 'model'; model: string }
  | { kind: 'text'; text: string; isDelta?: boolean }
  | { kind: 'reason'; text: string }
  | { kind: 'act'; id: string; label?: string; status: Activity['status'] }
  | { kind: 'tokens'; tokens: Tokens; isAdded?: boolean }
  | { kind: 'cost'; usd: number; isAdded?: boolean }
  | { kind: 'session'; id: string }
  | { kind: 'credits'; credits: number }
  | { kind: 'copilot-usage'; models?: Record<string, CopilotModelUsage>; credits?: number; creditsStatus?: CopilotModelUsage['aiCreditsStatus']; isAdded?: boolean }
  | { kind: 'error'; text: string }
  | { kind: 'final'; text: string }

type J = Record<string, unknown>
const obj = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export const summarizeCall = (name: string, input: unknown): string => {
  const i = obj(input)
  for (const k of ['command', 'cmd', 'file_path', 'filePath', 'path', 'pattern', 'query', 'url', 'description', 'intent', 'prompt']) {
    const v = i[k]
    if (typeof v === 'string' && v) return `${name} ${v.replace(/\s+/g, ' ')}`
    if (Array.isArray(v) && v.every(x => typeof x === 'string')) return `${name} ${v.join(' ')}`
  }
  return name
}

const tok = (input: number, output: number, cacheRead: number, cacheWrite: number, reasoning = 0): Tokens => ({
  input: Math.max(0, input),
  output,
  cacheRead,
  cacheWrite,
  reasoning,
})

const reportedNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined

const creditsStatus = (v: unknown): CopilotModelUsage['aiCreditsStatus'] =>
  v === 'complete' || v === 'partial' || v === 'unavailable' ? v : undefined

const copilotTokens = (u: J): Tokens =>
  tok(num(u.inputTokens) - num(u.cacheReadTokens) - num(u.cacheWriteTokens), num(u.outputTokens), num(u.cacheReadTokens), num(u.cacheWriteTokens), num(u.reasoningTokens))

/** Checkpoints and shutdowns are cumulative. Never add them to per-call usage. */
const copilotTotals = (d: J): HarnessEvent[] => {
  const snapshot = obj(d.accountingSnapshot)
  const nano = reportedNumber(snapshot.totalNanoAiu ?? d.totalNanoAiu)
  const status = creditsStatus(snapshot.aiCreditsStatus ?? d.aiCreditsStatus) ?? (nano === undefined ? undefined : 'partial')
  const metrics = snapshot.modelMetrics ?? d.modelMetrics
  const models: Record<string, CopilotModelUsage> | undefined = metrics && typeof metrics === 'object' ? {} : undefined
  if (models) for (const [id, value] of Object.entries(obj(metrics))) {
    const m = obj(value)
    const nano = reportedNumber(m.totalNanoAiu)
    const modelStatus = creditsStatus(m.aiCreditsStatus) ?? status
    models[id] = { tokens: copilotTokens(obj(m.usage)), aiCredits: modelStatus === 'unavailable' ? undefined : nano === undefined ? undefined : nano / 1e9, aiCreditsStatus: modelStatus }
  }
  return models || nano !== undefined || status
    ? [{ kind: 'copilot-usage', models, credits: status === 'unavailable' ? undefined : nano === undefined ? undefined : nano / 1e9, creditsStatus: status }]
    : []
}

const copilot = (e: J): HarnessEvent[] => {
  const d = obj(e.data)
  switch (e.type) {
    case 'session.auto_mode_resolved': {
      const out: HarnessEvent[] = str(d.chosenModel) ? [{ kind: 'model', model: d.chosenModel as string }] : []
      if (d.fallback === true) out.push({ kind: 'act', id: 'auto-fallback', label: `Auto fallback: ${str(d.fallbackReason) ?? 'routing failed'} · ${str(d.chosenModel) ?? 'default model'}`, status: 'error' })
      return out
    }
    case 'session.auto_tier_switch_failed':
      return [{ kind: 'act', id: 'auto-tier', label: `Auto profile ${str(d.requestedAutoTier) ?? 'default'} not used: ${str(d.reason) ?? 'unavailable'}${str(d.effectiveAutoTier) ? ` · using ${d.effectiveAutoTier as string}` : ''}`, status: 'error' }]
    case 'session.start':
    case 'session.resume':
      return str(d.sessionId) ? [{ kind: 'session', id: d.sessionId as string }] : []
    case 'assistant.usage': {
      const model = str(d.model)
      if (!model) return []
      const nano = reportedNumber(obj(d.copilotUsage).totalNanoAiu)
      const status = creditsStatus(d.aiCreditsStatus) ?? (nano === undefined ? 'unavailable' : 'complete')
      const credits = status === 'unavailable' || nano === undefined ? undefined : nano / 1e9
      return [{ kind: 'copilot-usage', models: { [model]: { tokens: copilotTokens(d), aiCredits: credits, aiCreditsStatus: status } }, credits, creditsStatus: status, isAdded: true }]
    }
    case 'model.call_start':
      return str(d.model) && d.model !== 'auto' ? [{ kind: 'model', model: d.model as string }] : []
    case 'assistant.message': {
      const out: HarnessEvent[] = []
      if (str(d.model)) out.push({ kind: 'model', model: d.model as string })
      const text = str(d.content)
      if (text) out.push({ kind: 'text', text }, { kind: 'final', text })
      return out
    }
    case 'assistant.reasoning': {
      const text = str(d.content) ?? str(d.text)
      return text ? [{ kind: 'reason', text }] : []
    }
    case 'tool.execution_start': {
      const name = str(d.toolName) ?? 'tool'
      if (name === 'report_intent') return []
      return [{ kind: 'act', id: String(d.toolCallId ?? name), label: summarizeCall(name, d.arguments), status: 'running' }]
    }
    case 'tool.execution_complete':
      return [{ kind: 'act', id: String(d.toolCallId ?? ''), status: d.success === false ? 'error' : 'done' }]
    case 'session.usage_checkpoint':
      return copilotTotals(d)
    case 'agent-deck.usage_error':
      return [
        { kind: 'copilot-usage', creditsStatus: 'unavailable', isAdded: true },
        { kind: 'act', id: 'copilot-usage', label: `Copilot usage unavailable: ${str(d.message) ?? 'could not read usage file'}`, status: 'error' },
      ]
    case 'assistant.fusion_phase_started':
    case 'assistant.fusion_phase_completed':
    case 'assistant.fusion_phase_failed': {
      const out: HarnessEvent[] = []
      if (str(d.model)) out.push({ kind: 'model', model: d.model as string })
      if (str(d.phaseId)) out.push({
        kind: 'act',
        id: `fusion:${String(d.fusionId ?? '')}:${d.phaseId as string}`,
        label: `Fusion ${str(d.role) ?? str(d.phaseKind) ?? 'phase'} · ${str(d.model) ?? 'model'}${e.type === 'assistant.fusion_phase_failed' ? `: ${str(d.errorMessage) ?? str(d.reason) ?? 'phase failed'}` : ''}`,
        status: e.type === 'assistant.fusion_phase_started' ? 'running' : e.type === 'assistant.fusion_phase_failed' || d.status === 'failed' || d.status === 'cancelled' ? 'error' : 'done',
      })
      // Phase usage is also included in assistant.usage and session totals.
      return out
    }
    case 'session.fusion_route_failed': {
      // Copilot answers anyway, on a fallback model; say so, or the run looks like Fusion ran.
      const why = /"message":"([^"]+)"/.exec(str(d.errorMessage) ?? '')?.[1] ?? str(d.reason) ?? 'routing failed'
      const label = `Fusion not used: ${why}${str(d.fallbackModel) ? ` Fell back to ${d.fallbackModel as string}.` : ''}`
      return [{ kind: 'act', id: String(d.attemptId ?? 'fusion'), label, status: 'error' }]
    }
    case 'session.shutdown':
      return [...copilotTotals(d), ...(d.shutdownType === 'error' ? [{ kind: 'error' as const, text: str(d.errorReason) ?? 'Copilot shut down with an error' }] : [])]
    case 'session.error':
      return [{ kind: 'error', text: str(d.message) ?? str(d.errorType) ?? 'Copilot reported an error' }]
    case 'result': {
      const out: HarnessEvent[] = []
      if (str(e.sessionId)) out.push({ kind: 'session', id: e.sessionId as string })
      out.push(...copilotTotals(obj(e.usage)))
      if (typeof e.exitCode === 'number' && e.exitCode !== 0) out.push({ kind: 'error', text: `Copilot exited ${e.exitCode}` })
      return out
    }
  }
  return []
}

const opencode = (e: J): HarnessEvent[] => {
  const out: HarnessEvent[] = []
  if (str(e.sessionID)) out.push({ kind: 'session', id: e.sessionID as string })
  const p = obj(e.part)
  switch (e.type) {
    case 'text': {
      const text = str(p.text)
      if (text) out.push({ kind: 'text', text }, { kind: 'final', text })
      break
    }
    case 'reasoning': {
      const text = str(p.text)
      if (text) out.push({ kind: 'reason', text })
      break
    }
    case 'tool_use': {
      const st = obj(p.state)
      const name = str(p.tool) ?? 'tool'
      const status = st.status === 'completed' ? 'done' : st.status === 'error' ? 'error' : 'running'
      out.push({ kind: 'act', id: String(p.callID ?? p.id ?? name), label: str(st.title) ? `${name} ${st.title}` : summarizeCall(name, st.input), status })
      break
    }
    case 'step_finish': {
      const t = obj(p.tokens)
      const c = obj(t.cache)
      out.push({ kind: 'tokens', tokens: tok(num(t.input), num(t.output), num(c.read), num(c.write), num(t.reasoning)), isAdded: true })
      if (typeof p.cost === 'number' && p.cost > 0) out.push({ kind: 'cost', usd: p.cost, isAdded: true })
      break
    }
    case 'error': {
      const err = obj(e.error)
      out.push({ kind: 'error', text: str(obj(err.data).message) ?? str(err.message) ?? str(err.name) ?? 'OpenCode reported an error' })
      break
    }
  }
  return out
}

const gemini = (e: J): HarnessEvent[] => {
  switch (e.type) {
    case 'init': {
      const out: HarnessEvent[] = []
      if (str(e.session_id)) out.push({ kind: 'session', id: e.session_id as string })
      if (str(e.model)) out.push({ kind: 'model', model: e.model as string })
      return out
    }
    case 'message':
      if (e.role !== 'assistant' || !str(e.content)) return []
      return [{ kind: 'text', text: e.content as string, isDelta: e.delta === true }]
    case 'tool_use': {
      const name = str(e.tool_name) ?? 'tool'
      return [{ kind: 'act', id: String(e.tool_id ?? name), label: summarizeCall(name, e.parameters), status: 'running' }]
    }
    case 'tool_result':
      return [{ kind: 'act', id: String(e.tool_id ?? ''), status: e.status === 'error' ? 'error' : 'done' }]
    case 'error':
      return [{ kind: 'error', text: str(e.message) ?? 'Gemini reported an error' }]
    case 'result': {
      const s = obj(e.stats)
      const out: HarnessEvent[] = []
      const cached = num(s.cached)
      if (s.input_tokens !== undefined || s.output_tokens !== undefined) {
        out.push({ kind: 'tokens', tokens: tok(num(s.input_tokens) - cached, num(s.output_tokens), cached, 0) })
      }
      if (e.status === 'error') out.push({ kind: 'error', text: str(obj(e.error).message) ?? 'Gemini run failed' })
      return out
    }
  }
  return []
}

const contentText = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map(b => obj(b))
        .filter(b => b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text as string)
        .join('')
    : typeof content === 'string'
      ? content
      : ''

const cursor = (e: J): HarnessEvent[] => {
  switch (e.type) {
    case 'system': {
      const out: HarnessEvent[] = []
      if (str(e.model)) out.push({ kind: 'model', model: e.model as string })
      if (str(e.session_id)) out.push({ kind: 'session', id: e.session_id as string })
      return out
    }
    case 'assistant': {
      const text = contentText(obj(e.message).content)
      return text ? [{ kind: 'text', text }] : []
    }
    case 'tool_call': {
      const call = obj(e.tool_call)
      const key = Object.keys(call)[0] ?? 'tool'
      const name = key.replace(/ToolCall$/, '')
      const id = String(e.call_id ?? key)
      if (e.subtype === 'started') return [{ kind: 'act', id, label: summarizeCall(name, obj(call[key]).args), status: 'running' }]
      const isError = Object.keys(obj(obj(call[key]).result)).includes('error')
      return [{ kind: 'act', id, status: isError ? 'error' : 'done' }]
    }
    case 'result': {
      const out: HarnessEvent[] = []
      if (str(e.session_id)) out.push({ kind: 'session', id: e.session_id as string })
      if (str(e.result)) out.push({ kind: 'final', text: e.result as string })
      if (e.is_error) out.push({ kind: 'error', text: str(e.result) ?? 'Cursor run failed' })
      return out
    }
  }
  return []
}

const claude = (e: J): HarnessEvent[] => {
  switch (e.type) {
    case 'system': {
      const out: HarnessEvent[] = []
      if (str(e.model)) out.push({ kind: 'model', model: e.model as string })
      if (str(e.session_id)) out.push({ kind: 'session', id: e.session_id as string })
      return out
    }
    case 'assistant': {
      const m = obj(e.message)
      const out: HarnessEvent[] = []
      if (str(m.model)) out.push({ kind: 'model', model: m.model as string })
      for (const b of Array.isArray(m.content) ? m.content.map(obj) : []) {
        if (b.type === 'text' && str(b.text)) out.push({ kind: 'text', text: b.text as string })
        if (b.type === 'thinking' && str(b.thinking)) out.push({ kind: 'reason', text: b.thinking as string })
        if (b.type === 'tool_use') out.push({ kind: 'act', id: String(b.id), label: summarizeCall(String(b.name), b.input), status: 'running' })
      }
      return out
    }
    case 'user': {
      const content = obj(e.message).content
      return (Array.isArray(content) ? content.map(obj) : [])
        .filter(b => b.type === 'tool_result')
        .map(b => ({ kind: 'act' as const, id: String(b.tool_use_id), status: b.is_error ? ('error' as const) : ('done' as const) }))
    }
    case 'result': {
      const u = obj(e.usage)
      const out: HarnessEvent[] = []
      if (str(e.session_id)) out.push({ kind: 'session', id: e.session_id as string })
      out.push({
        kind: 'tokens',
        tokens: tok(num(u.input_tokens), num(u.output_tokens), num(u.cache_read_input_tokens), num(u.cache_creation_input_tokens)),
      })
      if (typeof e.total_cost_usd === 'number') out.push({ kind: 'cost', usd: e.total_cost_usd })
      if (str(e.result)) out.push({ kind: 'final', text: e.result as string })
      if (e.is_error) out.push({ kind: 'error', text: str(e.result) ?? str(e.subtype) ?? 'Claude run failed' })
      return out
    }
  }
  return []
}

/** `codex exec --json`: thread, items (messages, reasoning, commands, edits, tool calls) and per-turn usage. */
const codex = (e: J): HarnessEvent[] => {
  switch (e.type) {
    case 'thread.started':
      return str(e.thread_id) ? [{ kind: 'session', id: e.thread_id as string }] : []
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const it = obj(e.item)
      const id = String(it.id ?? '')
      const isDone = e.type === 'item.completed'
      switch (it.type) {
        case 'agent_message': {
          const text = isDone ? str(it.text) : undefined
          return text ? [{ kind: 'text', text }, { kind: 'final', text }] : []
        }
        case 'reasoning': {
          const text = isDone ? str(it.text) : undefined
          return text ? [{ kind: 'reason', text }] : []
        }
        case 'command_execution': {
          const cmd = String(it.command ?? '')
          const short = (cmd.match(/(?:-Command|-lc|-c)\s+(['"])([\s\S]*)\1\s*$/)?.[2] ?? cmd).replace(/\s+/g, ' ').trim()
          const failed = it.status === 'failed' || (typeof it.exit_code === 'number' && it.exit_code !== 0)
          return [{ kind: 'act', id, label: `$ ${short}`, status: !isDone ? 'running' : failed ? 'error' : 'done' }]
        }
        case 'file_change': {
          const paths = (Array.isArray(it.changes) ? it.changes : []).map(c => String(obj(c).path ?? '')).filter(Boolean)
          return [{ kind: 'act', id, label: `edit ${paths.join(', ') || 'files'}`, status: !isDone ? 'running' : it.status === 'failed' ? 'error' : 'done' }]
        }
        case 'mcp_tool_call':
          return [{ kind: 'act', id, label: `${String(it.server ?? 'mcp')}.${String(it.tool ?? 'tool')}`, status: !isDone ? 'running' : it.status === 'failed' ? 'error' : 'done' }]
        case 'web_search':
          return [{ kind: 'act', id, label: `search ${String(it.query ?? '')}`.trim(), status: isDone ? 'done' : 'running' }]
      }
      return []
    }
    case 'turn.completed': {
      const u = obj(e.usage)
      const cached = num(u.cached_input_tokens)
      const written = num(u.cache_write_input_tokens)
      return [{ kind: 'tokens', tokens: tok(num(u.input_tokens) - cached - written, num(u.output_tokens), cached, written, num(u.reasoning_output_tokens)), isAdded: true }]
    }
    case 'turn.failed':
      return [{ kind: 'error', text: str(obj(e.error).message) ?? 'Codex turn failed' }]
    case 'error':
      return [{ kind: 'error', text: str(e.message) ?? 'Codex reported an error' }]
  }
  return []
}

const PARSE: Record<Exclude<HarnessParser, 'text'>, (e: J) => HarnessEvent[]> = { codex, copilot, opencode, gemini, cursor, claude }

/** One stdout line of a harness, as the events agent-deck draws. */
export const parseLine = (parser: HarnessParser, line: string): HarnessEvent[] => {
  if (!line.trim()) return []
  if (parser === 'text') return [{ kind: 'text', text: line }]
  if (!line.trimStart().startsWith('{')) return []
  let e: J
  try {
    e = obj(JSON.parse(line))
  } catch {
    return []
  }
  return parser === 'copilot' && e.checkpoint === true ? [] : PARSE[parser](e)
}

// ---------- the card ----------

const MAX_OUTPUT = 6000

const append = (card: AgentCard, text: string) => {
  card.output = (card.output + text).slice(-MAX_OUTPUT)
}

/** Folds one event into a harness card. */
export const applyHarnessEvent = (card: AgentCard, ev: HarnessEvent) => {
  switch (ev.kind) {
    case 'model':
      card.model = ev.model
      break
    case 'text':
      card.isThinking = false
      if (ev.isDelta) append(card, ev.text)
      else append(card, `${card.output && !card.output.endsWith('\n') ? '\n' : ''}${ev.text.trimEnd()}\n`)
      break
    case 'reason':
      append(card, `${ev.text.split('\n').map(l => `∴ ${l}`).join('\n')}\n`)
      break
    case 'act': {
      card.isThinking = ev.status !== 'running'
      const has = card.activity.some(a => a.id === ev.id)
      card.activity = has
        ? card.activity.map(a => (a.id === ev.id ? { ...a, label: ev.label ?? a.label, status: ev.status } : a))
        : [...card.activity, { id: ev.id, label: ev.label ?? 'tool', status: ev.status }].slice(-30)
      break
    }
    case 'tokens':
      if (ev.isAdded) {
        const t = card.tokens
        card.tokens = {
          input: t.input + ev.tokens.input,
          output: t.output + ev.tokens.output,
          cacheRead: t.cacheRead + ev.tokens.cacheRead,
          cacheWrite: t.cacheWrite + ev.tokens.cacheWrite,
          reasoning: t.reasoning + ev.tokens.reasoning,
        }
      } else {
        card.tokens = { ...ev.tokens }
      }
      break
    case 'cost':
      card.costUsd = ev.isAdded ? (card.costUsd ?? 0) + ev.usd : ev.usd
      break
    case 'session':
      card.sessionRef = ev.id
      break
    case 'credits':
      card.aiCredits = ev.credits
      break
    case 'copilot-usage': {
      const mergeStatus = (a: CopilotModelUsage['aiCreditsStatus'], b: CopilotModelUsage['aiCreditsStatus']) =>
        !a ? b : !b || a === b ? a : 'partial'
      if (ev.models) {
        if (!ev.isAdded) card.modelUsage = ev.models
        else {
          card.modelUsage ??= {}
          for (const [id, usage] of Object.entries(ev.models)) {
            const old = card.modelUsage[id]
            card.modelUsage[id] = {
              tokens: old ? sumTokens(old.tokens, usage.tokens) : usage.tokens,
              aiCredits: old?.aiCredits === undefined && usage.aiCredits === undefined ? undefined : (old?.aiCredits ?? 0) + (usage.aiCredits ?? 0),
              aiCreditsStatus: mergeStatus(old?.aiCreditsStatus, usage.aiCreditsStatus),
            }
          }
        }
        card.tokens = Object.values(card.modelUsage).reduce((t, m) => sumTokens(t, m.tokens), tok(0, 0, 0, 0))
      }
      if (ev.credits !== undefined) card.aiCredits = ev.isAdded ? (card.aiCredits ?? 0) + ev.credits : ev.credits
      if (ev.creditsStatus) card.aiCreditsStatus = ev.isAdded ? mergeStatus(card.aiCreditsStatus, ev.creditsStatus) : ev.creditsStatus
      if (card.aiCreditsStatus === 'unavailable') card.aiCredits = undefined
      break
    }
    case 'error':
      card.error = ev.text
      break
    case 'final':
      break
  }
}

const sumTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, reasoning: a.reasoning + b.reasoning,
})

// ---------- the tools ----------

const MAX_HINTED_MODELS = 15

const modelsHint = (h: Harness) => {
  const ids = (h.models ?? []).map(m => m.id)
  if (!ids.length) return ''
  const more = ids.length > MAX_HINTED_MODELS ? ` and ${ids.length - MAX_HINTED_MODELS} more` : ''
  return `, models ${ids.slice(0, MAX_HINTED_MODELS).join(', ')}${more}`
}

export const agentRunSpec = (enabled: readonly Harness[]): ToolSpec => ({
  name: 'agent_run',
  description:
    'Start a task with another coding agent CLI (a harness set up in the Agents pane) in the background; returns at once with a run id. ' +
    'The run is its own process and survives session drops; its live output, model and tokens show in the Agents pane. ' +
    "When it finishes, its final report arrives as a new message: don't poll, sleep or wait for it. agent_result reads a run on demand. " +
    (enabled.length
      ? `Harnesses: ${enabled.map(h => `${h.id} (${h.name}${h.model ? `, default model ${h.model}` : ''}${h.autoTier ? `, Auto profile ${h.autoTier}` : ''}${h.maxAiCredits !== undefined ? `, limit ${h.maxAiCredits} AI credits` : ''}${modelsHint(h)})`).join('; ')}. `
      : 'No harness is enabled yet: the person adds them under ⚙ Settings in the Agents pane. ') +
    'For OpenAI Codex use the codex tool instead. Pass `resume` with a session id from an earlier report to continue that conversation.',
  inputSchema: {
    type: 'object',
    properties: {
      harness: enabled.length
        ? { type: 'string', enum: enabled.map(h => h.id), description: 'Which harness runs the task.' }
        : { type: 'string', description: 'Which harness runs the task.' },
      prompt: { type: 'string', description: 'The task.' },
      title: { type: 'string', description: 'A few words shown on the card.' },
      model: { type: 'string', description: "Model override; the harness's default when unset." },
      autoTier: { type: 'string', description: 'Copilot Auto routing profile, such as efficiency, balance, intelligence, hydrafusion or hydrafusion-max. Requires Auto and account support; not BYOK.' },
      maxAiCredits: { type: 'number', minimum: 30, description: 'Copilot session-wide soft AI credit limit, including subagents. Overrides the harness limit; at least 30.' },
      cwd: { type: 'string', description: 'Working directory; defaults to the session cwd.' },
      resume: { type: 'string', description: "The harness's session id to continue." },
    },
    required: ['harness', 'prompt'],
    additionalProperties: false,
  },
})

export const AGENT_RESULT_SPEC: ToolSpec = {
  name: 'agent_result',
  description: "Read a background agent_run's report (when finished) or its progress so far. Without `id`, lists this session's runs.",
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The run id agent_run returned.' } },
    additionalProperties: false,
  },
}
