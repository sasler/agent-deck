// agent-deck Antigravity quota reader: asks agy's own language server what `/usage` shows.
//
//   node agy-quota.mjs <command> [sessionId]
//
// `agy acp` starts a language server once a session is open, and logs the local port it
// listens on. Its RetrieveUserQuotaSummary answers with the weekly and 5-hour limits of each
// model group, signed in as agy is: agent-deck never reads or holds the Google sign-in.
// Opening a session saves an empty conversation, so the same one is reopened every time:
// pass the sessionId this printed last. Prints { sessionId, quota } or { error }.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { launchArgv } from './launch.mjs'

const TIMEOUT_MS = 45_000
const PORT_WAIT_MS = 15_000
const LOG_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log')

const [command = 'agy', savedSession] = process.argv.slice(2)
let child
const done = out => {
  process.stdout.write(JSON.stringify(out))
  try {
    child?.kill()
  } catch {}
  process.exit(0)
}
const fail = error => done({ error })
setTimeout(() => fail(`no answer within ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS).unref()

const logs = () => {
  try {
    return fs.readdirSync(LOG_DIR).filter(f => f.startsWith('acp-server-') && f.endsWith('.log'))
  } catch {
    return []
  }
}
const before = new Set(logs())

/** The HTTP port in the log this agy wrote; agy names the log after its own pid. */
const findPort = async () => {
  const until = Date.now() + PORT_WAIT_MS
  while (Date.now() < until) {
    const fresh = logs().filter(f => !before.has(f))
    const mine = fresh.filter(f => f.endsWith(`-${child.pid}.log`))
    for (const f of mine.length ? mine : fresh) {
      let text = ''
      try {
        text = fs.readFileSync(path.join(LOG_DIR, f), 'utf8')
      } catch {}
      const port = /listening on random port at (\d+) for HTTP\b/.exec(text)?.[1]
      if (port) return port
    }
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error("agy's language server did not say which port it listens on")
}

const readQuota = async sessionId => {
  const port = await findPort()
  const r = await fetch(`http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'connect-protocol-version': '1' },
    body: '{}',
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`the quota request failed (${r.status}): ${text.slice(0, 200)}`)
  done({ sessionId, quota: JSON.parse(text) })
}

const argv = launchArgv(command, ['acp'])
child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
child.on('error', e => fail(`could not start ${command}: ${e.message}`))
child.on('close', code => fail(`${command} acp exited ${code} before answering`))
let errText = ''
child.stderr.on('data', d => (errText = (errText + d).slice(-2000)))
const send = msg => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
const open = () => send({ id: 3, method: 'session/new', params: { cwd: os.homedir(), mcpServers: [] } })
let buf = ''
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
    if (msg.id === 1) {
      if (msg.error) return fail(msg.error.message ?? 'agy refused to start its ACP server')
      if (savedSession) send({ id: 2, method: 'session/load', params: { sessionId: savedSession, cwd: os.homedir(), mcpServers: [] } })
      else open()
    } else if (msg.id === 2) {
      // The saved session is gone (agy's history was cleared): open a new one.
      if (msg.error) open()
      else readQuota(savedSession).catch(e => fail(e.message))
    } else if (msg.id === 3) {
      if (msg.error) return fail(msg.error.message ?? 'agy could not open a session; sign in by running agy once')
      readQuota(msg.result?.sessionId).catch(e => fail(e.message))
    }
  }
})
send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
