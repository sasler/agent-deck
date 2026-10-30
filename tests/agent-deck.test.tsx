import { expect, mock, test } from 'claude-code/testing'

import {
  applyStrataRecord,
  applyToCard,
  barSvg,
  copilotLimits,
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
import { PRESETS, applyHarnessEvent, expandArgs, fromPreset, harnessError, parseLine, slugId, tokenizeArgs } from '../hooks/harness'
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
  await $.agent.spawn({ prompt: 'look around', description: 'scan repo', subagentType: 'Explore' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-deck',
      surface,
      component: 'Pane',
      requestId: 'agent-deck',
      props: { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock' },
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
    props: { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock' },
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
      props: { hasSurvey: false, isWorking: true, maxRows: 3, bodyColumns: 100, scroll: undefined as never },
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
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: undefined as never },
  })
  expect(await ui.find({ text: /Held: “fix the parser”/ })).toBeDefined()
  await ui.press({ key: 'held-send' })
  await ui.redraw()
  expect(sent).toEqual(['fix the parser'])
  expect(await ui.find({ key: 'held-send' })).toBeUndefined()
  await ui.unmount()
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

test('Copilot JSON events fill a card', () => {
  const card = { id: 'c', provider: 'harness', title: 't', model: 'Copilot', status: 'running', startedAt: 0, output: '', isThinking: true, activity: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } as AgentCard
  const lines = [
    '{"type":"session.auto_mode_resolved","data":{"chosenModel":"gpt-6-luna"}}',
    '{"type":"tool.execution_start","data":{"toolCallId":"t1","toolName":"powershell","arguments":{"command":"echo hi"}}}',
    '{"type":"tool.execution_complete","data":{"toolCallId":"t1","success":true}}',
    '{"type":"assistant.message","data":{"model":"gpt-6-luna","content":"done"}}',
    '{"type":"session.usage_checkpoint","data":{"totalPremiumRequests":1,"accountingSnapshot":{"modelMetrics":{"gpt-6-luna":{"usage":{"inputTokens":15408,"outputTokens":23,"cacheReadTokens":0,"cacheWriteTokens":15405,"reasoningTokens":16}}}}}}',
    '{"type":"result","sessionId":"67e5","exitCode":0,"usage":{"premiumRequests":1}}',
  ]
  let final = ''
  for (const l of lines) for (const ev of parseLine('copilot', l)) ev.kind === 'final' ? (final = ev.text) : applyHarnessEvent(card, ev)
  expect(card.model).toBe('gpt-6-luna')
  expect(card.activity).toEqual([{ id: 't1', label: 'powershell echo hi', status: 'done' }])
  expect(card.output).toBe('done\n')
  expect(card.tokens).toEqual({ input: 3, output: 23, cacheRead: 0, cacheWrite: 15405, reasoning: 16 })
  expect(card.premiumRequests).toBe(1)
  expect(card.sessionRef).toBe('67e5')
  expect(final).toBe('done')
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

test('Copilot premium requests become a meter', () => {
  const r = copilotLimits({
    quota_reset_date_utc: '2026-11-01T00:00:00.000Z',
    quota_snapshots: {
      chat: { unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100 },
      premium_interactions: { unlimited: false, entitlement: 1500, remaining: 870, percent_remaining: 58 },
    },
  })
  expect(r?.windows).toEqual([{ label: 'mo', percent: 42, resetsAt: Date.parse('2026-11-01T00:00:00.000Z') }])
  expect(r?.plan).toBe('630 of 1500')
  expect(copilotLimits({ quota_snapshots: { premium_interactions: { unlimited: true } } })).toBeUndefined()
  expect(copilotLimits({})).toBeUndefined()
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
