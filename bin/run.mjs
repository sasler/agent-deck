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
const isWindows = process.platform === 'win32'

/** Finds a command on PATH the way a shell would, extensions included on Windows. */
const which = name => {
  if (/[\\/]/.test(name)) return fs.existsSync(name) ? name : undefined
  const exts = isWindows ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').concat('.PS1', '') : ['']
  for (const folder of (process.env.PATH || '').split(path.delimiter)) {
    if (!folder) continue
    for (const ext of exts) {
      const full = path.join(folder, name + ext.toLowerCase())
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
    }
  }
  return undefined
}

/**
 * An npm-style .cmd shim's target: the script (run with node) or program it hands its
 * arguments to, read from its last line, e.g. `"%_prog%" "%dp0%\node_modules\x\bin\x" %*`.
 */
const shimTarget = file => {
  const text = fs.readFileSync(file, 'utf8')
  const m = text.match(/"%~?dp0%?\\?([^"%]+)"\s+%\*/)
  if (!m) return undefined
  const target = path.join(path.dirname(file), m[1])
  if (!fs.existsSync(target)) return undefined
  const isNode = /"%_prog%"|\bnode(\.exe)?"?\s/i.test(text)
  const ext = path.extname(target).toLowerCase()
  if (ext === '.exe' || ext === '.com') return [target]
  if (isNode || ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '') {
    const local = path.join(path.dirname(file), 'node.exe')
    return [fs.existsSync(local) ? local : process.execPath, target]
  }
  return undefined
}

/**
 * The argv to start, always without a shell: cmd.exe would expand %VARS% inside the
 * prompt and PowerShell's argument forwarding mangles quotes. An .exe starts directly;
 * an npm .cmd shim starts as the node script it wraps; any other batch file is refused.
 */
const launchArgv = () => {
  const found = which(command)
  if (!found) return [command, ...args]
  if (!isWindows) return [found, ...args]
  const ext = path.extname(found).toLowerCase()
  if (ext === '.exe' || ext === '.com' || ext === '') return [found, ...args]
  const base = ext === '.ps1' ? found.slice(0, -ext.length) : found
  for (const shim of [found, `${base}.cmd`]) {
    if (!/\.(cmd|bat)$/i.test(shim) || !fs.existsSync(shim)) continue
    const target = shimTarget(shim)
    if (target) return [...target, ...args]
  }
  throw new Error(
    `${found} is a ${ext} script agent-deck cannot start safely without a shell. ` +
      'Point the harness command at the program itself (an .exe, or the node script an npm shim runs).',
  )
}

const out = fs.openSync(path.join(dir, 'events.jsonl'), 'a')
const err = fs.openSync(path.join(dir, 'stderr.log'), 'a')
let child
try {
  const argv = launchArgv()
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
