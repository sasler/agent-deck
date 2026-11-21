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
  codexBinaryLabel,
  costOf,
  keepWarmValue,
  newCodexCard,
  newStrataCard,
  parseCodexConfig,
  shortCommand,
  staleFor,
  strataTitle,
  toLimitWindows,
} from '../hooks/register'
import { cacheView, fmtDuration, freshCache, isCold, parseDuration, ttlFor, isGatewayUrl } from '../hooks/cache'
import { DELIVERY_CLAIM_TTL_MS, deliveryClaim, isDeliveryTaken, readDeliveryMark } from '../hooks/harness'
import { CODEX_EFFORTS, METER_PROVIDERS, SUBAGENT_EFFORTS, cardModelName, effortProblem, harnessEfforts, isResetPast, limitSummary, orderMeters, readingAge, resetNote, routeEffortChoices, shouldTakeCodexLimits } from '../hooks/harness'
import { CARD_STALE_MS, CARD_TTL_MS, DEFAULT_ROUTING, PRESETS, ROUTING_OFF_NOTE, agentRunSpec, agyLimits, loadRouting, loadSessionCards, mergeSavedCards, resolveRun, restoreCard, routeModelChoices, routeProblem, routedTasks, routingContext, routingNote, applyHarnessEvent, codexErrorText, codexFailure, codexModelProblem, codexUpdateNote, compareVersions, pickCodex, copilotOptionsError, expandArgs, fromPreset, harnessArgs, harnessCommand, harnessError, modelQuery, parseLine, parseModels, providerEnv, slugId, tokenizeArgs, withFusion } from '../hooks/harness'
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
    expect(await ui.find({ text: /◆ Haiku 5\.5/ })).toBeDefined()
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
  expect(await ui.find({ text: /◆ Sonnet 5\.5/ })).toBeDefined()
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
  expect(gear?.text).toBe('⚙\uFE0E Settings')
  expect(gear?.props?.label).toBe('⚙\uFE0E Settings')
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
  expect(modelQuery(of('antigravity'))).toEqual({ query: { source: 'lines', command: 'agy', args: ['models'] } })
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
  expect(options.map((o: unknown) => o && typeof o === 'object' && 'value' in o ? o.value : undefined)).toEqual(['', 'opus', 'sonnet', 'haiku', 'claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', '__other__'])
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

test('Antigravity stream-json events fill a card', () => {
  const card = { id: 'a', provider: 'harness', title: 't', model: 'Antigravity', status: 'running', startedAt: 0, output: '', isThinking: true, activity: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } as AgentCard
  const lines = [
    '{"event":"init","conversation_id":"08db","init":{"model":"gemini-3.8-flash-low","cwd":"C:\\\\p","tools":["run_command"],"permission_mode":"always-proceed"}}',
    '{"event":"step_update","step_update":{"conversation_id":"08db","step_index":0,"state":"DONE","step_type":"user_input"}}',
    '{"event":"step_update","step_update":{"conversation_id":"08db","step_index":1,"state":"DONE","step_type":"agent_response","usage":{"input_tokens":8988,"output_tokens":119,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":9107}}}',
    '{"event":"step_update","step_update":{"conversation_id":"08db","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"}}}}',
    '{"event":"step_update","step_update":{"conversation_id":"08db","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"},"output":"hi"}}}',
    '{"event":"step_update","step_update":{"conversation_id":"08db","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"Path":"f.txt"}}}}',
    '{"event":"step_update","step_update":{"conversation_id":"08db","step_index":4,"state":"ACTIVE","step_type":"agent_response","text_delta":"It says"}}',
    '{"event":"step_update","step_update":{"conversation_id":"08db","step_index":4,"state":"DONE","step_type":"agent_response","text_delta":" hello\\n","usage":{"input_tokens":2336,"output_tokens":99,"thinking_tokens":5,"cache_read_tokens":6942,"total_tokens":2435}}}',
    '{"event":"result","result":{"conversation_id":"08db","status":"SUCCESS","response":"It says hello\\n","num_turns":1,"usage":{"input_tokens":11324,"output_tokens":218}}}',
  ]
  let final = ''
  for (const l of lines) for (const ev of parseLine('antigravity', l)) ev.kind === 'final' ? (final = ev.text) : applyHarnessEvent(card, ev)
  expect(card.model).toBe('gemini-3.8-flash-low')
  expect(card.sessionRef).toBe('08db')
  expect(card.activity).toEqual([
    { id: 'step:2', label: '$ echo hi', status: 'done' },
    { id: 'step:3', label: 'read_file f.txt', status: 'running' },
  ])
  expect(card.output).toBe('It says hello\n')
  expect(card.tokens).toEqual({ input: 11324, output: 218, cacheRead: 6942, cacheWrite: 0, reasoning: 5 })
  expect(final).toBe('It says hello\n')
})

test('an Antigravity error result shows its first line', () => {
  const evs = parseLine('antigravity', '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"invalid model selection: model nope is not recognized\\nAvailable models:\\n  Gemini 4 Neon (High)","finished_reason":"error"}}')
  expect(evs).toEqual([{ kind: 'error', text: 'invalid model selection: model nope is not recognized' }])
  const h = fromPreset(PRESETS.find(p => p.id === 'antigravity')!)
  expect(harnessArgs(h, { prompt: '-x', model: 'gemini-4-neon-high', session: 'abc' })).toEqual([
    '--output-format', 'stream-json', '--disable-slash-commands', '--dangerously-skip-permissions',
    '--model', 'gemini-4-neon-high', '--conversation', 'abc', '-p', '-x',
  ])
  expect(harnessArgs(h, { prompt: 'hi' })).toEqual(['--output-format', 'stream-json', '--disable-slash-commands', '--dangerously-skip-permissions', '-p', 'hi'])
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
    [`${dir}/delivered.txt`]: '9500',
    [`${dir}/stderr.log`]: '',
    [`${dir}/events.jsonl`]: [
      JSON.stringify({ type: 'assistant.message', data: { content: 'Finished.' } }),
      JSON.stringify({ type: 'session.usage_checkpoint', data: { accountingSnapshot: { totalNanoAiu: 250_000_000, aiCreditsStatus: 'complete', modelMetrics: { 'fixture-model': { totalNanoAiu: 250_000_000, usage: { inputTokens: 11, outputTokens: 3 } } } } } }),
      '',
    ].join('\n'),
    [`${missingDir}/meta.json`]: JSON.stringify({ id: 'run-missing', harness: 'copilot', name: 'Copilot', color: '#8957E5', parser: 'copilot', title: 'Missing subtotal', cwd: 'project', sessionId: 'reload-session', startedAt: 9000, model: 'auto' }),
    [`${missingDir}/exit.txt`]: '0',
    [`${missingDir}/delivered.txt`]: '9500',
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

test('picks the newest Codex CLI, or the one set by hand', async () => {
  expect(compareVersions('0.170.0', '0.99.9')).toBeGreaterThan(0)
  expect(compareVersions('0.160.1', '0.166.0')).toBeLessThan(0)
  expect(compareVersions('1.0.0-alpha.1', '1.0.0')).toBeLessThan(0)
  const find = {
    candidates: [
      { path: 'C:/Programs/OpenAI/Codex/bin/codex.exe', version: '0.160.1', models: ['gpt-6.1-sol'] },
      { path: 'C:/npm/codex.cmd', version: '0.170.0', models: ['gpt-6.2-sol', 'gpt-6.1-sol'] },
      { path: 'C:/broken/codex.exe', error: 'spawn EPERM' },
    ],
    latest: '0.171.0',
  }
  expect(pickCodex(find)?.path).toBe('C:/npm/codex.cmd')
  expect(pickCodex({ ...find, override: 'C:/Programs/OpenAI/Codex/bin/codex.exe' })?.version).toBe('0.160.1')
  expect(pickCodex({ ...find, override: 'C:/broken/codex.exe' })).toBeUndefined()
  expect(codexUpdateNote(pickCodex(find), '0.171.0')).toContain('npm i -g @openai/codex@latest')
  expect(codexUpdateNote(pickCodex(find), '0.170.0')).toBeUndefined()
  expect(codexBinaryLabel('C:/npm/codex.cmd', '0.170.0')).toBe('codex-cli 0.170.0 · C:/npm/codex.cmd')
})

test('refuses a model the chosen Codex does not know, before starting', async () => {
  const old = { path: 'C:/old/codex.exe', version: '0.160.1', models: ['gpt-6.1-sol'] }
  const find = { candidates: [old], latest: '0.170.0' }
  const problem = codexModelProblem('gpt-6.2-sol', find, old)
  expect(problem).toContain('Codex 0.160.1 (C:/old/codex.exe) does not know the model "gpt-6.2-sol"')
  expect(problem).toContain('Codex 0.170.0 is out')
  expect(codexModelProblem('gpt-6.1-sol', find, old)).toBeUndefined()
  // No list, or a custom provider: nothing to check against.
  expect(codexModelProblem('gpt-6.2-sol', find, { ...old, models: [] })).toBeUndefined()
  expect(codexModelProblem('llama3', find, old, 'ollama')).toBeUndefined()
})

test('a failed Codex run reports the real error, not just its exit code', async () => {
  const body = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-6.2-sol' model is not supported when using Codex with a ChatGPT account.", code: 'model_not_found' } })
  const events = [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'error', message: body }),
    JSON.stringify({ type: 'turn.failed', error: { message: body } }),
  ].join('\n')
  const stderr = '2026-11-19T06:28:50.840939Z ERROR rmcp::transport::worker: worker quit with fatal: HTTP 403\n'
  expect(codexFailure(events, stderr, 1)).toBe(
    "The 'gpt-6.2-sol' model is not supported when using Codex with a ChatGPT account. (model_not_found) [HTTP 400]",
  )
  expect(codexErrorText('plain text')).toBe('plain text')
  expect(codexFailure('', '2026-11-19T06:28:50Z ERROR codex_core: helper_unknown_error: setup refresh had errors\n', 1)).toBe(
    'codex_core: helper_unknown_error: setup refresh had errors',
  )
  expect(codexFailure('', stderr, 1)).toBe('codex exited 1 with no error output')
})

