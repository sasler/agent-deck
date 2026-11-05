import { expect, mock, test } from 'claude-code/testing'

import {
  applyStrataRecord,
  applyToCard,
  barSvg,
  claudeLimits,
  copilotLimits,
  fmtCredits,
  isMeterShown,
  cacheHitPercent,
  clip,
  codexArgs,
  costOf,
  keepWarmValue,
  newCodexCard,
  newStrataCard,
  parseCodexConfig,
  shortCommand,
  strataTitle,
  toLimitWindows,
} from '../hooks/register'
import { cacheView, fmtDuration, freshCache, isCold, parseDuration, ttlFor, isGatewayUrl } from '../hooks/cache'
import { PRESETS, agentRunSpec, applyHarnessEvent, copilotOptionsError, expandArgs, fromPreset, harnessArgs, harnessCommand, harnessError, modelQuery, parseLine, parseModels, providerEnv, slugId, tokenizeArgs, withFusion } from '../hooks/harness'
import type { AgentCard } from '../types'

test('builds codex exec arguments for new and resumed runs', async () => {
  const base = { id: 'r1', title: 't', cwd: 'C:/p', sessionId: 's', startedAt: 0 }
  expect(codexArgs({ ...base, effort: 'low', sandbox: 'read-only' }, 'C:\\runs\\r1\\last.txt')).toEqual([
    'exec', '--json', '--skip-git-repo-check', '-c', 'model_reasoning_effort=low', '-c', 'sandbox_mode=read-only',
    '-o', 'C:\\runs\\r1\\last.txt', '-',
  ])
  expect(codexArgs({ ...base, resume: 'thread-9', model: 'gpt-x' }, 'last.txt')).toEqual([
    'exec', 'resume', '--json', '--skip-git-repo-check', '-m', 'gpt-x', '-o', 'last.txt', 'thread-9', '-',
  ])
})

test('watcher events build an external Codex card', async () => {
  const card = newCodexCard('codex-thread-ext', 'Codex', 0, { threadId: 'thread-ext', isExternal: true })
  const f = 'thread-ext'
  applyToCard(card, { t: 'meta', f, ts: 1000, cwd: 'C:/src/project' })
  applyToCard(card, { t: 'prompt', f, ts: 1001, text: 'Refresh the cheat panel\nmore detail' })
  applyToCard(card, { t: 'ctx', f, ts: 1002, model: 'gpt-6.1-sol', effort: 'high' })
  applyToCard(card, { t: 'act', f, ts: 1003, id: 'a1', label: '$ git status', status: 'running' })
  applyToCard(card, { t: 'act', f, ts: 1004, id: 'a1', label: '$ git status', status: 'done' })
  applyToCard(card, { t: 'msg', f, ts: 1005, text: 'All tests pass.' })
  applyToCard(card, { t: 'tok', f, ts: 1006, tokens: { input: 100, cacheRead: 900, cacheWrite: 0, output: 50, reasoning: 0 } })
  applyToCard(card, { t: 'task', f, ts: 2000, state: 'done' })

  expect(card.title).toBe('Refresh the cheat panel')
  expect([card.model, card.effort]).toEqual(['gpt-6.1-sol', 'high'])
  expect(card.activity).toEqual([{ id: 'a1', label: '$ git status', status: 'done' }])
  expect(card.output).toBe('All tests pass.\n')
  expect(card.tokens.cacheRead).toBe(900)
  expect([card.status, card.startedAt, card.endedAt]).toEqual(['done', 1000, 2000])
})

test("a run's card is finished by its exit file, not by the rollout", async () => {
  const card = newCodexCard('codex-run-r1', 'mine', 0, { runId: 'r1' })
  applyToCard(card, { t: 'task', f: 't', ts: 5, state: 'done' })
  expect(card.status).toBe('running')
})

test('agent-deck tools stay visible without changing other tools', async ($, on) => {
  on('tool.describe', (_$, e) => ({ description: e.description, isDeferred: true }))
  const provider = { plugin: 'agent-deck', tier: 'user' } as const
  for (const name of ['codex', 'codex_result', 'agent_run', 'agent_result']) {
    const result = await $.tool.describe({ tool: `mcp__agent-deck__${name}`, description: name, isDeferred: true, provider })
    expect(result).toEqual({ description: name, isDeferred: false })
  }
  const other = await $.tool.describe({ tool: 'Bash', description: 'other', isDeferred: true, provider })
  expect(other.isDeferred).toBe(true)
})

test('converts Codex rate-limit windows to labels', async () => {
  expect(toLimitWindows({ windows: [{ minutes: 300, percent: 12 }, { minutes: 10080, percent: 29 }] })).toEqual([
    { label: '5h', percent: 12, resetsAt: undefined },
    { label: '7d', percent: 29, resetsAt: undefined },
  ])
})

test('reads top-level defaults from config.toml', async () => {
  const cfg = parseCodexConfig('model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n[profiles.x]\nmodel = "other"\n')
  expect(cfg).toEqual({ model: 'gpt-6.1-sol', effort: 'high' })
})

test('strips the shell wrapper from Codex commands', async () => {
  expect(shortCommand(`"C:\\pwsh.exe" -NoProfile -Command 'echo hi'`)).toBe('echo hi')
  expect(shortCommand(`/bin/bash -lc 'ls -la'`)).toBe('ls -la')
})

test('estimates Claude cost per model', async () => {
  const t = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }
  expect(costOf('claude-sonnet-5-5', t)).toBe(12)
  expect(costOf('claude-haiku-5-5', t)).toBe(0.6)
  expect(costOf('gpt-6.1-sol', t)).toBe(undefined)
})

test('a Claude subagent gets a card in the Agents pane', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'agent-1' }))
  await $.agent.spawn({
    tool_use_id: 'tool-1', prompt: 'look around', description: 'scan repo', subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-sonnet-5-5', background: true, fork: false,
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-deck',
      surface,
      component: 'Pane',
      requestId: 'agent-deck',
      props: { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
      viewport: { columns: 80, rows: 30 },
    })
    expect(await ui.find({ text: /Explore · scan repo/ })).toBeDefined()
    expect(await ui.find({ text: /CLAUDE/ })).toBeDefined()
    expect(await ui.find({ text: /claude-haiku-5-5/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the pane says so when there are no agents', async ($, on) => {
  mock.clock(on)
  const ui = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'agent-deck',
    props: { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect(await ui.find({ text: /No subagents yet/ })).toBeDefined()
})


test('the band above the prompt offers an Agents button', async ($, on) => {
  mock.clock(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-deck',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} },
    })
    expect(await ui.find({ key: 'agent-deck-open' })).toBeDefined()
    expect(await ui.find({ text: /no agents running/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a held cold send goes out from the band with Send anyway', async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 30, 12) })
  mock.store(on)
  on('session.id', () => ({ value: 'sid-held' }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as { text?: string }).text ?? e))
    return { value: undefined } as never
  })
  on('env.get', () => ({ value: undefined }))
  on('classic.SessionStart', () => ({}) as never)
  const sent: string[] = []
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  await $.classic.SessionStart({ source: 'resume', context_tokens: 197_817, seconds_since_last_response: 3 * 3600, model: 'claude-opus-5-5' } as never)
  const first = await $.prompt.submit({ text: 'fix the parser', wait: false, origin: { kind: 'composer' } })
  expect(first.drop).toMatch(/Send anyway/)
  expect(sent).toEqual([])

  const ui = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  })
  expect(await ui.find({ text: /Held: “fix the parser”/ })).toBeDefined()
  await ui.press({ key: 'held-send' })
  await ui.redraw()
  expect(sent).toEqual(['fix the parser'])
  expect(await ui.find({ key: 'held-send' })).toBeUndefined()
  expect(await ui.find({ text: /✓ Sent “fix the parser” · re-writing 198k tokens/ })).toBeDefined()
  expect(toasts.join(' ')).toMatch(/sent\. Re-writing/)
  await ui.unmount()
})

