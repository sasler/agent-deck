import type { ToolSpec } from 'claude-code'

import type { Activity, AgentCard, Harness, HarnessParser, HarnessProvider, Tokens } from '../types'

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
export const providerEnv = (h: Pick<Harness, 'parser' | 'provider'>, model?: string): Record<string, string> => {
  const p = h.provider
  if (!p?.baseUrl.trim()) return {}
  const env: Record<string, string> = {}
  const put = (k: string, v?: string) => {
    if (v?.trim()) env[k] = v.trim()
  }
  if (h.parser === 'copilot') {
    put('COPILOT_PROVIDER_BASE_URL', p.baseUrl)
    put('COPILOT_PROVIDER_TYPE', p.type)
    put('COPILOT_PROVIDER_API_KEY', p.apiKey)
    if (p.type === 'openai' && p.wireApi === 'responses') put('COPILOT_PROVIDER_WIRE_API', 'responses')
    put('COPILOT_MODEL', model)
  } else if (h.parser === 'claude') {
    put('ANTHROPIC_BASE_URL', p.baseUrl)
    put('ANTHROPIC_API_KEY', p.apiKey)
    put('ANTHROPIC_MODEL', model)
  }
  return env
}

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
  if (h.provider) {
    const types = providerTypesFor(h.parser)
    if (!types.length) return 'Only Copilot and Claude Code output can run against your own API; switch the API off or pick that output.'
    if (!types.includes(h.provider.type)) return `This CLI takes an ${types.join(' or ')} API, not ${h.provider.type}.`
    if (!/^https?:\/\/\S+$/.test(h.provider.baseUrl.trim())) return "Give the API's base URL, starting with http:// or https://."
    if (h.parser === 'copilot' && !h.model?.trim()) return 'Set the default model to the id your API expects; Copilot needs one with its own API.'
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
  | { kind: 'premium'; count: number }
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

const copilot = (e: J): HarnessEvent[] => {
  const d = obj(e.data)
  switch (e.type) {
    case 'session.auto_mode_resolved':
      return str(d.chosenModel) ? [{ kind: 'model', model: d.chosenModel as string }] : []
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
    case 'session.usage_checkpoint': {
      const metrics = obj(obj(d.accountingSnapshot).modelMetrics)
      const t = tok(0, 0, 0, 0)
      for (const m of Object.values(metrics)) {
        const u = obj(obj(m).usage)
        t.cacheRead += num(u.cacheReadTokens)
        t.cacheWrite += num(u.cacheWriteTokens)
        t.input += num(u.inputTokens) - num(u.cacheReadTokens) - num(u.cacheWriteTokens)
        t.output += num(u.outputTokens)
        t.reasoning += num(u.reasoningTokens)
      }
      const out: HarnessEvent[] = [{ kind: 'tokens', tokens: { ...t, input: Math.max(0, t.input) } }]
      if (typeof d.totalPremiumRequests === 'number') out.push({ kind: 'premium', count: d.totalPremiumRequests })
      return out
    }
    case 'session.error':
      return [{ kind: 'error', text: str(d.message) ?? str(d.errorType) ?? 'Copilot reported an error' }]
    case 'result': {
      const out: HarnessEvent[] = []
      if (str(e.sessionId)) out.push({ kind: 'session', id: e.sessionId as string })
      const premium = obj(e.usage).premiumRequests
      if (typeof premium === 'number') out.push({ kind: 'premium', count: premium })
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
  return PARSE[parser](e)
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
    case 'premium':
      card.premiumRequests = ev.count
      break
    case 'error':
      card.error = ev.text
      break
    case 'final':
      break
  }
}

// ---------- the tools ----------

export const agentRunSpec = (enabled: readonly Harness[]): ToolSpec => ({
  name: 'agent_run',
  isDeferred: false,
  description:
    'Start a task with another coding agent CLI (a harness set up in the Agents pane) in the background; returns at once with a run id. ' +
    'The run is its own process and survives session drops; its live output, model and tokens show in the Agents pane. ' +
    "When it finishes, its final report arrives as a new message: don't poll, sleep or wait for it. agent_result reads a run on demand. " +
    (enabled.length
      ? `Harnesses: ${enabled.map(h => `${h.id} (${h.name}${h.model ? `, default model ${h.model}` : ''})`).join('; ')}. `
      : 'No harness is enabled yet: the person adds them under ⚙ Harnesses in the Agents pane. ') +
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
      cwd: { type: 'string', description: 'Working directory; defaults to the session cwd.' },
      resume: { type: 'string', description: "The harness's session id to continue." },
    },
    required: ['harness', 'prompt'],
    additionalProperties: false,
  },
})

export const AGENT_RESULT_SPEC: ToolSpec = {
  name: 'agent_result',
  isDeferred: false,
  description: "Read a background agent_run's report (when finished) or its progress so far. Without `id`, lists this session's runs.",
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The run id agent_run returned.' } },
    additionalProperties: false,
  },
}