test('a long Codex tool call shows as running, and a quiet card says it may be stuck', async () => {
  const card = newCodexCard('codex-thread-x', 'Codex', 0, { threadId: 'x', isExternal: true })
  const f = 'x'
  applyToCard(card, { t: 'task', f, ts: 1000, state: 'running' })
  applyToCard(card, { t: 'act', f, ts: 1001, id: 'call_1', label: 'cua_repl.js Checking apps', status: 'running' })
  expect(card.isThinking).toBe(false)
  applyToCard(card, { t: 'act', f, ts: 1002, id: 'call_1', label: 'cua_repl.js', status: 'error' })
  // The call's output line closes it, but does not hide that it failed.
  applyToCard(card, { t: 'act', f, ts: 1003, id: 'call_1', status: 'done' })
  expect(card.activity.find(a => a.id === 'call_1')?.status).toBe('error')
  // An output line for a call never shown adds nothing.
  applyToCard(card, { t: 'act', f, ts: 1004, id: 'call_unknown', status: 'done' })
  expect(card.activity.length).toBe(1)
  applyToCard(card, { t: 'act', f, ts: 1005, id: 'call_2', label: 'exec text(ALL_TOOLS)', status: 'running' })
  applyToCard(card, { t: 'beat', f, ts: 2000 })
  expect(staleFor(card, 2000 + 60_000)).toBeUndefined()
  expect(staleFor(card, 2000 + 16 * 60_000)).toBe(16 * 60_000)
  card.status = 'done'
  expect(staleFor(card, 2000 + 16 * 60_000)).toBeUndefined()
})

// ---------- task routing ----------

const routedCopilot = () => ({ ...fromPreset(PRESETS.find(p => p.id === 'copilot')!), model: 'gpt-6-luna' })

test('task routing: stored values, routes that can run, and the note', () => {
  expect(loadRouting(undefined)).toEqual(DEFAULT_ROUTING)
  expect(loadRouting({ isOn: true, routes: [{ task: 'Code Review', target: 'copilot', model: 'x' }, { task: 'code-review', target: 'y' }, { task: 3 }] })).toEqual({
    isOn: true,
    routes: [{ task: 'code-review', target: 'copilot', model: 'x' }],
  })
  const hs = [routedCopilot(), { ...fromPreset(PRESETS.find(p => p.id === 'antigravity')!), isEnabled: false }]
  const routing = {
    isOn: true,
    routes: [
      { task: 'review', target: 'copilot', model: 'claude-opus-5-5' },
      { task: 'implement', target: 'codex' },
      { task: 'research', target: 'antigravity' },
      { task: 'ui', target: 'claude', model: 'opus' },
      { task: 'image', target: '' },
    ],
  }
  expect(routeProblem(routing.routes[2]!, hs, true)).toBe('Antigravity is switched off')
  expect(routeProblem(routing.routes[1]!, hs, false)).toBe('the built-in Codex is off')
  const routes = routedTasks(routing, hs, true)
  expect(routes.map(r => r.task)).toEqual(['review', 'implement', 'ui'])
  expect(routedTasks({ ...routing, isOn: false }, hs, true)).toEqual([])
  const note = routingNote(routes)!
  expect(note).toMatch(/review \(reviewing a diff, branch or pull request\): agent_run with task "review" \(Copilot, model claude-opus-5-5\)/)
  expect(note).toMatch(/implement \(writing or changing code\): the codex tool\./)
  expect(note).toMatch(/ui \(UI and visual design\): a Claude subagent \(the Agent tool, model opus\)/)
  expect(routingNote([])).toBeUndefined()
  expect(routingContext(note, undefined)).toBe(note)
  expect(routingContext(note, note)).toBeUndefined()
  expect(routingContext(undefined, note)).toBe(ROUTING_OFF_NOTE)
  expect(routingContext(undefined, undefined)).toBeUndefined()

  const spec = agentRunSpec(hs.filter(h => h.isEnabled), routes)
  const props = (spec.inputSchema as { properties: Record<string, { enum?: string[] }>; required: string[] })
  expect(props.properties.task?.enum).toEqual(['review'])
  expect(props.required).toEqual(['prompt'])
  expect(spec.description).toMatch(/review → copilot claude-opus-5-5/)
  expect((agentRunSpec(hs, []).inputSchema as { required: string[] }).required).toEqual(['harness', 'prompt'])
})

test('task routing: agent_run picks the harness and model from the task', () => {
  const hs = [routedCopilot()]
  const routing = { isOn: true, routes: [{ task: 'review', target: 'copilot', model: 'claude-opus-5-5' }, { task: 'implement', target: 'codex', model: 'gpt-6' }, { task: 'ui', target: 'claude' }] }
  expect(resolveRun({ task: 'review' }, routing, hs, true)).toEqual({ harness: 'copilot', model: 'claude-opus-5-5' })
  expect(resolveRun({ task: 'review', model: 'gpt-6-luna' }, routing, hs, true)).toEqual({ harness: 'copilot', model: 'gpt-6-luna' })
  expect(resolveRun({ task: 'review', harness: 'opencode' }, routing, hs, true)).toEqual({ harness: 'opencode', model: undefined })
  expect(resolveRun({ harness: 'copilot' }, routing, hs, true)).toEqual({ harness: 'copilot', model: undefined })
  expect(resolveRun({ task: 'implement' }, routing, hs, true)).toEqual({ error: expect.stringMatching(/use the codex tool with model gpt-6/) })
  expect(resolveRun({ task: 'ui' }, routing, hs, true)).toEqual({ error: expect.stringMatching(/use the Agent tool\./) })
  expect(resolveRun({ task: 'implement' }, routing, hs, false)).toEqual({ error: expect.stringMatching(/built-in Codex is off.*ask before/) })
  expect(resolveRun({ task: 'docs' }, routing, hs, true)).toEqual({ error: expect.stringMatching(/No route for the task "docs"/) })
  expect(resolveRun({ task: 'review' }, { ...routing, isOn: false }, hs, true)).toEqual({ error: expect.stringMatching(/task routing is off/) })
})