test('the cache reads its TTL from the merged settings object', async ($, on) => {
  mock.clock(on)
  mock.store(on, { harnesses: [] })
  on('session.id', () => ({ value: 'sid-ttl' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: { promptCacheTtl: '5m' } }))
  await $.session.start({ cwd: 'C:\\project', surface: 'desktop', isInteractive: true })
  const result = await $.command.run({ command: 'cache', args: 'status', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(result.text).toMatch(/5m cache/)
})

test('a Strata request becomes a live card, then a finished one', async () => {
  const input = JSON.stringify({
    model: 'strata-qwen-coder',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '<system-reminder>ctx</system-reminder>\nFix the login bug\nmore' }] },
    ],
  })
  expect(strataTitle(input)).toBe('Fix the login bug')
  expect(strataTitle(undefined)).toBe('Strata request')

  const card = newStrataCard({ id: 'abc', path: '/v1/messages', model: 'strata-qwen-coder', started_at: 10, input })
  expect([card.id, card.provider, card.model, card.startedAt]).toEqual(['strata-abc', 'strata', 'strata-qwen-coder · Anthropic API', 10000])

  applyStrataRecord(card, { id: 'abc', state: 'generating', reasoning: 'think', output: 'Hel' })
  expect([card.status, card.output, card.isThinking]).toEqual(['running', '∴ think\nHel', false])
  expect(card.activity).toEqual([{ id: 'state', label: 'generating', status: 'running' }])

  applyStrataRecord(card, {
    id: 'abc', state: 'completed', finished_at: 12.5, output: 'Hello', usage: { input_tokens: 21, output_tokens: 6 },
  })
  expect([card.status, card.endedAt, card.output, card.tokens.input, card.tokens.output]).toEqual(['done', 12500, 'Hello', 21, 6])
  expect(card.activity).toEqual([])
})

test('cache view: warm, cold and unknown', async () => {
  const s = { ...freshCache('sid'), model: 'claude-opus-5-5', ctx: 200_000 }
  expect(cacheView(s, 1000).tone).toBe('unknown')
  const warm = cacheView({ ...s, lastRequestAt: 0 + 1 }, 20 * 60_000)
  expect([warm.tone, warm.label]).toEqual(['warm', 'warm · 40m left'])
  const cold = cacheView({ ...s, lastRequestAt: 1 }, 90 * 60_000)
  expect([cold.tone, cold.label]).toEqual(['cold', 'cold · 30m ago'])
  // Opus 5.5: 1h write at $8/MTok, read at $0.20/MTok.
  expect([cold.coldUsd, cold.warmUsd]).toEqual([1.6, 0.04])
  expect(isCold({ ...s, lastRequestAt: 1, isReset: true }, 90 * 60_000)).toBe(false)
  const kw = cacheView({ ...s, lastRequestAt: 1, deadline: 2 * 3_600_000 }, 20 * 60_000)
  expect(kw.keepwarm?.next).toBe('next ping in 30m')
})

test('parses keep-warm windows and clips titles', async () => {
  expect([parseDuration('90m'), parseDuration('2h'), parseDuration('1h30m'), parseDuration('x'), parseDuration('0m')]).toEqual([
    5_400_000, 7_200_000, 5_400_000, undefined, undefined,
  ])
  expect(fmtDuration(125 * 60_000)).toBe('2h05m')
  expect(clip('Build Display and Graphics settings', 12)).toBe('Build Displ…')
  expect(clip('short', 12)).toBe('short')
  expect(cacheHitPercent({ input: 50, cacheRead: 150, cacheWrite: 0, output: 9, reasoning: 0 })).toBe(75)
})

test('a long title wraps on its own line on an open card', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-long' }))
  await $.agent.spawn({
    prompt: 'x',
    description: 'Build Display and Graphics settings for the station glass cockpit panes',
    subagentType: 'general-purpose',
  } as never)
  const mount = () =>
    $.ui.mount({
      plugin: 'agent-deck',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'agent-deck',
      props: { title: 'Agents', isFocused: false, bodyColumns: 44, placement: 'dock' } as never,
      viewport: { columns: 160, rows: 40 },
    })
  const ui = await mount()
  const leaf = async () => {
    const found = await ui.findAll({ text: /general-purpose · Build/ })
    return found[found.length - 1]?.text
  }
  expect(await leaf()).toBe('general-purpose · Build Display and Graphics settings for the station glass cockpit panes')
  expect(await ui.find({ text: /◆ claude-sonnet-5-5/ })).toBeDefined()
  await ui.unmount()
})

test('the pane arms and stops keep-warm', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('session.id', () => ({ value: 'sid-1' }))
  const ui = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'agent-deck',
    props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock' } as never,
  })
  expect(await ui.find({ text: /Prompt cache/ })).toBeDefined()
  expect(await ui.find({ text: /keep-warm off/ })).toBeDefined()
  await ui.select({ key: 'kw-window', value: '4' })
  await ui.redraw()
  expect(await ui.find({ text: /keep-warm 4h00m/ })).toBeDefined()
  await ui.select({ key: 'kw-window', value: 'off' })
  await ui.redraw()
  expect(await ui.find({ text: /keep-warm off/ })).toBeDefined()
  await ui.unmount()
})

test('keep-warm picker shows the window that holds what is left', () => {
  expect(keepWarmValue(undefined)).toBe('off')
  expect(keepWarmValue(110 * 60_000)).toBe('2')
  expect(keepWarmValue(3 * 3_600_000)).toBe('4')
  expect(keepWarmValue(5.5 * 3_600_000)).toBe('6')
})

test('mobile, without a Select, keeps the keep-warm buttons', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('session.id', () => ({ value: 'sid-1' }))
  const ui = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'mobile',
    component: 'Pane',
    requestId: 'agent-deck',
    props: { title: 'Agents', isFocused: false, bodyColumns: 40, placement: 'dock' } as never,
  })
  await ui.press({ key: 'kw-2h' } as never)
  await ui.redraw()
  expect(await ui.find({ text: /keep-warm 2h00m/ })).toBeDefined()
  await ui.press({ key: 'kw-stop' } as never)
  await ui.redraw()
  expect(await ui.find({ text: /keep-warm off/ })).toBeDefined()
  await ui.unmount()
})

test('harness args: placeholders fill in, empty ones drop their flag', () => {
  expect(tokenizeArgs(`-p {prompt} --title "two words" ''`)).toEqual(['-p', '{prompt}', '--title', 'two words', ''])
  const copilot = PRESETS.find(p => p.id === 'copilot')!
  expect(expandArgs(copilot.args, { prompt: 'fix it\nnow' })).toEqual(['-p', 'fix it\nnow', '--output-format', 'json', '--allow-all-tools'])
  expect(expandArgs(copilot.args, { prompt: 'x', model: 'gpt-6.1', session: 's1' })).toEqual([
    '-p', 'x', '--output-format', 'json', '--allow-all-tools', '--model', 'gpt-6.1', '--resume', 's1',
  ])
  expect(expandArgs('run --model={model} {prompt}', { prompt: 'x' })).toEqual(['run', 'x'])
  expect(expandArgs('--dry-run --model={model} {prompt}', { prompt: 'x' })).toEqual(['--dry-run', 'x'])
  expect(expandArgs('-p {prompt} --resume {session}', { prompt: 'x' })).toEqual(['-p', 'x'])
})

test('harness edits are checked', () => {
  const h = fromPreset(PRESETS.find(p => p.id === 'copilot')!)
  expect(harnessError(h, [])).toBeUndefined()
  expect(harnessError(h, [h])).toMatch(/already has the id/)
  expect(harnessError({ ...h, id: 'codex' }, [])).toMatch(/built-in/)
  expect(harnessError({ ...h, args: '-p' }, [])).toMatch(/\{prompt\}/)
  expect(harnessError({ ...h, command: 'copilot -p' }, [])).toMatch(/one word/)
  expect(fromPreset(PRESETS.find(p => p.id === 'copilot')!, ['copilot']).id).toBe('copilot-2')
  expect(slugId('My Agent!')).toBe('my-agent')
})

