// agent-deck runner: starts one harness CLI as a process of its own, detached
// from the Claude session, so a plugin reload or a dropped session leaves it running.
//
//   node run.mjs <runDir>
//
// <runDir>/spec.json holds { argv: [command, ...args], cwd, stdin? }. An optional
// <runDir>/env.json adds environment variables (an API key, say); it is read and
// deleted before the child starts, so it does not outlive the start. The child's
// stdout goes to events.jsonl, stderr to stderr.log, its pid to pid.txt and,
// once it exits, its exit code to exit.txt.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { launchArgv } from './launch.mjs'

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

const spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'))
const [command, ...args] = spec.argv
const envFile = path.join(dir, 'env.json')
let extraEnv = {}
try {
  extraEnv = JSON.parse(fs.readFileSync(envFile, 'utf8'))
} catch {}
try {
  fs.rmSync(envFile, { force: true })
} catch {}
const out = fs.openSync(path.join(dir, 'events.jsonl'), 'a')
const err = fs.openSync(path.join(dir, 'stderr.log'), 'a')
let child
try {
  const argv = launchArgv(command, args)
  child = spawn(argv[0], argv.slice(1), {
    cwd: spec.cwd || undefined,
    stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', out, err],
    env: { ...process.env, ...extraEnv },
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
  fs.writeFileSync(path.join(dir, 'exit.txt'), String(code ?? 1))
  process.exit(0)
})