test('task routing: the note goes with the first prompt, again after a compaction, and an off note follows', async ($, on) => {
  mock.clock(on)
  mock.store(on, { harnesses: [routedCopilot()], 'codex-enabled': false, routing: { isOn: true, routes: [{ task: 'review', target: 'copilot' }] } })
  on('session.id', () => ({ value: 'sid-route' }))
  on('session.cwd', () => ({ value: 'project' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }) as never)
  on('env.get', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_$, e) => {
    seen.push(e.context)
    return { text: e.text }
  })
  on('session.compact', (_$, e) => ({ messages: (e as { messages?: unknown[] }).messages ?? [] }) as never)
  await $.session.start({ cwd: 'project', surface: 'desktop', isInteractive: true })
  const send = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await send('review my branch')
  await send('and then?')
  expect(seen[0]?.join('\n')).toMatch(/task routing is on[\s\S]*agent_run with task "review" \(Copilot\)/)
  expect(seen[1] ?? []).toEqual([])

  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  await send('after compaction')
  expect(seen[2]?.join('\n')).toMatch(/task routing is on/)

  const r = await $.command.run({ command: 'agent-deck', args: 'routing off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(JSON.stringify(r)).toMatch(/Task routing is off/)
  await send('now off')
  expect(seen[3]).toEqual([ROUTING_OFF_NOTE])
  await send('still off')
  expect(seen[4] ?? []).toEqual([])

  const status = await $.command.run({ command: 'agent-deck', args: 'routing on', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(JSON.stringify(status)).toMatch(/review: Copilot/)
  const denied = JSON.stringify(await $.tool.call({ tool: 'mcp__agent-deck__agent_run', tool_use_id: 'r-1', task: 'docs', prompt: 'write docs' } as never).catch(e => String(e)))
  expect(denied).toMatch(/No route for the task/)
})

test('the Task routing section switches routing and picks an agent per task', async ($, on) => {
  mock.clock(on)
  mock.store(on, { harnesses: [routedCopilot()] })
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
  expect(await ui.find({ text: /Task routing/ })).toBeDefined()
  expect(await ui.find({ text: /^Off: Claude places work as usual/ })).toBeDefined()
  await ui.select({ key: 'r-target-review', value: 'copilot' })
  await ui.redraw()
  await ui.press({ key: 'r-toggle' } as never)
  await ui.redraw()
  expect((await ui.findAll({ type: 'Button' } as never)).some(b => (b as { key?: string; text?: string }).key === 'r-toggle' && (b as { text?: string }).text === 'On')).toBe(true)
  expect(await ui.find({ text: /^On: Claude hands each kind of task/ })).toBeDefined()
  await ui.input({ key: 'r-add', text: 'Write Tests', kind: 'submit' } as never)
  await ui.redraw()
  expect(await ui.find({ key: 'r-target-write-tests' })).toBeDefined()
  await ui.press({ key: 'r-remove-image' } as never)
  await ui.redraw()
  expect(await ui.find({ key: 'r-target-image' })).toBeUndefined()
  expect(await ui.find({ text: /Add back image/ })).toBeDefined()
  await ui.unmount()
})

test('a routed harness with a model list offers its models in the Task routing table', async ($, on) => {
  mock.clock(on)
  const agy = { ...fromPreset(PRESETS.find(p => p.id === 'antigravity')!), models: [{ id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' }] }
  mock.store(on, { harnesses: [agy], 'codex-enabled': false })
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.cwd', () => ({ value: 'project' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }) as never)
  on('env.get', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  await $.session.start({ cwd: 'project', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'agent-deck',
    props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock' } as never,
  })
  await ui.press({ key: 'h-open' } as never)
  await ui.redraw()
  await ui.select({ key: 'r-target-research', value: 'antigravity' })
  await ui.redraw()
  expect(await ui.find({ key: 'r-model-research' })).toBeDefined()
  await ui.select({ key: 'r-model-research', value: 'gemini-4-neon-high' })
  await ui.redraw()
  expect(((await ui.find({ key: 'r-model-research' })) as { props?: { value?: string } } | undefined)?.props?.value).toBe('gemini-4-neon-high')
  expect(await ui.find({ key: 'h-done' })).toBeDefined()
  await ui.unmount()
})

test('routed tasks offer named Claude models, the Codex model list and a harness list', () => {
  expect(routeModelChoices('claude', undefined).map(c => c.label)).toEqual(['Fable 5.2', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'])
  expect(routeModelChoices('claude', undefined).map(c => c.value)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  expect(routeModelChoices('codex', undefined, ['gpt-6.1-terra'])).toEqual([{ value: 'gpt-6.1-terra', label: 'gpt-6.1-terra' }])
  const agy = { ...fromPreset(PRESETS.find(p => p.id === 'antigravity')!), models: [{ id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' }] }
  expect(routeModelChoices('antigravity', agy)).toEqual([{ value: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High) (gemini-4-neon-high)' }])
})

test('the routing switch sits next to Settings in the main view', async ($, on) => {
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
  const label = async (key: string) => ((await ui.findAll({ type: 'Button' } as never)) as { key?: string; text?: string }[]).find(b => b.key === key)?.text
  expect(await label('r-toggle-main')).toBe('⇄ Routing off')
  await ui.press({ key: 'r-toggle-main' } as never)
  await ui.redraw()
  expect(await label('r-toggle-main')).toBe('⇄ Routing on')
  await ui.press({ key: 'h-open' } as never)
  await ui.redraw()
  expect(await label('r-toggle')).toBe('On')
  await ui.unmount()
})

const AGY_QUOTA = {
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9842, resetTime: '2026-11-27T13:51:35Z' },
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9758, resetTime: '2026-11-20T18:51:35Z' },
        ],
      },
      { displayName: 'Claude and GPT models', buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-20T19:54:37Z' }] },
      { displayName: 'Gemini 4 Argon', buckets: [{ bucketId: 'gemini-argon-wtu-weekly', window: 'weekly', remainingFraction: 0.5 }] },
    ],
  },
}

test("Antigravity's quota summary becomes used-percent meters per model group", () => {
  expect(agyLimits(AGY_QUOTA)).toEqual([
    { label: 'Gemini 7d', name: 'Gemini · Weekly limit', percent: 1.6, resetsAt: Date.parse('2026-11-27T13:51:35Z') },
    { label: 'Gemini 5h', name: 'Gemini · 5-hour limit', percent: 2.4, resetsAt: Date.parse('2026-11-20T18:51:35Z') },
    { label: 'Claude & GPT 5h', name: 'Claude & GPT · 5-hour limit', percent: 0, resetsAt: Date.parse('2026-11-20T19:54:37Z') },
    { label: 'Gemini 4 Argon 7d', name: 'Gemini 4 Argon · Weekly limit', percent: 50, resetsAt: undefined },
  ])
  expect(agyLimits({})).toEqual([])
  expect(agyLimits({ response: { groups: [{ displayName: 'X', buckets: [{ window: '5h' }] }] } })).toEqual([])
})

test('an Antigravity harness brings its usage meters into the pane, and keeps the quota session', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { harnesses: [fromPreset(PRESETS.find(p => p.id === 'antigravity')!)], 'codex-enabled': false, 'agy-quota-session': 'saved-1' })
  on('session.id', () => ({ value: 'sid-agy' }))
  on('session.cwd', () => ({ value: 'project' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }) as never)
  on('env.get', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  const quotaCalls: string[][] = []
  on('process.run', (_$, e) => {
    const argv = (e as { argv?: string[]; command?: string[] }).argv ?? (e as { command?: string[] }).command ?? []
    if (argv.some(a => a.endsWith('agy-quota.mjs'))) {
      quotaCalls.push(argv.slice(2))
      return { value: { exitCode: 0, stdout: JSON.stringify({ sessionId: 'saved-2', quota: AGY_QUOTA }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: 'project', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'agent-deck',
    props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock' } as never,
  })
  await ui.redraw()
  expect(quotaCalls[0]).toEqual(['agy', 'saved-1'])
  expect(await ui.find({ text: /^Antigravity$/ })).toBeDefined()
  expect(await ui.find({ text: /Gemini · Weekly limit/ })).toBeDefined()
  expect(await ui.find({ text: /Gemini 4 Argon · Weekly limit/ })).toBeDefined()
  // The next check reopens the session the last one reported.
  await clock.advance(10 * 60_000)
  expect(quotaCalls.at(-1)).toEqual(['agy', 'saved-2'])
  await ui.unmount()
})

// ---------- persisting cards across restarts ----------

const sampleCard = (overrides: Partial<AgentCard>): AgentCard => ({
  id: 'card-1',
  provider: 'codex',
  title: 'Review branch',
  model: 'gpt-6.1-sol',
  status: 'done',
  startedAt: 1000,
  output: '',
  isThinking: false,
  activity: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  ...overrides,
})

test('saved cards merge, trim, prune entries older than 3 days, and restore statuses', () => {
  const now = 10 * 86_400_000
  const old = sampleCard({ id: 'old-card', title: 'Old session card' })
  const other = sampleCard({ id: 'other-card', title: 'Other session card' })
  const big = sampleCard({ id: 'big-card', output: 'x'.repeat(200) })
  const stored = {
    'sid-old': { savedAt: now - CARD_TTL_MS - 1, cards: [old] },
    'sid-other': { savedAt: now - 60_000, cards: [other] },
    'sid-bad': { savedAt: 'nope', cards: [old] },
  }
  const merged = mergeSavedCards(stored, 'sid-1', [sampleCard({ id: 'c1' }), big], now, { maxCards: 1, maxOutput: 50 })
  expect(Object.keys(merged).sort()).toEqual(['sid-1', 'sid-other'])
  expect(merged['sid-1']?.savedAt).toBe(now)
  expect(merged['sid-1']?.cards.map(c => c.id)).toEqual(['big-card'])
  expect(merged['sid-1']?.cards[0]?.output.length).toBe(50)

  expect(loadSessionCards(merged, 'sid-other').map(c => c.id)).toEqual(['other-card'])
  expect(loadSessionCards(merged, 'sid-missing')).toEqual([])
  expect(loadSessionCards(null, 'sid-1')).toEqual([])

  const runningClaude = sampleCard({ id: 'cl-1', provider: 'claude', status: 'running', isThinking: true })
  expect(restoreCard(runningClaude, now)).toMatchObject({ status: 'aborted', isThinking: false, endedAt: now })
  expect(restoreCard({ ...runningClaude, status: 'done' }, now).status).toBe('done')

  const staleExt = sampleCard({ id: 'codex-t1', provider: 'codex', isExternal: true, status: 'running', isThinking: true, lastEventAt: now - CARD_STALE_MS - 1000 })
  expect(restoreCard(staleExt, now)).toMatchObject({ status: 'aborted', isThinking: false, endedAt: now - CARD_STALE_MS - 1000 })

  const freshExt = sampleCard({ id: 'codex-t2', provider: 'codex', isExternal: true, status: 'running', lastEventAt: now - 30_000 })
  expect(restoreCard(freshExt, now).status).toBe('running')

  const managedRun = sampleCard({ id: 'codex-run-r1', provider: 'codex', runId: 'r1', status: 'running', lastEventAt: now - CARD_STALE_MS - 1000 })
  expect(restoreCard(managedRun, now).status).toBe('running')
})

test('saving cards writes the session to the store and prunes entries older than 3 days', async ($, on) => {
  const startNow = 10 * 86_400_000
  const clock = mock.clock(on, { now: startNow })
  const otherCard = sampleCard({ id: 'codex-other', provider: 'codex', isExternal: true, title: 'Other session work', status: 'done', startedAt: startNow - 60_000, endedAt: startNow - 30_000 })
  const expiredCard = sampleCard({ id: 'codex-expired', title: 'Expired work' })
  const store = new Map<string, unknown>(Object.entries({
    harnesses: [],
    'codex-enabled': false,
    cards: {
      'sid-expired': { savedAt: startNow - CARD_TTL_MS - 1000, cards: [expiredCard] },
      'sid-other': { savedAt: startNow - 60_000, cards: [otherCard] },
    },
  }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'sid-keep' }))
  on('session.cwd', () => ({ value: 'project' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }) as never)
  on('env.get', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'agent-keep' }))

  await $.session.start({ cwd: 'project', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({
    tool_use_id: 't-keep', prompt: 'scan', description: 'Inspect routes', subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-sonnet-5-5', background: true, fork: false,
  })
  await clock.advance(250)

  const saved = store.get('cards') as Record<string, { savedAt: number; cards: AgentCard[] }>
  expect(Object.keys(saved).sort()).toEqual(['sid-keep', 'sid-other'])
  expect(saved['sid-keep']?.cards.map(c => [c.id, c.title, c.status])).toEqual([
    ['agent-keep', 'Explore · Inspect routes', 'running'],
  ])
})

test('a reopened session restores its saved cards after a restart, aborts stale ones, and hides other sessions', async ($, on) => {
  const startNow = 10 * 86_400_000
  const restartNow = startNow + 5 * 60_000
  mock.clock(on, { now: restartNow })
  const claudeRunning = sampleCard({ id: 'agent-keep', provider: 'claude', title: 'Explore · Inspect routes', model: 'claude-haiku-5-5', status: 'running', startedAt: startNow, isThinking: true })
  const extDone = sampleCard({ id: 'codex-th-done', provider: 'codex', isExternal: true, threadId: 'th-done', title: 'Review diff via Bash', model: 'gpt-6.1-sol', status: 'done', startedAt: startNow, endedAt: startNow + 2000, lastEventAt: startNow + 2000 })
  const extStale = sampleCard({ id: 'codex-th-stale', provider: 'codex', isExternal: true, threadId: 'th-stale', title: 'Abandoned Codex exec', model: 'gpt-6.1-sol', status: 'running', startedAt: startNow, lastEventAt: startNow + 1000, isThinking: true })
  const otherCard = sampleCard({ id: 'codex-other', provider: 'codex', isExternal: true, title: 'Other session work', status: 'done', startedAt: startNow, endedAt: startNow + 500 })
  mock.store(on, {
    harnesses: [],
    'codex-enabled': false,
    cards: {
      'sid-keep': { savedAt: startNow + 2000, cards: [claudeRunning, extDone, extStale] },
      'sid-other': { savedAt: startNow + 500, cards: [otherCard] },
    },
  })
  on('session.id', () => ({ value: 'sid-keep' }))
  on('session.cwd', () => ({ value: 'project' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }) as never)
  on('env.get', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))

  // Fresh test starts with an empty agents atom, simulating an app restart.
  await $.session.start({ cwd: 'project', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'agent-deck',
    props: { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock' } as never,
  })
  // All 3 cards came back as finished (the running Claude card and stale external Codex card became aborted).
  expect(await ui.find({ text: /Finished · 3/ })).toBeDefined()
  expect(await ui.find({ text: /Review diff via Bash/ })).toBeDefined()
  expect(await ui.find({ text: /Explore · Inspect routes/ })).toBeDefined()
  expect(await ui.find({ text: /Abandoned Codex exec/ })).toBeDefined()
  expect(await ui.find({ text: /Other session work/ })).toBeUndefined()
  // The two aborted cards show the ■ glyph; the done external Codex card shows ✓.
  expect((await ui.findAll({ text: /^■$/ })).length).toBe(2)
  expect((await ui.findAll({ text: /^✓$/ })).length).toBe(1)
  await ui.unmount()

  // The band above the prompt confirms nothing is left spinning as running.
  const band = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  })
  expect(await band.find({ text: /no agents running/ })).toBeDefined()
  await band.unmount()
})

test('restored harness run cards are not duplicated when loadHarnessRuns reloads them from disk', async ($, on) => {
  const now = 20_000
  const clock = mock.clock(on, { now })
  const savedExternal = sampleCard({ id: 'codex-th-1', provider: 'codex', isExternal: true, threadId: 'th-1', title: 'Bash Codex review', status: 'done', startedAt: 10_000, endedAt: 15_000 })
  const savedHarness = sampleCard({ id: 'h-run-run-1', provider: 'harness', harness: 'antigravity', providerName: 'Antigravity', runId: 'run-1', title: 'Agy research', model: 'gemini', status: 'done', startedAt: 11_000, endedAt: 16_000, output: 'stale copy' })
  mock.store(on, {
    harnesses: [],
    'codex-enabled': false,
    cards: { 'sid-mix': { savedAt: now - 1000, cards: [savedExternal, savedHarness] } },
  })
  on('session.id', () => ({ value: 'sid-mix' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }) as never)
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'test-home' : undefined }))
  const root = '/test-home/.claude/agent-deck/harness-runs'
  const dir = `${root}/run-1`
  const files: Record<string, string> = {
    [`${dir}/meta.json`]: JSON.stringify({ id: 'run-1', harness: 'antigravity', name: 'Antigravity', color: '#3186FF', parser: 'antigravity', title: 'Agy research', cwd: 'project', sessionId: 'sid-mix', startedAt: 11_000, model: 'gemini' }),
    [`${dir}/exit.txt`]: '0',
    [`${dir}/delivered.txt`]: '17000',
    [`${dir}/stderr.log`]: '',
    [`${dir}/events.jsonl`]: JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'Fresh from disk' } }) + '\n',
  }
  on('fs.list', (_$, e) => {
    const p = e.path.replace(/\\/g, '/')
    return { value: p.endsWith(root) ? [{ name: 'run-1', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] : [] }
  })
  on('fs.read', (_$, e) => {
    const p = e.path.replace(/\\/g, '/')
    const key = Object.keys(files).find(f => p.endsWith(f))
    return key ? { value: files[key]! } : { deny: 'not found' }
  })
  on('fs.exists', () => ({ value: true }))

  await $.session.start({ cwd: 'project', surface: 'desktop', isInteractive: true })
  await clock.advance(1000)
  await clock.advance(250)

  const ui = await $.ui.mount({
    plugin: 'agent-deck',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'agent-deck',
    props: { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock' } as never,
  })
  expect(await ui.find({ text: /Finished · 2/ })).toBeDefined()
  expect(await ui.find({ text: /Bash Codex review/ })).toBeDefined()
  await ui.press({ key: 't-h-run-run-1' } as never)
  await ui.redraw()
  expect(await ui.find({ text: /Fresh from disk/ })).toBeDefined()
  await ui.unmount()
})

test('delivered.txt reads as nothing yet, delivered, or a claim another copy holds', () => {
  expect(readDeliveryMark(undefined)).toEqual({ state: 'none' })
  expect(readDeliveryMark('')).toEqual({ state: 'none' })
  expect(readDeliveryMark('1763700000000')).toEqual({ state: 'delivered' })
  expect(readDeliveryMark(deliveryClaim('abc-1', 5000))).toEqual({ state: 'claimed', token: 'abc-1', at: 5000 })
  expect(isDeliveryTaken({ state: 'delivered' }, 0)).toBe(true)
  expect(isDeliveryTaken({ state: 'none' }, 0)).toBe(false)
  expect(isDeliveryTaken({ state: 'claimed', token: 'x', at: 1000 }, 1000 + DELIVERY_CLAIM_TTL_MS - 1)).toBe(true)
  // A copy that stopped mid-delivery leaves an old claim: another may take it over.
  expect(isDeliveryTaken({ state: 'claimed', token: 'x', at: 1000 }, 1000 + DELIVERY_CLAIM_TTL_MS)).toBe(false)
})

test("a finished run's report is claimed before it is handed over, and a run another copy claimed is left alone", async ($, on) => {
  const start = 50_000
  const clock = mock.clock(on, { now: start })
  mock.store(on, { harnesses: [], 'codex-enabled': false })
  on('session.id', () => ({ value: 'sid-deliver' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }) as never)
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'test-home' : undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const root = 'test-home/.claude/agent-deck/harness-runs'
  const files = new Map<string, string>()
  for (const id of ['run-a', 'run-b', 'run-c']) {
    files.set(`${root}/${id}/meta.json`, JSON.stringify({ id, harness: 'antigravity', name: 'Antigravity', color: '#3186FF', parser: 'antigravity', title: `job ${id}`, cwd: 'project', sessionId: 'sid-deliver', startedAt: start - 5000 }))
    files.set(`${root}/${id}/exit.txt`, '0')
    files.set(`${root}/${id}/events.jsonl`, JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: `report of ${id}` } }) + '\n')
  }
  // run-b: another copy of agent-deck is handing it over right now.
  files.set(`${root}/run-b/delivered.txt`, deliveryClaim('other-copy', start))
  // The kit hands paths over absolute: a file is known by the end of its path.
  const key = (p: string) => {
    const path = p.replace(/\\/g, '/')
    return path.slice(Math.max(0, path.indexOf(root)))
  }
  on('fs.list', (_$, e) => ({
    value: key(e.path).endsWith(root) ? ['run-a', 'run-b', 'run-c'].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) : [],
  }))
  on('fs.read', (_$, e) => {
    const text = files.get(key(e.path))
    return text === undefined ? { deny: 'not found' } : { value: text }
  })
  on('fs.exists', (_$, e) => ({ value: files.has(key(e.path)) }))
  on('fs.write', (_$, e) => {
    const path = key(e.path)
    // run-c: another copy claims it in the same moment as this one.
    files.set(path, path.endsWith('run-c/delivered.txt') && e.text.startsWith('claim ') ? deliveryClaim('other-copy', start) : e.text)
    return { value: undefined }
  })
  const submits: { text: string; mark?: string }[] = []
  on('prompt.submit', (_$, e) => {
    submits.push({ text: e.text, mark: files.get(`${root}/run-a/delivered.txt`) })
    return { text: e.text }
  })

  await $.session.start({ cwd: 'project', surface: 'desktop', isInteractive: true })
  for (let i = 0; i < 10; i++) await clock.advance(500)


  expect(submits.map(s => s.text.match(/run (run-\w)/)?.[1])).toEqual(['run-a'])
  // The claim was on disk while the report went in, so another copy would have left it alone.
  expect(submits[0]?.mark).toMatch(/^claim \S+ \d+$/)
  expect(readDeliveryMark(files.get(`${root}/run-a/delivered.txt`))).toEqual({ state: 'delivered' })

  // The other copies finish handing theirs over; nothing goes out a second time.
  files.set(`${root}/run-b/delivered.txt`, String(start + 1000))
  files.set(`${root}/run-c/delivered.txt`, String(start + 1000))
  for (let i = 0; i < 6; i++) await clock.advance(500)
  expect(submits.length).toBe(1)
})

test('agent_run with a task reads the stored routing, also before session.start has loaded it', async ($, on) => {
  mock.clock(on, { now: 70_000 })
  mock.store(on, { harnesses: [routedCopilot()], 'codex-enabled': false, routing: { isOn: true, routes: [{ task: 'review', target: 'copilot', model: 'claude-opus-5-5' }] } })
  on('session.id', () => ({ value: 'sid-reload' }))
  on('session.cwd', () => ({ value: 'project' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }) as never)
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'test-home' : undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  const started: string[][] = []
  on('process.run', (_$, e) => {
    started.push([...((e as { argv?: string[] }).argv ?? [])])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // No session.start: a reloaded copy of the mod can get the call before it has read its settings.
  const r = JSON.stringify(await $.tool.call({ tool: 'mcp__agent-deck__agent_run', tool_use_id: 'route-1', task: 'review', prompt: 'review the branch' } as never))
  expect(r).not.toMatch(/routing is off/)
  expect(r).toMatch(/Copilot run \S+ started in the background \(model claude-opus-5-5\)/)
  expect(started.some(argv => argv.some(a => a.endsWith('/bin/run.mjs')))).toBe(true)
})

// ---------- effort levels, model names, usage limits, the top row ----------

const preset = (id: string) => fromPreset(PRESETS.find(p => p.id === id)!)

test('each CLI gets its own effort flag in front of the prompt, and only one it takes', () => {
  expect(harnessArgs(preset('antigravity'), { prompt: 'go', effort: 'high' })).toEqual([
    '--output-format', 'stream-json', '--disable-slash-commands', '--dangerously-skip-permissions', '--effort', 'high', '-p', 'go',
  ])
  expect(harnessArgs(preset('copilot'), { prompt: 'go', effort: 'xhigh' }).slice(0, 4)).toEqual(['--reasoning-effort', 'xhigh', '-p', 'go'])
  expect(harnessArgs(preset('claude-cli'), { prompt: 'go', effort: 'max' })).toEqual(['--effort', 'max', '-p', 'go', '--output-format', 'stream-json', '--verbose'])
  expect(harnessArgs(preset('opencode'), { prompt: 'go', effort: 'high' })).toEqual(['run', '--format', 'json', '--variant', 'high', 'go'])
  expect(harnessArgs(preset('codex-cli'), { prompt: 'go', effort: 'low' })).toEqual(['exec', '--json', '-c', 'model_reasoning_effort=low', '--skip-git-repo-check', 'go'])
  // Gemini's CLI has none, and a level a CLI doesn't list is left out.
  expect(harnessArgs(preset('gemini'), { prompt: 'go', effort: 'high' })).toEqual(['-p', 'go', '--output-format', 'stream-json', '--yolo'])
  expect(harnessArgs(preset('claude-cli'), { prompt: 'go', effort: 'none' })).not.toContain('--effort')
  // An effort already in the arguments is replaced, and {effort} places it where the arguments say.
  expect(harnessArgs({ ...preset('claude-cli'), args: '-p {prompt} --effort low' }, { prompt: 'go', effort: 'high' })).toEqual(['--effort', 'high', '-p', 'go'])
  const custom = { ...preset('custom'), command: 'mycli', args: '{prompt} --think {effort}' }
  expect(harnessArgs(custom, { prompt: 'go', effort: 'high' })).toEqual(['go', '--think', 'high'])
  expect(harnessArgs(custom, { prompt: 'go' })).toEqual(['go'])
  expect(harnessEfforts(preset('copilot'))).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  expect(harnessEfforts(preset('cursor'))).toEqual([])
  expect(effortProblem(preset('gemini'), 'high')).toMatch(/Gemini's CLI takes no effort setting/)
  expect(effortProblem(preset('antigravity'), 'ultra')).toMatch(/takes effort low, medium, high, xhigh, max/)
  expect(effortProblem(preset('antigravity'), 'high')).toBeUndefined()
})

test('a route keeps its effort, the note names it, and agent_run with the task applies it', () => {
  const agy = preset('antigravity')
  const hs = [agy, preset('gemini')]
  expect(routeEffortChoices('codex', undefined)).toEqual({ levels: CODEX_EFFORTS })
  expect(routeEffortChoices('claude', undefined)).toEqual({ levels: SUBAGENT_EFFORTS })
  expect(routeEffortChoices('gemini', hs[1])).toEqual({ reason: "No effort setting: Gemini's CLI has none." })
  expect(routeEffortChoices('', undefined)).toBeUndefined()
  const routing = loadRouting({
    isOn: true,
    routes: [
      { task: 'ui', target: 'antigravity', model: 'claude-opus-5-5-high', effort: 'high' },
      { task: 'implement', target: 'codex', model: 'gpt-6', effort: 'xhigh' },
      { task: 'research', target: 'claude', model: 'opus', effort: 'max' },
      { task: 'review', target: 'gemini', effort: 'high' },
    ],
  })
  expect(routing.routes[0]).toEqual({ task: 'ui', target: 'antigravity', model: 'claude-opus-5-5-high', effort: 'high' })
  const routes = routedTasks(routing, hs, true)
  const note = routingNote(routes)!
  expect(note).toMatch(/agent_run with task "ui" \(Antigravity, model claude-opus-5-5-high, effort high\)\./)
  expect(note).toMatch(/the codex tool, model gpt-6, effort xhigh\./)
  expect(note).toMatch(/a Claude subagent \(the Agent tool, model opus, effort max\)\./)
  // Gemini takes no effort, so a stale pick isn't passed on.
  expect(note).toMatch(/agent_run with task "review" \(Gemini\)\./)
  expect(resolveRun({ task: 'ui' }, routing, hs, true)).toEqual({ harness: 'antigravity', model: 'claude-opus-5-5-high', effort: 'high' })
  expect(resolveRun({ task: 'ui', effort: 'low' }, routing, hs, true)).toEqual({ harness: 'antigravity', model: 'claude-opus-5-5-high', effort: 'low' })
  expect(resolveRun({ task: 'ui', harness: 'gemini' }, routing, hs, true)).toEqual({ harness: 'gemini', model: undefined, effort: undefined })
  expect(resolveRun({ task: 'implement' }, routing, hs, true)).toEqual({ error: expect.stringMatching(/use the codex tool with model gpt-6 and effort xhigh/) })
  expect(resolveRun({ task: 'research' }, routing, hs, true)).toEqual({ error: expect.stringMatching(/use the Agent tool with model opus and effort max/) })
  const spec = agentRunSpec(hs, routes)
  expect(spec.description).toMatch(/ui → antigravity claude-opus-5-5-high effort high/)
  expect(spec.description).toMatch(/antigravity \(Antigravity, effort low\|medium\|high\|xhigh\|max\)/)
  expect((spec.inputSchema as { properties: Record<string, unknown> }).properties.effort).toBeDefined()
})

test('a card shows its model by the name the model pickers use', () => {
  const agy = { ...preset('antigravity'), models: [{ id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' }] }
  expect(cardModelName({ provider: 'harness', harness: 'antigravity', model: 'gemini-4-neon-high' }, [agy])).toBe('Gemini 4 Neon (High)')
  expect(cardModelName({ provider: 'harness', harness: 'antigravity', model: 'gemini-9' }, [agy])).toBe('gemini-9')
  expect(cardModelName({ provider: 'claude', model: 'claude-opus-5-5' }, [])).toBe('Opus 5.5')
  expect(cardModelName({ provider: 'harness', harness: 'claude-cli', model: 'claude-haiku-5-5' }, [preset('claude-cli')])).toBe('Haiku 5.5')
  expect(cardModelName({ provider: 'codex', model: 'gpt-6.1-sol' }, [agy])).toBe('gpt-6.1-sol')
})

test('a usage reading says how old it is, and a window past its reset is out of date', () => {
  const now = 10 * 3_600_000
  expect(readingAge(undefined, now)).toBeUndefined()
  expect(readingAge(now - 5 * 60_000, now)).toBeUndefined()
  expect(readingAge(now - 5 * 60_000, now, true)).toBe('updated 5m ago')
  expect(readingAge(now - 3 * 3_600_000, now)).toBe('updated 3h ago')
  const past = { label: '5h', percent: 14, resetsAt: now - 60_000 }
  const live = { label: '7d', percent: 80, resetsAt: now + 2 * 3_600_000 }
  expect(isResetPast(past, now)).toBe(true)
  expect(resetNote(past, now)).toBe('out of date')
  expect(resetNote(live, now)).toBe('resets in 2h')
  expect(resetNote({ label: 'x', percent: 1 }, now)).toBeUndefined()
  expect(limitSummary([{ name: 'Codex', windows: [past, live] }, { name: 'Copilot', windows: [past] }], now)).toEqual([
    { name: 'Codex', percent: 80 },
    { name: 'Copilot', percent: undefined },
  ])
})

test('usage meters put Claude first, then the rest alphabetically, and newer Codex readings win', () => {
  expect(METER_PROVIDERS.map(m => m.id)).toEqual(['claude', 'antigravity', 'codex', 'copilot'])
  expect(
    orderMeters([
      { name: 'Zed' },
      { name: 'Codex' },
      { name: 'Copilot' },
      { name: 'Claude' },
      { name: 'Antigravity' },
      { name: 'Bedrock' },
    ]).map(m => m.name),
  ).toEqual(['Claude', 'Antigravity', 'Bedrock', 'Codex', 'Copilot', 'Zed'])

  // A live reading wins over an older rollout reading; a newer rollout reading updates it.
  expect(shouldTakeCodexLimits(undefined, undefined, 1000, 'rollout')).toBe(true)
  expect(shouldTakeCodexLimits(1000, 'rollout', 2000, 'live')).toBe(true)
  expect(shouldTakeCodexLimits(2000, 'live', 1000, 'rollout')).toBe(false)
  expect(shouldTakeCodexLimits(2000, 'live', 2000, 'rollout')).toBe(false)
  expect(shouldTakeCodexLimits(2000, 'rollout', 2000, 'live')).toBe(true)
  expect(shouldTakeCodexLimits(2000, 'live', 3000, 'rollout')).toBe(true)
})

type TestEngine = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

const mountPane = ($: TestEngine, bodyColumns = 50) =>
  $.ui.mount({
    plugin: 'agent-deck',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'agent-deck',
    props: { title: 'Agents', isFocused: false, bodyColumns, placement: 'dock' } as never,
  })

test('the top row holds keep-warm, Routing and Settings in that order, above the prompt cache', async ($, on) => {
  mock.clock(on)
  mock.store(on, { harnesses: [] })
  on('session.id', () => ({ value: 'sid-top' }))
  on('env.get', () => ({ value: undefined }))
  const ui = await mountPane($, 44)
  const order = (await ui.findAll({})).map(e => (e as { key?: string }).key).filter(k => ['kw-window', 'r-toggle-main', 'h-open', 'cache'].includes(k ?? ''))
  expect(order).toEqual(['kw-window', 'r-toggle-main', 'h-open', 'cache'])
  expect(((await ui.find({ key: 'kw-window' })) as { props?: { label?: string } } | undefined)?.props?.label).toBe('♨\uFE0E Keep warm')
  expect(await ui.find({ text: /keep-warm off · pick a window with Keep warm above/ })).toBeDefined()
  await ui.unmount()
})

test('usage limits fold into one line, switch views, and Refresh reads them live, Codex too', async ($, on) => {
  const now = Date.UTC(2026, 10, 21, 12)
  const clock = mock.clock(on, { now })
  mock.store(on, { harnesses: [], 'codex-enabled': true })
  on('session.id', () => ({ value: 'sid-limits' }))
  on('session.cwd', () => ({ value: 'project' }))
  on('session.root', () => ({ value: 'project' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', () => ({ deny: 'not found' }))
  on('fs.write', () => ({ value: undefined }))
  let claudePercent = 40
  on('session.usage', () => ({
    value: { startedAt: now, context: { tokens: 0 }, rateLimits: [{ kind: 'five_hour', percentUsed: claudePercent, resetsAt: new Date(now + 3_600_000).toISOString() }] } as never,
  }))
  // Codex's last rollout reading is three hours old, from before its 5-hour window reset.
  const old = { windows: [{ minutes: 300, percent: 14, resetsAt: now - 30 * 60_000 }, { minutes: 10080, percent: 80, resetsAt: now + 86_400_000 }], plan: 'plus' }
  const oldTs = now - 3 * 3_600_000
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: `${JSON.stringify({ t: 'limits', ts: oldTs, limits: old, source: 'rollout' })}\n` } as never
    return { value: { exitCode: 0 } } as never
  })
  let liveReady = false
  const asked: string[][] = []
  on('process.run', async (_$, e) => {
    const argv = (e as { argv?: string[] }).argv ?? []
    if (argv.some(a => a.endsWith('/bin/codex-limits.mjs'))) {
      asked.push(argv.slice(2))
      if (!liveReady) {
        return { value: { exitCode: 0, stdout: JSON.stringify({ ts: oldTs, limits: old, source: 'rollout' }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      }
      await clock.sleep(1000)
      const fresh = { windows: [{ minutes: 300, percent: 30, resetsAt: now + 4 * 3_600_000 }, { minutes: 10080, percent: 81, resetsAt: now + 86_400_000 }], plan: 'plus' }
      return { value: { exitCode: 0, stdout: JSON.stringify({ ts: now, limits: fresh, source: 'live' }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: 'project', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await mountPane($)
  // Fallback case: shows source ("from last session"), age, out of date, and plain-words fallback hint.
  expect(asked.length).toBe(1)
  expect(asked[0]).toEqual(['C:\\Users\\me/.codex/sessions', 'codex'])
  expect(await ui.find({ text: /Codex · plus · from last session · updated 3h ago/ })).toBeDefined()
  expect(await ui.find({ text: 'out of date' })).toBeDefined()
  expect(await ui.find({ text: /resets in 0m/ })).toBeUndefined()
  expect(await ui.find({ text: /Could not read Codex's limits live/ })).toBeDefined()

  // Live read via Refresh: replaces the older rollout reading, drops the fallback label and hint.
  liveReady = true
  claudePercent = 55
  await ui.press({ key: 'lim-refresh' } as never)
  await ui.redraw()
  expect((await ui.find({ key: 'lim-refresh' }))?.text).toBe('↻ Refreshing…')
  await clock.advance(1000)
  await ui.redraw()
  expect((await ui.find({ key: 'lim-refresh' }))?.text).toBe('↻ Refresh')
  expect(asked.length).toBe(2)
  expect(await ui.find({ text: 'out of date' })).toBeUndefined()
  expect(await ui.find({ text: /updated 3h ago/ })).toBeUndefined()
  expect(await ui.find({ text: /from last session/ })).toBeUndefined()
  expect(await ui.find({ text: /Could not read Codex's limits live/ })).toBeUndefined()
  expect(await ui.find({ text: 'resets in 4h' })).toBeDefined()
  expect(await ui.find({ text: '55%' })).toBeDefined()

  // Folded summary puts Claude first, then Codex.
  await ui.press({ key: 'lim-toggle' } as never)
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /^Claude 55% · Codex 81%$/ })).toBeDefined()
  expect(await ui.find({ text: /5-hour limit/ })).toBeUndefined()
  expect((await ui.find({ key: 'lim-toggle' }))?.text).toBe('▸ Usage limits')

  // Ten minutes later, the poller asks again; an older fallback must not replace the newer live reading.
  liveReady = false
  await clock.advance(10 * 60_000)
  await ui.redraw()
  expect(asked.length).toBe(3)
  expect(await ui.find({ type: 'Text', text: /^Claude 55% · Codex 81%$/ })).toBeDefined()

  // The header's view switch and Settings → Usage meters are one setting.
  await ui.select({ key: 'lim-view', value: 'selected' })
  await ui.redraw()
  await ui.press({ key: 'h-open' } as never)
  await ui.redraw()
  expect(((await ui.find({ key: 'm-mode' })) as { props?: { value?: string } } | undefined)?.props?.value).toBe('selected')
  await ui.select({ key: 'm-mode', value: 'session' })
  await ui.press({ key: 'h-done' } as never)
  await ui.redraw()
  expect(((await ui.find({ key: 'lim-view' })) as { props?: { value?: string } } | undefined)?.props?.value).toBe('session')
  await ui.unmount()
})

test('usage meters keep the same order (Claude, Antigravity, Codex, Copilot) in expanded rows, folded summary and Settings', async ($, on) => {
  const now = Date.UTC(2026, 10, 21, 12)
  const clock = mock.clock(on, { now })
  mock.store(on, { harnesses: [preset('antigravity')], 'codex-enabled': true, 'codex-path': 'C:\\custom\\codex.exe' })
  on('session.id', () => ({ value: 'sid-order' }))
  on('session.cwd', () => ({ value: 'project' }))
  on('session.root', () => ({ value: 'project' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', () => ({ deny: 'not found' }))
  on('fs.write', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: { startedAt: now, context: { tokens: 0 }, rateLimits: [{ kind: 'five_hour', percentUsed: 15, resetsAt: new Date(now + 3_600_000).toISOString() }] } as never,
  }))
  on('process.spawn', async function* () {
    return { value: { exitCode: 0 } } as never
  })
  let codexLimitsArgv: string[] = []
  on('process.run', (_$, e) => {
    const argv = (e as { argv?: string[] }).argv ?? []
    if (argv[0] === 'gh') {
      return {
        value: {
          exitCode: 0,
          stdout: JSON.stringify({
            token_based_billing: true,
            quota_reset_date_utc: new Date(now + 10 * 86_400_000).toISOString(),
            quota_snapshots: { premium_interactions: { unlimited: false, entitlement: 1000, remaining: 580, percent_remaining: 58 } },
          }),
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }
    if (argv.some(a => a.endsWith('agy-quota.mjs'))) {
      return { value: { exitCode: 0, stdout: JSON.stringify({ sessionId: 's1', quota: AGY_QUOTA }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv.some(a => a.endsWith('codex-limits.mjs'))) {
      codexLimitsArgv = [...argv]
      return {
        value: {
          exitCode: 0,
          stdout: JSON.stringify({
            ts: now,
            source: 'live',
            limits: { windows: [{ minutes: 300, percent: 25, resetsAt: now + 3_600_000 }], plan: 'plus' },
          }),
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: 'project', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(codexLimitsArgv.slice(2)).toEqual(['C:\\Users\\me/.codex/sessions', 'C:\\custom\\codex.exe'])
  const ui = await mountPane($, 60)

  // 1. Expanded rows order
  const rowKeys = (await ui.findAll({}))
    .map(el => (el as { key?: string }).key)
    .filter((k): k is string => typeof k === 'string' && k.startsWith('lim-row-'))
  expect(rowKeys).toEqual(['lim-row-claude', 'lim-row-antigravity', 'lim-row-codex', 'lim-row-copilot'])

  // 2. Folded one-line summary order
  await ui.press({ key: 'lim-toggle' } as never)
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /^Claude 15% · Antigravity 50% · Codex 25% · Copilot 42%$/ })).toBeDefined()

  // 3. Settings → Usage meters Selected buttons order
  await ui.select({ key: 'lim-view', value: 'selected' })
  await ui.press({ key: 'h-open' } as never)
  await ui.redraw()
  const meterButtons = (await ui.findAll({ type: 'Button' } as never))
    .map(b => (b as { key?: string }).key)
    .filter((k): k is string => typeof k === 'string' && /^m-(claude|antigravity|codex|copilot)$/.test(k))
  expect(meterButtons).toEqual(['m-claude', 'm-antigravity', 'm-codex', 'm-copilot'])
  await ui.unmount()
})

test('Task routing offers an effort per route where the agent takes one, and says why where not', async ($, on) => {
  mock.clock(on)
  mock.store(on, { harnesses: [preset('antigravity'), preset('gemini')], 'codex-enabled': false })
  on('session.id', () => ({ value: 'sid-effort' }))
  on('session.cwd', () => ({ value: 'project' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }) as never)
  on('env.get', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  await $.session.start({ cwd: 'project', surface: 'desktop', isInteractive: true })
  const ui = await mountPane($, 60)
  await ui.press({ key: 'h-open' } as never)
  await ui.redraw()
  await ui.select({ key: 'r-target-ui', value: 'antigravity' })
  await ui.redraw()
  const effort = async (task: string) => (await ui.find({ key: `r-effort-${task}` })) as { props?: { value?: string; options?: { value: string }[] } } | undefined

  expect((await effort('ui'))?.props?.options?.map(o => o.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max'])
  await ui.select({ key: 'r-effort-ui', value: 'high' })
  await ui.redraw()
  expect((await effort('ui'))?.props?.value).toBe('high')
  await ui.select({ key: 'r-target-review', value: 'gemini' })
  await ui.redraw()
  expect(await effort('review')).toBeUndefined()
  expect(await ui.find({ text: "No effort setting: Gemini's CLI has none." })).toBeDefined()
  await ui.select({ key: 'r-target-implement', value: 'claude' })
  await ui.redraw()
  expect((await effort('implement'))?.props?.options?.map(o => o.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max'])
  // Another agent starts the route over: its effort goes with the old one.
  await ui.select({ key: 'r-target-ui', value: 'claude' })
  await ui.redraw()
  expect((await effort('ui'))?.props?.value).toBe('')
  await ui.unmount()
})

test("agent_run with a task runs with the route's effort, a passed effort wins, and a CLI without one refuses it", async ($, on) => {
  mock.clock(on, { now: 80_000 })
  mock.store(on, {
    harnesses: [preset('antigravity'), preset('gemini')],
    'codex-enabled': false,
    routing: { isOn: true, routes: [{ task: 'ui', target: 'antigravity', model: 'gemini-4-neon-high', effort: 'high' }] },
  })
  on('session.id', () => ({ value: 'sid-run-effort' }))
  on('session.cwd', () => ({ value: 'project' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }) as never)
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'test-home' : undefined }))
  on('fs.exists', () => ({ value: false }))
  const specs: string[][] = []
  on('fs.write', (_$, e) => {
    if (e.path.replace(/\\/g, '/').endsWith('/spec.json')) specs.push((JSON.parse(e.text) as { argv: string[] }).argv)
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const call = async (input: Record<string, unknown>) =>
    JSON.stringify(await $.tool.call({ tool: 'mcp__agent-deck__agent_run', tool_use_id: `e-${specs.length}`, prompt: 'draw it', ...input } as never))
  expect(await call({ task: 'ui' })).toMatch(/Antigravity run \S+ started in the background \(model gemini-4-neon-high, effort high\)/)
  expect(specs.at(-1)).toEqual(expect.arrayContaining(['--effort', 'high', '--model', 'gemini-4-neon-high']))
  await call({ task: 'ui', effort: 'low' })
  expect(specs.at(-1)?.slice(specs.at(-1)!.indexOf('--effort'), specs.at(-1)!.indexOf('--effort') + 2)).toEqual(['--effort', 'low'])
  const before = specs.length
  expect(await call({ harness: 'gemini', effort: 'high' })).toMatch(/not started\. Gemini's CLI takes no effort setting/)
  expect(specs.length).toBe(before)
})

test('an open card keeps a compact header, its model by name, and its last output lines with Show all', async ($, on) => {
  const now = 30_000
  const clock = mock.clock(on, { now })
  const agy = { ...preset('antigravity'), isEnabled: false, models: [{ id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' }] }
  mock.store(on, { harnesses: [agy], 'codex-enabled': false })
  on('session.id', () => ({ value: 'sid-card' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }) as never)
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'test-home' : undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const root = 'test-home/.claude/agent-deck/harness-runs'
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
  const files: Record<string, string> = {
    [`${root}/run-card/meta.json`]: JSON.stringify({ id: 'run-card', harness: 'antigravity', name: 'Antigravity', color: '#3186FF', parser: 'antigravity', title: 'Sketch the settings screen', cwd: 'project', sessionId: 'sid-card', startedAt: now - 65_000, model: 'gemini-4-neon-high', effort: 'high' }),
    [`${root}/run-card/events.jsonl`]: JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: lines } }) + '\n',
  }
  const at = (p: string) => {
    const path = p.replace(/\\/g, '/')
    return path.slice(Math.max(0, path.indexOf(root)))
  }
  on('fs.list', (_$, e) => ({ value: at(e.path).endsWith(root) ? [{ name: 'run-card', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] : [] }))
  on('fs.read', (_$, e) => {
    const text = files[at(e.path)]
    return text === undefined ? { deny: 'not found' } : { value: text }
  })
  await $.session.start({ cwd: 'project', surface: 'desktop', isInteractive: true })
  await clock.advance(1000)
  await clock.advance(250)
  const ui = await mountPane($, 60)
  expect(await ui.find({ text: '◆ Gemini 4 Neon (High)' })).toBeDefined()
  expect(await ui.find({ text: ' high ' })).toBeDefined()
  expect(await ui.find({ text: 'running' })).toBeDefined()
  expect(await ui.find({ text: 'Sketch the settings screen' })).toBeDefined()
  expect(await ui.find({ text: 'line 20' })).toBeDefined()
  expect(await ui.find({ text: 'line 8' })).toBeUndefined()
  expect(await ui.find({ text: '8 earlier lines' })).toBeDefined()
  expect((await ui.find({ key: 'out-h-run-run-card' }))?.text).toBe('Show all')
  await ui.press({ key: 'out-h-run-run-card' } as never)
  await ui.redraw()
  expect(await ui.find({ text: 'line 1' })).toBeDefined()
  expect((await ui.find({ key: 'out-h-run-run-card' }))?.text).toBe('Show less')
  await ui.unmount()
})

test('the Codex watcher starts with the session project root, not the shell cwd', async ($, on) => {
  mock.clock(on, { now: 60 * 60_000 })
  mock.store(on, { harnesses: [], 'codex-enabled': true })
  on('session.id', () => ({ value: 'sid-watch-root' }))
  on('session.root', () => ({ value: 'C:\\src\\JumpInn' }))
  on('session.cwd', () => ({ value: 'C:\\src\\JumpInn\\test-results\\crown-walk' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }) as never)
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', () => ({ deny: 'not found' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const spawned: (readonly string[])[] = []
  on('process.spawn', async function* (_$, e) {
    spawned.push(e.argv)
    return { value: { exitCode: 0 } }
  })

  await $.session.start({ cwd: 'C:\\src\\JumpInn\\test-results\\crown-walk', surface: 'desktop', isInteractive: true })

  const watchArgv = spawned.find(argv => argv.some(a => a.endsWith('/bin/watch.mjs')))
  expect(watchArgv).toBeDefined()
  expect(watchArgv?.[4]).toBe('C:\\src\\JumpInn')
})