test('Copilot routing and limits use current flags, also with old saved templates', () => {
  const h = fromPreset(PRESETS.find(p => p.id === 'copilot')!)
  expect(harnessArgs(h, { prompt: 'fix %PATH% and "$x"', model: 'hydrafusion' })).toEqual([
    '-p', 'fix %PATH% and "$x"', '--output-format', 'json', '--allow-all-tools', '--model', 'auto', '--auto-tier', 'hydrafusion', '--experimental', '--secret-env-vars=COPILOT_PROVIDER_API_KEY',
  ])
  expect(harnessArgs({ ...h, model: 'auto', autoTier: 'balance', maxAiCredits: 30 }, { prompt: 'x', autoTier: 'intelligence', maxAiCredits: 60 })).toEqual([
    '-p', 'x', '--output-format', 'json', '--allow-all-tools', '--model', 'auto', '--auto-tier', 'intelligence', '--max-ai-credits', '60', '--secret-env-vars=COPILOT_PROVIDER_API_KEY',
  ])
  expect(harnessArgs({ ...h, args: '-p {prompt}' }, { prompt: 'x', autoTier: 'hydrafusion-max' })).toEqual([
    '-p', 'x', '--model', 'auto', '--auto-tier', 'hydrafusion-max', '--experimental', '--secret-env-vars=COPILOT_PROVIDER_API_KEY',
  ])
  expect(copilotOptionsError(h, { maxAiCredits: 29 })).toMatch(/at least 30/)
  expect(copilotOptionsError(h, { maxAiCredits: NaN })).toMatch(/at least 30/)
  expect(copilotOptionsError(h, { maxAiCredits: Infinity })).toMatch(/at least 30/)
  expect(copilotOptionsError(h, { autoTier: 'two words' })).toMatch(/without spaces/)
  expect(copilotOptionsError({ ...h, model: 'gpt-5.4', autoTier: 'balance' })).toMatch(/Pick Auto/)
  expect(copilotOptionsError({ ...h, parser: 'claude' }, { autoTier: 'balance' })).toMatch(/Copilot harness/)
  expect(copilotOptionsError({ ...h, provider: { type: 'openai', baseUrl: 'http://localhost/v1' } }, { model: 'auto' })).toMatch(/not your own API/)
  expect(copilotOptionsError(h, { autoTier: 'future-profile', maxAiCredits: 30.5 })).toBeUndefined()
  const other = { ...fromPreset(PRESETS.find(p => p.id === 'opencode')!), model: 'hydrafusion' }
  expect(copilotOptionsError(other)).toBeUndefined()
  expect(harnessArgs(other, { prompt: 'x' })).toEqual(['run', '--format', 'json', '--model', 'hydrafusion', 'x'])
})

test('Copilot run overrides replace routing flags without changing option-shaped prompts', () => {
  const h = { ...fromPreset(PRESETS.find(p => p.id === 'copilot')!), model: 'auto', autoTier: 'balance', maxAiCredits: 30 }
  expect(harnessArgs(h, { prompt: '--model', model: 'gpt-4' })).toEqual([
    '--prompt=--model', '--output-format', 'json', '--allow-all-tools', '--model', 'gpt-4', '--max-ai-credits', '30', '--secret-env-vars=COPILOT_PROVIDER_API_KEY',
  ])
  expect(harnessArgs({ ...h, model: 'gpt-4', autoTier: undefined }, { prompt: '--usage-output-file=not-a-flag', autoTier: 'hydrafusion', usageFile: 'C:\\runs\\usage.json' })).toEqual([
    '--prompt=--usage-output-file=not-a-flag', '--output-format', 'json', '--allow-all-tools', '--model', 'auto', '--auto-tier', 'hydrafusion', '--experimental', '--max-ai-credits', '30', '--secret-env-vars=COPILOT_PROVIDER_API_KEY', '--usage-output-file', 'C:\\runs\\usage.json',
  ])
  expect(harnessArgs({ ...h, args: '--prompt {prompt}' }, { prompt: '-x', model: 'gpt-4' })).toEqual([
    '--prompt=-x', '--model', 'gpt-4', '--max-ai-credits', '30', '--secret-env-vars=COPILOT_PROVIDER_API_KEY',
  ])
  const custom = { ...h, args: '-p {prompt} --model gpt-4 --auto-tier=efficiency --max-ai-credits 90 --no-experimental' }
  expect(harnessArgs(custom, { prompt: 'x', autoTier: 'hydrafusion', maxAiCredits: 30 })).toEqual([
    '-p', 'x', '--model', 'auto', '--auto-tier', 'hydrafusion', '--max-ai-credits', '30', '--experimental', '--secret-env-vars=COPILOT_PROVIDER_API_KEY',
  ])
  expect(copilotOptionsError(h, { model: 'gpt-4', autoTier: 'balance' })).toMatch(/Pick Auto/)
  expect(harnessArgs({ ...h, args: '-p {prompt} --usage-output-file=custom.json' }, { prompt: 'x', usageFile: 'ignored.json' }).filter(a => a.startsWith('--usage-output-file'))).toEqual(['--usage-output-file=custom.json'])
  expect(harnessArgs(custom, { prompt: 'x', model: 'gpt-4' })).toEqual([
    '-p', 'x', '--model', 'gpt-4', '--max-ai-credits', '30', '--no-experimental', '--secret-env-vars=COPILOT_PROVIDER_API_KEY',
  ])
  expect(harnessCommand(h, { prompt: '--usage-output-file=not-a-flag', usageFile: 'C:\\runs\\usage.json' }).usageFile).toBe('C:\\runs\\usage.json')
  expect(harnessCommand({ ...h, args: '-p {prompt} --usage-output-file={cwd}/custom.json' }, { prompt: '--usage-output-file', cwd: 'C:\\project', usageFile: 'ignored.json' }).usageFile).toBe('C:\\project/custom.json')
  expect(harnessCommand({ ...h, args: '-p {prompt} --usage-output-file first.json --usage-output-file=second.json' }, { prompt: 'x', usageFile: 'ignored.json' }).usageFile).toBe('second.json')
})

test('Copilot BYOK supports deployment mapping and Responses transport without exposing keys in argv', () => {
  const h = {
    ...fromPreset(PRESETS.find(p => p.id === 'copilot-api')!),
    model: 'gpt-5.4',
    provider: { type: 'azure' as const, baseUrl: 'https://resource.openai.azure.com', apiKey: 'test-key', wireApi: 'responses' as const, transport: 'websockets' as const, modelId: 'gpt-5.4', wireModel: 'my-deployment' },
  }
  expect(harnessError(h, [])).toBeUndefined()
  expect(providerEnv(h, h.model)).toEqual({
    COPILOT_PROVIDER_BASE_URL: 'https://resource.openai.azure.com',
    COPILOT_PROVIDER_TYPE: 'azure',
    COPILOT_PROVIDER_API_KEY: 'test-key',
    COPILOT_PROVIDER_WIRE_API: 'responses',
    COPILOT_PROVIDER_TRANSPORT: 'websockets',
    COPILOT_PROVIDER_MODEL_ID: 'gpt-5.4',
    COPILOT_PROVIDER_WIRE_MODEL: 'my-deployment',
    COPILOT_MODEL: 'gpt-5.4',
  })
  expect(harnessArgs(h, { prompt: 'x' }).includes('test-key')).toBe(false)
  expect(harnessArgs(h, { prompt: 'x' }).includes('--secret-env-vars=COPILOT_PROVIDER_API_KEY')).toBe(true)
  expect(harnessArgs({ ...h, args: '-p {prompt} --secret-env-vars=OTHER_KEY' }, { prompt: 'x' })).toEqual([
    '-p', 'x', '--secret-env-vars=OTHER_KEY,COPILOT_PROVIDER_API_KEY',
  ])
  expect(harnessArgs({ ...h, args: '-p {prompt} --secret-env-vars=COPILOT_PROVIDER_API_KEY --secret-env-vars OTHER_KEY' }, { prompt: 'x' })).toEqual([
    '-p', 'x', '--secret-env-vars=COPILOT_PROVIDER_API_KEY', '--secret-env-vars', 'OTHER_KEY,COPILOT_PROVIDER_API_KEY',
  ])
  expect(providerEnv(h, 'other-model')).toEqual({
    COPILOT_PROVIDER_BASE_URL: 'https://resource.openai.azure.com',
    COPILOT_PROVIDER_TYPE: 'azure',
    COPILOT_PROVIDER_API_KEY: 'test-key',
    COPILOT_PROVIDER_WIRE_API: 'responses',
    COPILOT_PROVIDER_TRANSPORT: 'websockets',
    COPILOT_MODEL: 'other-model',
  })
  expect(harnessError({ ...h, provider: { ...h.provider, wireApi: 'completions' } }, [])).toMatch(/WebSockets/)
})

