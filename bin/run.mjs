// agent-deck runner: starts one harness CLI as a process of its own, detached
// from the Claude session, so a plugin reload or a dropped session leaves it running.
//
//   node run.mjs <runDir>
//
// <runDir>/spec.json holds { argv: [command, ...args], cwd, stdin?, usageFile? }. An optional
// <runDir>/env.json adds environment variables (an API key, say); it is read and
// deleted before the child starts, so it does not outlive the start. The child's
// stdout goes to events.jsonl, stderr to stderr.log, its pid to pid.txt and,
// once it exits, its exit code to exit.txt.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { launchArgv, launchEnv } from './launch.mjs'

const dir = process.argv[2]
if (!dir) {
  process.stderr.write('usage: node run.mjs <runDir>\n')
  process.exit(2)
}

// First call: start a detached copy of this script and return at once.
if (process.env.AGENT_DECK_DETACHED !== '1') {
  const child = spawn(process.execPath, [process.argv[1], dir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, AGENT_DECK_DETACHED: '1' },
  })
  child.unref()
  process.stdout.write(`${child.pid}\n`)
  process.exit(0)
}

const envFile = path.join(dir, 'env.json')
let extraEnv = {}
let envError
try {
  extraEnv = JSON.parse(fs.readFileSync(envFile, 'utf8'))
  if (!extraEnv || typeof extraEnv !== 'object' || Array.isArray(extraEnv) || Object.values(extraEnv).some(v => typeof v !== 'string')) {
    throw new Error('invalid environment')
  }
} catch (e) {
  if (e?.code !== 'ENOENT') envError = 'could not read the temporary environment file; the run was not started.'
}
try {
  fs.rmSync(envFile, { force: true })
} catch {
  envError = 'could not delete the temporary environment file; the run was not started. Remove env.json from the run folder.'
}
const out = fs.openSync(path.join(dir, 'events.jsonl'), 'a')
const err = fs.openSync(path.join(dir, 'stderr.log'), 'a')
const failStart = message => {
  fs.writeSync(err, `agent-deck: ${message}\n`)
  fs.writeFileSync(path.join(dir, 'exit.txt'), '127')
  process.exit(0)
}
if (envError) failStart(envError)
let spec
try {
  spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'))
  if (!spec || !Array.isArray(spec.argv) || !spec.argv.length || spec.argv.some(arg => typeof arg !== 'string')) throw new Error('invalid arguments')
} catch {
  failStart('could not read the run specification; the run was not started.')
}
const [command, ...args] = spec.argv
const usageFile = spec.parser === 'copilot' && spec.usageFile ? path.resolve(spec.cwd || process.cwd(), spec.usageFile) : undefined
const usageStamp = file => {
  const stat = fs.statSync(file, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
}
let previousUsage
let usageStatError
if (usageFile) {
  try {
    previousUsage = usageStamp(usageFile)
  } catch (e) {
    if (e?.code !== 'ENOENT') usageStatError = true
  }
}
let child
try {
  const argv = launchArgv(command, args)
  child = spawn(argv[0], argv.slice(1), {
    cwd: spec.cwd || undefined,
    stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', out, err],
    env: launchEnv(extraEnv, spec.isolateProvider),
    windowsHide: true,
    shell: false,
  })
} catch (e) {
  fs.writeSync(err, `agent-deck: could not start ${command}: ${e?.message ?? e}\n`)
  fs.writeFileSync(path.join(dir, 'exit.txt'), '127')
  process.exit(0)
}
fs.writeFileSync(path.join(dir, 'pid.txt'), String(child.pid ?? ''))
if (spec.stdin !== undefined) child.stdin.end(spec.stdin)
child.on('error', e => {
  fs.writeSync(err, `agent-deck: could not start ${command}: ${e?.message ?? e}\n`)
  fs.writeFileSync(path.join(dir, 'exit.txt'), '127')
  process.exit(0)
})
child.on('close', code => {
  if (spec.parser === 'copilot') {
    let event
    try {
      if (!usageFile) throw new Error('no usage output file was configured')
      if (usageStatError) throw new Error('the existing usage file could not be checked before the run')
      if (previousUsage !== undefined && usageStamp(usageFile) === previousUsage) throw new Error('the usage file was not updated by this run')
      const text = fs.readFileSync(usageFile, 'utf8')
      let usage
      try {
        usage = JSON.parse(text)
      } catch {
        throw new Error('the usage file is not valid JSON')
      }
      if (!usage || typeof usage !== 'object' || Array.isArray(usage) || !usage.modelMetrics || typeof usage.modelMetrics !== 'object' || Array.isArray(usage.modelMetrics)) {
        throw new Error('the usage file has an unexpected format')
      }
      event = {
        type: 'session.usage_checkpoint',
        data: { accountingSnapshot: { modelMetrics: usage.modelMetrics, totalNanoAiu: usage.totalNanoAiu, aiCreditsStatus: usage.aiCreditsStatus } },
      }
    } catch (e) {
      event = { type: 'agent-deck.usage_error', data: { message: String(e?.message ?? e) } }
    }
    fs.writeSync(out, `\n${JSON.stringify(event)}\n`)
  }
  fs.writeFileSync(path.join(dir, 'exit.txt'), String(code ?? 1))
  process.exit(0)
})
