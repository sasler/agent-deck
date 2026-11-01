// agent-deck model lister: asks a harness's CLI or API which models it can run.
//
//   node models.mjs <spec.json>
//
// The spec is { source, command?, env?, provider? } and may hold an API key, so it is
// read and deleted first. Prints { models: [{ id, name?, note? }] } or { error }.
//
//   acp     the CLI's Agent Client Protocol server (copilot --acp --stdio): session/new
//           answers with availableModels
//   lines   a command that prints one model per line (opencode models)
//   codex   Codex's own cache, ~/.codex/models_cache.json
//   api     the provider's /models endpoint (OpenAI-compatible, Azure or Anthropic)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { launchArgv } from './launch.mjs'

const TIMEOUT_MS = 45_000

const done = out => {
  process.stdout.write(JSON.stringify(out))
  process.exit(0)
}
const fail = error => done({ error })

const file = process.argv[2]
if (!file) fail('usage: node models.mjs <spec.json>')
let text = ''
try {
  text = fs.readFileSync(file, 'utf8')
} catch {}
try {
  fs.rmSync(file, { force: true })
} catch {}
let spec
try {
  spec = JSON.parse(text)
} catch (e) {
  fail(`could not read ${file}: ${e?.message ?? e}`)
}
setTimeout(() => fail(`no answer within ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS).unref()

const start = args => {
  const argv = launchArgv(spec.command, args)
  return spawn(argv[0], argv.slice(1), {
    env: { ...process.env, ...(spec.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  })
}

const fromAcp = () =>
  new Promise((resolve, reject) => {
    const child = start(['--acp', '--stdio'])
    let buf = ''
    let errText = ''
    const send = msg => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
    const finish = (fn, v) => {
      child.kill()
      fn(v)
    }
    child.on('error', e => reject(e))
    child.on('close', code => reject(new Error(errText.trim().split('\n').pop() || `${spec.command} exited ${code}`)))
    child.stderr.on('data', d => (errText += d))
    child.stdout.on('data', d => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.error) return finish(reject, new Error(msg.error.message ?? 'ACP error'))
        if (msg.id === 1) send({ id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } })
        if (msg.id === 2) {
          const list = msg.result?.models?.availableModels ?? []
          return finish(
            resolve,
            list.map(m => ({
              id: m.modelId,
              name: m.name !== m.modelId ? m.name : undefined,
              note: m._meta?.copilotUsage ? `${m._meta.copilotUsage} premium` : undefined,
            })),
          )
        }
      }
    })
    send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
  })

const fromLines = () =>
  new Promise((resolve, reject) => {
    const child = start(spec.args ?? [])
    let out = ''
    let errText = ''
    child.stdin.end()
    child.on('error', e => reject(e))
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (errText += d))
    child.on('close', code => {
      const ids = out.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/\s/.test(l))
      if (code !== 0 && !ids.length) return reject(new Error(errText.trim().split('\n').pop() || `${spec.command} exited ${code}`))
      resolve(ids.map(id => ({ id })))
    })
  })

const fromCodex = () => {
  const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8'))
  return (j.models ?? [])
    .filter(m => m.visibility === undefined || m.visibility === 'list')
    .map(m => ({ id: m.slug, name: m.display_name !== m.slug ? m.display_name : undefined }))
}

const fromApi = async () => {
  const p = spec.provider
  const base = p.baseUrl.replace(/\/+$/, '')
  let url
  const headers = {}
  if (p.type === 'anthropic') {
    url = /\/v1$/.test(base) ? `${base}/models?limit=1000` : `${base}/v1/models?limit=1000`
    if (p.apiKey) headers['x-api-key'] = p.apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (p.type === 'azure') {
    url = /\/openai\/v1$/.test(base) ? `${base}/models` : `${base}/openai/v1/models`
    if (p.apiKey) headers['api-key'] = p.apiKey
  } else {
    url = `${base}/models`
    if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`
  }
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS - 5_000) })
  const text = await r.text()
  if (!r.ok) throw new Error(`${url} answered ${r.status}: ${text.slice(0, 200)}`)
  const j = JSON.parse(text)
  const list = Array.isArray(j) ? j : (j.data ?? j.models ?? [])
  return list
    .map(m => (typeof m === 'string' ? { id: m } : { id: m.id ?? m.name, name: m.display_name ?? (m.name !== m.id ? m.name : undefined) }))
    .filter(m => typeof m.id === 'string' && m.id)
}

const SOURCES = { acp: fromAcp, lines: fromLines, codex: fromCodex, api: fromApi }

try {
  const fn = SOURCES[spec.source]
  if (!fn) fail(`unknown source ${spec.source}`)
  const models = await fn()
  done({ models })
} catch (e) {
  fail(String(e?.message ?? e))
}