test('a harness on its own API gets the env its CLI reads, and is checked', () => {
  const byok = fromPreset(PRESETS.find(p => p.id === 'copilot-api')!)
  expect(harnessError(byok, [])).toMatch(/base URL/)
  const h = { ...byok, model: 'qwen3-coder', provider: { type: 'openai' as const, baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-test', wireApi: 'responses' as const } }
  expect(harnessError(h, [])).toBeUndefined()
  expect(harnessError({ ...h, model: undefined }, [])).toMatch(/default model/)
  expect(providerEnv(h, 'qwen3-coder')).toEqual({
    COPILOT_PROVIDER_BASE_URL: 'https://openrouter.ai/api/v1',
    COPILOT_PROVIDER_TYPE: 'openai',
    COPILOT_PROVIDER_API_KEY: 'sk-test',
    COPILOT_PROVIDER_WIRE_API: 'responses',
    COPILOT_MODEL: 'qwen3-coder',
  })
  const anthropic = { ...h, provider: { type: 'anthropic' as const, baseUrl: 'https://api.anthropic.com/v1/', apiKey: 'k' } }
  expect(providerEnv(anthropic, h.model).COPILOT_PROVIDER_BASE_URL).toBe('https://api.anthropic.com')
  expect(providerEnv({ ...anthropic, provider: { ...anthropic.provider, baseUrl: 'https://example.com/gateway/v1' } }, h.model).COPILOT_PROVIDER_BASE_URL).toBe('https://example.com/gateway')
  expect(providerEnv({ ...anthropic, provider: { ...anthropic.provider, baseUrl: 'http://v1' } }, h.model).COPILOT_PROVIDER_BASE_URL).toBe('http://v1')
  const claude = { ...fromPreset(PRESETS.find(p => p.id === 'claude-cli')!), provider: { type: 'anthropic' as const, baseUrl: 'https://gw.example.com', apiKey: 'k' } }
  expect(harnessError(claude, [])).toBeUndefined()
  expect(providerEnv(claude)).toEqual({ ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_API_KEY: 'k' })
  expect(harnessError({ ...claude, provider: { ...claude.provider, type: 'openai' } }, [])).toMatch(/takes an anthropic API/)
  const gemini = { ...fromPreset(PRESETS.find(p => p.id === 'gemini')!), provider: claude.provider }
  expect(harnessError(gemini, [])).toMatch(/Only Copilot and Claude Code/)
  expect(providerEnv(fromPreset(PRESETS.find(p => p.id === 'copilot')!))).toEqual({})
})

test('the edit form sets up a Copilot on its own API', async ($, on) => {
  mock.clock(on)
  mock.store(on, { harnesses: [] })
  on('session.id', () => ({ value: 'sid-1' }))
  on('env.get', () => ({ value: undefined }))
  const ui = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'agent-deck',
    props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock' } as never,
  })
  // Settings has a visible label as well as a gear.
  const gear = (await ui.findAll({ type: 'Button' } as never)).find(b => (b as { key?: string }).key === 'h-open') as { text?: string; props?: { label?: string } } | undefined
  expect(gear?.text).toBe('⚙ Settings')
  expect(gear?.props?.label).toBe('⚙ Settings')
  await ui.press({ key: 'h-open' } as never)
  await ui.redraw()
  expect(await ui.find({ text: 'Settings' })).toBeDefined()
  await ui.select({ key: 'h-add', value: 'copilot-api' })
  await ui.redraw()
  expect(await ui.find({ text: /BYOK/ })).toBeDefined()
  await ui.press({ key: 'h-save' } as never)
  await ui.redraw()
  expect(await ui.find({ text: /base URL/ })).toBeDefined()
  await ui.input({ key: 'h-provider-url', text: 'http://127.0.0.1:11434/v1/', kind: 'change' })
  await ui.input({ key: 'h-provider-key', text: 'sk-test', kind: 'change' })
  await ui.input({ key: 'h-provider-model-id', text: 'gpt-5.4', kind: 'change' })
  await ui.input({ key: 'h-provider-wire-model', text: 'my-deployment', kind: 'change' })
  await ui.select({ key: 'h-provider-wire', value: 'responses' })
  await ui.redraw()
  await ui.select({ key: 'h-provider-transport', value: 'websockets' })
  await ui.input({ key: 'h-model', text: 'qwen3-coder', kind: 'change' })
  await ui.redraw()
  expect(await ui.find({ text: /against http:\/\/127\.0\.0\.1:11434/ })).toBeDefined()
  await ui.press({ key: 'h-save' } as never)
  await ui.redraw()
  expect(await ui.find({ text: /copilot · Copilot JSON · qwen3-coder · API http:\/\/127\.0\.0\.1:11434\/v1$/ })).toBeDefined()
  await ui.press({ key: 'h-edit-copilot-api' } as never)
  await ui.redraw()
  expect((await ui.find({ key: 'h-provider-model-id' }))?.props.value).toBe('gpt-5.4')
  expect((await ui.find({ key: 'h-provider-wire-model' }))?.props.value).toBe('my-deployment')
  expect((await ui.find({ key: 'h-provider-transport' }))?.props.value).toBe('websockets')
  await ui.select({ key: 'h-provider-type', value: '' })
  await ui.redraw()
  expect(await ui.find({ key: 'h-provider-url' } as never)).toBeUndefined()
  await ui.unmount()
})

test('failed runner and model-query starts clear temporary credentials', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  const harness = {
    ...fromPreset(PRESETS.find(p => p.id === 'copilot')!),
    model: 'gpt-4',
    provider: { type: 'openai' as const, baseUrl: 'https://api.example.com/v1', apiKey: 'fixture-key' },
  }
  mock.store(on, { harnesses: [harness], 'codex-enabled': false })
  on('session.id', () => ({ value: 'secret-session' }))
  on('session.cwd', () => ({ value: 'project' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'test-home' : undefined }))
  const files = new Map<string, string>()
  const writes: { path: string; text: string }[] = []
  let denyClear: 'env' | 'query' | undefined
  let deniedClears = 0
  on('fs.write', (_$, e) => {
    const path = e.path.replace(/\\/g, '/')
    if (!e.text && (denyClear === 'env' && path.endsWith('/env.json') || denyClear === 'query' && /\/models-[^/]+\.json$/.test(path))) {
      deniedClears++
      return { deny: 'access denied' }
    }
    files.set(path, e.text)
    writes.push({ path, text: e.text })
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: files.has(e.path.replace(/\\/g, '/')) }))
  on('fs.read', (_$, e) => {
    const text = files.get(e.path.replace(/\\/g, '/'))
    return text === undefined ? { deny: 'not found' } : { value: text }
  })
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'node not found', isStdoutTruncated: false, isStderrTruncated: false } }))
  await $.session.start({ cwd: 'project', surface: 'desktop', isInteractive: true })

  const run = async () => {
    try {
      return JSON.stringify(await $.tool.call({ tool: 'mcp__agent-deck__agent_run', tool_use_id: 'start-1', harness: 'copilot', prompt: 'test' }))
    } catch (error) {
      return String(error)
    }
  }
  expect(await run()).toMatch(/HooksError/)
  const env = writes.find(write => write.path.endsWith('/env.json') && write.text.includes('fixture-key'))
  expect(env).toBeDefined()
  expect(files.get(env!.path)).toBe('')

  denyClear = 'env'
  expect(await run()).toMatch(/HooksError/)
  expect(deniedClears).toBe(1)
  denyClear = undefined

  const ui = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'agent-deck',
    props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock' } as never,
  })
  await ui.press({ key: 'h-open' } as never)
  await ui.press({ key: 'h-edit-copilot' } as never)
  await ui.redraw()
  const query = writes.find(write => /\/models-[^/]+\.json$/.test(write.path) && write.text.includes('fixture-key'))
  expect(query).toBeDefined()
  expect(files.get(query!.path)).toBe('')
  expect(await ui.find({ text: /Could not list models: node not found/ })).toBeDefined()
  denyClear = 'query'
  await ui.press({ key: 'h-models-list' } as never)
  await ui.redraw()
  expect(deniedClears).toBe(2)
  expect(await ui.find({ text: /Could not list models: Could not clear the temporary credentials.*Remove the file/ })).toBeDefined()
  await ui.unmount()
})

test('each harness has a way to list its models', () => {
  const of = (id: string) => fromPreset(PRESETS.find(p => p.id === id)!)
  expect(modelQuery(of('copilot'))).toEqual({ query: { source: 'acp', command: 'copilot' } })
  expect(modelQuery(of('opencode'))).toEqual({ query: { source: 'lines', command: 'opencode', args: ['models'] } })
  expect(modelQuery(of('codex-cli'))).toEqual({ query: { source: 'codex' } })
  expect('models' in (modelQuery(of('claude-cli')) ?? {})).toBe(true)
  expect(modelQuery(of('gemini'))).toBeUndefined()
  const provider = { type: 'openai' as const, baseUrl: 'http://127.0.0.1:11434/v1' }
  expect(modelQuery({ ...of('copilot'), provider })).toEqual({ query: { source: 'api', provider } })
  expect(parseModels('{"models":[{"id":"a"},{"id":"a"},{"id":"b","name":"B"}]}')).toEqual({ models: [{ id: 'a' }, { id: 'b', name: 'B' }] })
  expect(parseModels('{"error":"401"}')).toEqual({ error: '401' })
  expect(parseModels('{"models":[]}')).toEqual({ error: 'It reported no models.' })
  const spec = agentRunSpec([{ ...of('copilot'), models: [{ id: 'gpt-6-luna' }, { id: 'claude-sonnet-5.5' }] }])
  expect(spec.description).toMatch(/models gpt-6-luna, claude-sonnet-5\.5/)
})

test('the Copilot edit form saves an Auto profile and validates its credit limit', async ($, on) => {
  mock.clock(on)
  mock.store(on, { harnesses: [] })
  on('session.id', () => ({ value: 'sid-1' }))
  on('env.get', () => ({ value: undefined }))
  const ui = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'agent-deck',
    props: { title: 'Agent Deck', isFocused: false, bodyColumns: 60, placement: 'dock' } as never,
  })
  await ui.press({ key: 'h-open' } as never)
  await ui.redraw()
  await ui.select({ key: 'h-add', value: 'copilot' })
  await ui.redraw()
  await ui.select({ key: 'h-auto-tier', value: 'hydrafusion-max' })
  await ui.redraw()
  expect(await ui.find({ text: /--model auto --auto-tier hydrafusion-max --experimental/ })).toBeDefined()
  await ui.input({ key: 'h-max-credits', text: '29', kind: 'change' })
  await ui.press({ key: 'h-save' } as never)
  await ui.redraw()
  expect(await ui.find({ text: /at least 30/ })).toBeDefined()
  await ui.input({ key: 'h-max-credits', text: '30', kind: 'change' })
  await ui.press({ key: 'h-save' } as never)
  await ui.redraw()
  await ui.press({ key: 'h-edit-copilot' } as never)
  await ui.redraw()
  expect((await ui.find({ key: 'h-auto-tier' }))?.props.value).toBe('hydrafusion-max')
  expect((await ui.find({ key: 'h-max-credits' }))?.props.value).toBe('30')
  await ui.unmount()
})

test('the edit form lists a harness\'s models and picks one', async ($, on) => {
  mock.clock(on)
  mock.store(on, { harnesses: [] })
  on('session.id', () => ({ value: 'sid-1' }))
  on('env.get', () => ({ value: undefined }))
  const ui = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'agent-deck',
    props: { title: 'Agent Deck', isFocused: false, bodyColumns: 60, placement: 'dock' } as never,
  })
  await ui.press({ key: 'h-open' } as never)
  await ui.redraw()
  expect(await ui.find({ text: /Model API, or add the Copilot \(own API\) preset/ })).toBeDefined()
  await ui.select({ key: 'h-add', value: 'claude-cli' })
  await ui.redraw()
  // A fixed list fills in as the form opens: one dropdown, no extra field.
  const options = (await ui.find({ key: 'h-model-pick' }))?.props.options
  if (!Array.isArray(options)) throw new Error('Model picker has no options')
  expect(options.map((o: unknown) => o && typeof o === 'object' && 'value' in o ? o.value : undefined)).toEqual(['', 'opus', 'sonnet', 'haiku', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', '__other__'])
  expect(await ui.find({ key: 'h-model' } as never)).toBeUndefined()
  await ui.select({ key: 'h-model-pick', value: 'claude-sonnet-5-5' })
  await ui.redraw()
  expect(await ui.find({ text: /--model claude-sonnet-5-5/ })).toBeDefined()
  await ui.select({ key: 'h-model-pick', value: '__other__' })
  await ui.redraw()
  await ui.input({ key: 'h-model', text: 'claude-next', kind: 'change' })
  await ui.redraw()
  expect(await ui.find({ text: /--model claude-next/ })).toBeDefined()
  await ui.press({ key: 'h-save' } as never)
  await ui.redraw()
  expect(await ui.find({ text: /claude · Claude stream-json · claude-next/ })).toBeDefined()
  // Editing it again keeps the typed model in Other…'s field.
  await ui.press({ key: 'h-edit-claude-cli' } as never)
  await ui.redraw()
  expect((await ui.find({ key: 'h-model' }))?.props.value).toBe('claude-next')
  await ui.press({ key: 'h-cancel' } as never)
  await ui.redraw()
  // A query that fails says why, offers Try again, and leaves the field to type in.
  await ui.select({ key: 'h-add', value: 'copilot' })
  await ui.redraw()
  expect(await ui.find({ text: /Could not list models: no home directory/ })).toBeDefined()
  expect(await ui.find({ key: 'h-models-list' } as never)).toBeDefined()
  expect(await ui.find({ key: 'h-model' } as never)).toBeDefined()
  await ui.press({ key: 'h-cancel' } as never)
  await ui.redraw()
  await ui.select({ key: 'h-add', value: 'gemini' })
  await ui.redraw()
  expect(await ui.find({ text: /can't list its models/ })).toBeDefined()
  await ui.unmount()
})

test('Copilot JSON events fill a card', () => {
  const card = { id: 'c', provider: 'harness', title: 't', model: 'Copilot', status: 'running', startedAt: 0, output: '', isThinking: true, activity: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } as AgentCard
  const lines = [
    '{"type":"session.auto_mode_resolved","data":{"chosenModel":"gpt-6-luna"}}',
    '{"type":"tool.execution_start","data":{"toolCallId":"t1","toolName":"powershell","arguments":{"command":"echo hi"}}}',
    '{"type":"tool.execution_complete","data":{"toolCallId":"t1","success":true}}',
    '{"type":"assistant.message","data":{"model":"gpt-6-luna","content":"done"}}',
    '{"type":"session.usage_checkpoint","data":{"totalNanoAiu":174368250,"totalPremiumRequests":1,"accountingSnapshot":{"modelMetrics":{"gpt-6-luna":{"usage":{"inputTokens":15408,"outputTokens":23,"cacheReadTokens":0,"cacheWriteTokens":15405,"reasoningTokens":16}}}}}}',
    '{"type":"result","sessionId":"67e5","exitCode":0,"usage":{"premiumRequests":1}}',
  ]
  let final = ''
  for (const l of lines) for (const ev of parseLine('copilot', l)) ev.kind === 'final' ? (final = ev.text) : applyHarnessEvent(card, ev)
  expect(card.model).toBe('gpt-6-luna')
  expect(card.activity).toEqual([{ id: 't1', label: 'powershell echo hi', status: 'done' }])
  expect(card.output).toBe('done\n')
  expect(card.tokens).toEqual({ input: 3, output: 23, cacheRead: 0, cacheWrite: 15405, reasoning: 16 })
  expect(card.aiCredits).toBe(0.17436825)
  expect(card.sessionRef).toBe('67e5')
  expect(final).toBe('done')
})

test('a reloaded Copilot run rebuilds its final per-model usage from events', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  mock.store(on, { harnesses: [], 'codex-enabled': false })
  on('session.id', () => ({ value: 'reload-session' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  const home = 'test-home'
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? home : undefined }))
  const root = `/${home}/.claude/agent-deck/harness-runs`
  const dir = `${root}/run-reload`
  const missingDir = `${root}/run-missing`
  const files: Record<string, string> = {
    [`${dir}/meta.json`]: JSON.stringify({ id: 'run-reload', harness: 'copilot', name: 'Copilot', color: '#8957E5', parser: 'copilot', title: 'Reloaded run', cwd: 'project', sessionId: 'reload-session', startedAt: 9000, model: 'auto' }),
    [`${dir}/exit.txt`]: '0',
    [`${dir}/stderr.log`]: '',
    [`${dir}/events.jsonl`]: [
      JSON.stringify({ type: 'assistant.message', data: { content: 'Finished.' } }),
      JSON.stringify({ type: 'session.usage_checkpoint', data: { accountingSnapshot: { totalNanoAiu: 250_000_000, aiCreditsStatus: 'complete', modelMetrics: { 'fixture-model': { totalNanoAiu: 250_000_000, usage: { inputTokens: 11, outputTokens: 3 } } } } } }),
      '',
    ].join('\n'),
    [`${missingDir}/meta.json`]: JSON.stringify({ id: 'run-missing', harness: 'copilot', name: 'Copilot', color: '#8957E5', parser: 'copilot', title: 'Missing subtotal', cwd: 'project', sessionId: 'reload-session', startedAt: 9000, model: 'auto' }),
    [`${missingDir}/exit.txt`]: '0',
    [`${missingDir}/stderr.log`]: '',
    [`${missingDir}/events.jsonl`]: [
      JSON.stringify({ type: 'assistant.message', data: { content: 'Finished without billing.' } }),
      JSON.stringify({ type: 'session.usage_checkpoint', data: { accountingSnapshot: { aiCreditsStatus: 'partial', modelMetrics: { 'fixture-model': { usage: { inputTokens: 11, outputTokens: 3 } } } } } }),
      '',
    ].join('\n'),
  }
  const listed: string[] = []
  on('fs.list', (_$, e) => {
    const path = e.path.replace(/\\/g, '/')
    listed.push(path)
    return { value: path.endsWith(root) ? ['run-reload', 'run-missing'].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) : [] }
  })
  on('fs.read', (_$, e) => {
    const path = e.path.replace(/\\/g, '/')
    const key = Object.keys(files).find(file => path.endsWith(file))
    const text = key ? files[key] : undefined
    return text === undefined ? { deny: 'not found' } : { value: text }
  })
  on('fs.exists', () => ({ value: true }))
  await $.session.start({ cwd: 'project', surface: 'desktop', isInteractive: true })
  expect(listed.some(path => path.endsWith(root))).toBe(true)
  await clock.advance(1000)
  await clock.advance(250)
  const result = await $.tool.call({ tool: 'mcp__agent-deck__agent_result', tool_use_id: 'result-1', id: 'run-reload' })
  const text = JSON.stringify(result)
  expect(text).toMatch(/Finished/)
  expect(text).toMatch(/0\.25 AI credits/)
  expect(text).toMatch(/fixture-model in 11 out 3/)
  const missing = await $.tool.call({ tool: 'mcp__agent-deck__agent_result', tool_use_id: 'result-2', id: 'run-missing' })
  expect(JSON.stringify(missing)).toMatch(/AI credits not reported/)
  const ui = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'agent-deck',
    props: { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock' } as never,
  })
  await ui.press({ key: 't-h-run-run-missing' } as never)
  await ui.redraw()
  expect(await ui.find({ text: 'AI credits not reported' })).toBeDefined()
  await ui.unmount()
})

test('Copilot per-call, checkpoint and shutdown accounting includes every model exactly once', () => {
  const card = { id: 'c', provider: 'harness', title: 't', model: 'auto', status: 'running', startedAt: 0, output: '', isThinking: true, activity: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } as AgentCard
  const fold = (type: string, data: object, extra: object = {}) => {
    for (const event of parseLine('copilot', JSON.stringify({ type, data, ...extra }))) applyHarnessEvent(card, event)
  }
  fold('assistant.usage', { model: 'draft-model', inputTokens: 100, outputTokens: 10, cacheReadTokens: 70, copilotUsage: { totalNanoAiu: 500_000_000 }, cost: 2 })
  fold('assistant.usage', { model: 'critic-model', inputTokens: 50, outputTokens: 5, cacheWriteTokens: 40, copilotUsage: { totalNanoAiu: 250_000_000 }, cost: 1 }, { agentId: 'critic' })
  expect(card.tokens).toEqual({ input: 40, output: 15, cacheRead: 70, cacheWrite: 40, reasoning: 0 })
  expect(card.aiCredits).toBe(0.75)
  expect(card.costUsd).toBeUndefined()
  const metrics = {
    'draft-model': { totalNanoAiu: 500_000_000, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 70, cacheWriteTokens: 0 } },
    'critic-model': { totalNanoAiu: 250_000_000, usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 40 } },
  }
  fold('session.usage_checkpoint', { totalNanoAiu: 750_000_000, accountingSnapshot: { modelMetrics: metrics, aiCreditsStatus: 'complete', totalPremiumRequestCost: 3 } })
  fold('session.shutdown', { modelMetrics: metrics, totalNanoAiu: 750_000_000, totalPremiumRequests: 3 })
  expect(card.tokens).toEqual({ input: 40, output: 15, cacheRead: 70, cacheWrite: 40, reasoning: 0 })
  expect(card.aiCredits).toBe(0.75)
  expect(card.modelUsage?.['critic-model']?.aiCredits).toBe(0.25)
  fold('assistant.usage', { model: 'draft-model', inputTokens: 10, outputTokens: 2, copilotUsage: { totalNanoAiu: 100_000_000 } })
  expect(card.tokens.output).toBe(17)
  expect(card.aiCredits).toBe(0.85)
  fold('assistant.usage', { model: 'draft-model', inputTokens: 900, outputTokens: 900, copilotUsage: { totalNanoAiu: 1e9 } }, { checkpoint: true })
  expect(card.tokens.output).toBe(17)
  expect(card.aiCredits).toBe(0.85)
})

test('missing Copilot billing is unavailable or partial, not zero USD or free BYOK', () => {
  const card = { id: 'c', provider: 'harness', title: 't', model: 'byok', status: 'running', startedAt: 0, output: '', isThinking: true, activity: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } as AgentCard
  const fold = (type: string, data: object) => {
    for (const event of parseLine('copilot', JSON.stringify({ type, data }))) applyHarnessEvent(card, event)
  }
  fold('assistant.usage', { model: 'byok', inputTokens: 10, outputTokens: 5, isByok: true, cost: 0 })
  expect(card.aiCredits).toBeUndefined()
  expect(card.aiCreditsStatus).toBe('unavailable')
  expect(card.costUsd).toBeUndefined()
  fold('assistant.usage', { model: 'byok', inputTokens: 10, outputTokens: 5, copilotUsage: { totalNanoAiu: 200_000_000 } })
  expect(card.aiCredits).toBe(0.2)
  expect(card.aiCreditsStatus).toBe('partial')
  expect(card.modelUsage?.byok?.aiCreditsStatus).toBe('partial')
  fold('session.usage_checkpoint', { totalNanoAiu: 0, accountingSnapshot: { totalNanoAiu: 0, aiCreditsStatus: 'unavailable', modelMetrics: { byok: { totalNanoAiu: 0, usage: { inputTokens: 20, outputTokens: 10 } } } } })
  expect(card.aiCredits).toBeUndefined()
  expect(card.modelUsage?.byok?.aiCredits).toBeUndefined()
  expect(card.tokens.output).toBe(10)
  fold('session.usage_checkpoint', { totalNanoAiu: 0, accountingSnapshot: { totalNanoAiu: 0, aiCreditsStatus: 'complete' } })
  expect(card.aiCredits).toBe(0)
  expect(card.aiCreditsStatus).toBe('complete')
  expect(parseLine('copilot', '{"type":"result","exitCode":1}').some(e => e.kind === 'error')).toBe(true)
  const missing = parseLine('copilot', '{"type":"agent-deck.usage_error","data":{"message":"file missing"}}')
  expect(missing).toEqual([
    { kind: 'copilot-usage', creditsStatus: 'unavailable', isAdded: true },
    { kind: 'act', id: 'copilot-usage', label: 'Copilot usage unavailable: file missing', status: 'error' },
  ])
  for (const event of missing) applyHarnessEvent(card, event)
  expect(card.aiCredits).toBe(0)
  expect(card.aiCreditsStatus).toBe('partial')
})

test('a later Copilot subtotal without a billing status is still shown', () => {
  const card = { id: 'c', provider: 'harness', title: 't', model: 'auto', status: 'running', startedAt: 0, output: '', isThinking: true, activity: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } as AgentCard
  for (const event of parseLine('copilot', JSON.stringify({ type: 'assistant.usage', data: { model: 'm', inputTokens: 10, outputTokens: 1 } }))) applyHarnessEvent(card, event)
  expect(card.aiCreditsStatus).toBe('unavailable')
  for (const event of parseLine('copilot', JSON.stringify({
    type: 'session.usage_checkpoint',
    data: { totalNanoAiu: 250_000_000, accountingSnapshot: { modelMetrics: { m: { totalNanoAiu: 250_000_000, usage: { inputTokens: 10, outputTokens: 1 } } } } },
  }))) applyHarnessEvent(card, event)
  expect(card.aiCredits).toBe(0.25)
  expect(card.aiCreditsStatus).toBe('partial')
  expect(card.modelUsage?.m?.aiCreditsStatus).toBe('partial')
})

test('Fusion phase activities show progress and degradation without delivering drafts or counting usage twice', () => {
  const card = { id: 'c', provider: 'harness', title: 't', model: 'auto', status: 'running', startedAt: 0, output: '', isThinking: true, activity: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } as AgentCard
  const phase = { fusionId: 'f1', phaseId: 'p1', role: 'draft', model: 'draft-model' }
  const start = parseLine('copilot', JSON.stringify({ type: 'assistant.fusion_phase_started', data: phase }))
  for (const event of start) applyHarnessEvent(card, event)
  expect(card.activity[0]?.status).toBe('running')
  const completed = parseLine('copilot', JSON.stringify({ type: 'assistant.fusion_phase_completed', data: { ...phase, content: 'discard this draft', usage: { inputTokens: 500, outputTokens: 100 }, status: 'succeeded' } }))
  for (const event of completed) applyHarnessEvent(card, event)
  expect(card.activity[0]?.status).toBe('done')
  expect(card.output).toBe('')
  expect(card.tokens.output).toBe(0)
  expect(completed.some(e => e.kind === 'final')).toBe(false)
  for (const event of parseLine('copilot', JSON.stringify({ type: 'assistant.fusion_phase_failed', data: { ...phase, phaseId: 'p2', role: 'critic', reason: 'timeout' } }))) applyHarnessEvent(card, event)
  expect(card.activity[1]?.status).toBe('error')
  expect(card.activity[1]?.label).toMatch(/critic.*timeout/)
  expect(card.error).toBeUndefined()
  for (const event of parseLine('copilot', '{"type":"session.auto_tier_switch_failed","data":{"requestedAutoTier":"hydrafusion","effectiveAutoTier":"balance","reason":"unsupported"}}')) applyHarnessEvent(card, event)
  expect(card.activity[2]?.label).toMatch(/hydrafusion not used.*balance/)
})

test('OpenCode and Claude stream events parse', () => {
  const oc = parseLine('opencode', '{"type":"step_finish","sessionID":"ses_1","part":{"tokens":{"input":10,"output":5,"reasoning":0,"cache":{"read":100,"write":0}},"cost":0.01}}')
  expect(oc).toEqual([
    { kind: 'session', id: 'ses_1' },
    { kind: 'tokens', tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, reasoning: 0 }, isAdded: true },
    { kind: 'cost', usd: 0.01, isAdded: true },
  ])
  const err = parseLine('opencode', '{"type":"error","sessionID":"s","error":{"name":"APIError","data":{"message":"model not available"}}}')
  expect(err[1]).toEqual({ kind: 'error', text: 'model not available' })
  const cl = parseLine('claude', '{"type":"result","session_id":"abc","result":"ok","total_cost_usd":0.2,"usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4}}')
  expect(cl.find(e => e.kind === 'final')).toEqual({ kind: 'final', text: 'ok' })
  expect(parseLine('text', 'hello')).toEqual([{ kind: 'text', text: 'hello' }])
  expect(parseLine('copilot', 'not json')).toEqual([])
})

test('the Harnesses view adds, edits and switches off a harness', async ($, on) => {
  mock.clock(on)
  mock.store(on, { harnesses: [] })
  on('session.id', () => ({ value: 'sid-1' }))
  on('env.get', () => ({ value: undefined }))
  const ui = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'agent-deck',
    props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock' } as never,
  })
  await ui.press({ key: 'h-open' } as never)
  await ui.redraw()
  expect(await ui.find({ text: /No other harness yet/ })).toBeDefined()
  await ui.select({ key: 'h-add', value: 'copilot' })
  await ui.redraw()
  expect(await ui.find({ text: /allow-all-tools/ })).toBeDefined()
  await ui.input({ key: 'h-model', text: 'gpt-6.1', kind: 'change' })
  await ui.redraw()
  expect(await ui.find({ text: /--model gpt-6\.1/ })).toBeDefined()
  await ui.press({ key: 'h-save' } as never)
  await ui.redraw()
  expect(await ui.find({ text: /copilot · Copilot JSON · gpt-6\.1/ })).toBeDefined()
  await ui.press({ key: 'h-toggle-copilot' } as never)
  await ui.redraw()
  expect((await ui.findAll({ type: 'Button' } as never)).some(b => (b as { key?: string; text?: string }).key === 'h-toggle-copilot' && (b as { text?: string }).text === 'Off')).toBe(true)
  await ui.press({ key: 'h-edit-copilot' } as never)
  await ui.redraw()
  await ui.input({ key: 'h-id', text: 'codex', kind: 'change' })
  await ui.redraw()
  await ui.press({ key: 'h-save' } as never)
  await ui.redraw()
  expect(await ui.find({ text: /built-in Codex harness/ })).toBeDefined()
  await ui.unmount()
})

test('cache TTL follows the Claude Code rules', () => {
  expect(ttlFor({ isMetered: false })).toBe(3_600_000)
  expect(ttlFor({ isMetered: true })).toBe(300_000)
  expect(ttlFor({ isMetered: true, settingTtl: '1h' })).toBe(3_600_000)
  expect(ttlFor({ isMetered: false, envTtl: '5m', settingTtl: '1h' })).toBe(300_000)
  expect(ttlFor({ isMetered: false, force5m: '1', envTtl: '1h' })).toBe(300_000)
  expect(ttlFor({ isMetered: true, enable1h: '1' })).toBe(3_600_000)
})

test('usage bars are thick SVG on the desktop', async ($, on) => {
  expect(barSvg(53, '#3FB950')).toContain('width="530"')
  expect(barSvg(0, '#3FB950')).not.toContain('#3FB950')
  mock.clock(on)
  mock.store(on, { harnesses: [] })
  on('session.id', () => ({ value: 'sid-1' }))
  on('env.get', () => ({ value: undefined }))
  const ui = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'agent-deck',
    props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock' } as never,
  })
  expect(await ui.find({ text: /Codex/ })).toBeDefined()
  await ui.unmount()
})

test('codex exec JSON events fill a card', () => {
  const card = { id: 'c', provider: 'harness', title: 't', model: 'Codex', status: 'running', startedAt: 0, output: '', isThinking: true, activity: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } as AgentCard
  const lines = [
    '{"type":"thread.started","thread_id":"01a1"}',
    '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"pwsh -NoProfile -Command \'rg -n x\'","status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"pwsh -NoProfile -Command \'rg -n x\'","exit_code":1,"status":"failed"}}',
    '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"All good."}}',
    '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":800,"cache_write_input_tokens":0,"output_tokens":50,"reasoning_output_tokens":10}}',
  ]
  let final = ''
  for (const l of lines) for (const ev of parseLine('codex', l)) ev.kind === 'final' ? (final = ev.text) : applyHarnessEvent(card, ev)
  expect(card.sessionRef).toBe('01a1')
  expect(card.activity).toEqual([{ id: 'item_1', label: '$ rg -n x', status: 'error' }])
  expect(card.tokens).toEqual({ input: 200, output: 50, cacheRead: 800, cacheWrite: 0, reasoning: 10 })
  expect(final).toBe('All good.')
})

test('the built-in Codex switches off, or becomes a custom harness', async ($, on) => {
  mock.clock(on)
  mock.store(on, { harnesses: [] })
  on('session.id', () => ({ value: 'sid-1' }))
  on('env.get', () => ({ value: undefined }))
  const ui = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'agent-deck',
    props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock' } as never,
  })
  await ui.press({ key: 'h-open' } as never)
  await ui.redraw()
  // The mount runs no session.start: the switch starts at its default, off.
  expect(await ui.find({ text: /^off$/ })).toBeDefined()
  await ui.press({ key: 'cx-toggle' } as never)
  await ui.redraw()
  expect(await ui.find({ text: /live view of every Codex run/ })).toBeDefined()
  await ui.press({ key: 'cx-edit' } as never)
  await ui.redraw()
  await ui.select({ key: 'cx-mode', value: 'custom' })
  await ui.redraw()
  expect(await ui.find({ text: /exec --json --skip-git-repo-check/ })).toBeDefined()
  await ui.press({ key: 'h-save' } as never)
  await ui.redraw()
  expect(await ui.find({ text: /codex · Codex exec JSON/ })).toBeDefined()
  await ui.press({ key: 'cx-edit' } as never)
  await ui.redraw()
  await ui.select({ key: 'cx-mode', value: 'builtin' })
  await ui.redraw()
  expect(await ui.find({ text: /live view of every Codex run/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Button' } as never)).some(b => (b as { key?: string }).key === 'h-toggle-codex-cli' && (b as { text?: string }).text === 'Off')).toBe(true)
  await ui.unmount()
})

test('Copilot AI credits become a meter', () => {
  const r = copilotLimits({
    token_based_billing: true,
    quota_reset_date_utc: '2026-11-01T00:00:00.000Z',
    quota_snapshots: {
      chat: { unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100 },
      premium_interactions: { unlimited: false, entitlement: 1500, remaining: 870, percent_remaining: 58 },
    },
  })
  expect(r?.windows).toEqual([{ label: 'mo', name: 'Monthly AI credits', percent: 42, resetsAt: Date.parse('2026-11-01T00:00:00.000Z') }])
  expect(r?.plan).toBe('630 of 1500 AI credits')
  const billed = copilotLimits({
    token_based_billing: true,
    quota_snapshots: { premium_interactions: { unlimited: false, entitlement: 1500, remaining: 1287.5, credits_used: 212.5, percent_remaining: 85.8 } },
  })
  expect(billed?.plan).toBe('213 of 1500 AI credits')
  expect(copilotLimits({ token_based_billing: true, quota_snapshots: { premium_interactions: { entitlement: 1500, remaining: 1000, credits_used: 0 } } })?.plan).toBe('0.00 of 1500 AI credits')
  const legacy = copilotLimits({ token_based_billing: false, quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 200 } } })
  expect(legacy).toBeUndefined()
  expect(parseLine('copilot', '{"type":"result","usage":{"premiumRequests":10}}')).toEqual([])
  expect(copilotLimits({ quota_snapshots: { premium_interactions: { unlimited: true } } })).toBeUndefined()
  expect(copilotLimits({})).toBeUndefined()
})

test('Copilot run totals arrive as AI credits', () => {
  const card = { id: 'c', provider: 'harness', title: 't', model: 'Copilot', status: 'done', startedAt: 0, output: '', isThinking: false, activity: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } as AgentCard
  for (const ev of parseLine('copilot', '{"type":"session.shutdown","data":{"accountingSnapshot":{"totalNanoAiu":5550862450.0}}}')) applyHarnessEvent(card, ev)
  expect(card.aiCredits).toBe(5.55086245)
  expect(fmtCredits(5.550862)).toBe('5.6')
  expect(fmtCredits(0.174)).toBe('0.17')
  expect(fmtCredits(1341.3)).toBe('1341')
  expect(fmtCredits(0.001234567)).toBe('0.001234567')
  expect(fmtCredits(0.000000001)).toBe('0.000000001')
  expect(fmtCredits(0.0000000001)).toBe('<0.000000001')
  expect(fmtCredits(0)).toBe('0.00')
})

test('every Claude window shows, Enterprise spend limits too', () => {
  const ws = claudeLimits([
    { kind: 'spend_limit', percentUsed: 37.5, resetsAt: '2026-12-01T00:00:00Z' },
    { kind: 'seven_day', percentUsed: 12 },
    { kind: 'seven_day_opus', percentUsed: 4 },
    { kind: 'five_hour', percentUsed: 20 },
    { kind: 'monthly_usage', percentUsed: 9 },
  ])
  expect(ws.map(w => [w.label, w.name, w.percent])).toEqual([
    ['5h', '5-hour limit', 20],
    ['7d', 'Weekly limit', 12],
    ['Opus', 'Weekly Opus limit', 4],
    ['$', 'Spend limit', 37.5],
    ['monthly usage', 'Monthly usage limit', 9],
  ])
  expect(ws[3]?.resetsAt).toBe(Date.parse('2026-12-01T00:00:00Z'))
})

test('Copilot Fusion is offered, and a fallback shows', () => {
  const copilot = fromPreset(PRESETS.find(p => p.id === 'copilot')!)
  const ids = withFusion(copilot, [{ id: 'gpt-6-luna' }, { id: 'hydrafusion' }]).map(m => m.id)
  expect(ids).toEqual(['auto', 'hydrafusion', 'hydrafusion-max', 'gpt-6-luna'])
  expect(withFusion({ ...copilot, provider: { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1' } }, [{ id: 'x' }]).map(m => m.id)).toEqual(['x'])
  expect(withFusion(fromPreset(PRESETS.find(p => p.id === 'opencode')!), [{ id: 'x' }]).map(m => m.id)).toEqual(['x'])
  const card = { id: 'c', provider: 'harness', title: 't', model: 'Copilot', status: 'running', startedAt: 0, output: '', isThinking: true, activity: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } as AgentCard
  const lines = [
    JSON.stringify({
      type: 'session.fusion_route_failed',
      data: {
        attemptId: 'f1:route',
        reason: 'transport',
        errorMessage:
          'fusion routing transport failed: Fusion plan request failed: status=403 body={"error":"sku_not_eligible","message":"Model fusion is not available for the user\'s Copilot plan."}\n',
        fallbackModel: 'gpt-5.6-luna',
      },
    }),
    '{"type":"assistant.fusion_phase_started","data":{"pattern":"single","model":"gpt-5.6-luna"}}',
  ]
  for (const l of lines) for (const ev of parseLine('copilot', l)) applyHarnessEvent(card, ev)
  expect(card.model).toBe('gpt-5.6-luna')
  expect(card.activity).toEqual([{ id: 'f1:route', label: "Fusion not used: Model fusion is not available for the user's Copilot plan. Fell back to gpt-5.6-luna.", status: 'error' }])
})

test('meters show by the choice made', () => {
  const used = new Set(['claude', 'codex'] as const)
  expect(isMeterShown({ mode: 'all', selected: [] }, 'copilot', used)).toBe(true)
  expect(isMeterShown({ mode: 'session', selected: [] }, 'copilot', used)).toBe(false)
  expect(isMeterShown({ mode: 'session', selected: [] }, 'codex', used)).toBe(true)
  expect(isMeterShown({ mode: 'selected', selected: ['copilot'] }, 'copilot', used)).toBe(true)
  expect(isMeterShown({ mode: 'selected', selected: ['copilot'] }, 'claude', used)).toBe(false)
})

test('only a base URL off the Anthropic API counts as a gateway', () => {
  expect(isGatewayUrl(undefined)).toBe(false)
  expect(isGatewayUrl('https://api.anthropic.com')).toBe(false)
  expect(isGatewayUrl('https://api.anthropic.com/')).toBe(false)
  expect(isGatewayUrl('https://llm-gateway.example.com')).toBe(true)
})

test('the meter choice is set in the Harnesses view', async ($, on) => {
  mock.clock(on)
  mock.store(on, { harnesses: [] })
  on('session.id', () => ({ value: 'sid-1' }))
  on('env.get', () => ({ value: undefined }))
  const ui = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'agent-deck',
    props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock' } as never,
  })
  await ui.press({ key: 'h-open' } as never)
  await ui.redraw()
  expect(await ui.find({ text: /Usage meters/ })).toBeDefined()
  await ui.select({ key: 'm-mode', value: 'selected' })
  await ui.redraw()
  await ui.press({ key: 'm-claude' } as never)
  await ui.redraw()
  const buttons = (await ui.findAll({ type: 'Button' } as never)) as { key?: string; text?: string }[]
  expect(buttons.find(b => b.key === 'm-claude')?.text).toBe('Claude ·')
  expect(buttons.find(b => b.key === 'm-copilot')?.text).toBe('Copilot ✓')
  await ui.unmount()
})
