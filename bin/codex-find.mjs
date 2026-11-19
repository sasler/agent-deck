// agent-deck Codex finder: lists every Codex CLI on this machine with its version and
// model list, plus the newest version published on npm, so the mod can start the newest.
//
//   node codex-find.mjs <out.json> [--override <path>] [--no-latest] [--update]
//
// Looks in: the override (only that, when given), every `codex` on PATH, npm's global
// folder, the standalone install (%LOCALAPPDATA%\Programs\OpenAI\Codex\bin) and WinGet.
// --update first runs `npm i -g @openai/codex@latest`. Writes
// { override?, candidates: [{ path, version?, models?, error? }], latest?, updated?, error? }.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { launchArgv } from './launch.mjs'

const isWindows = process.platform === 'win32'
const argv = process.argv.slice(2)
const outFile = argv[0]
if (!outFile) {
  process.stderr.write('usage: node codex-find.mjs <out.json> [--override <path>] [--no-latest] [--update]\n')
  process.exit(2)
}
const flag = name => argv.includes(name)
const overrideAt = argv.indexOf('--override')
const override = overrideAt > 0 ? argv[overrideAt + 1] : undefined

/** Runs a program without a shell; resolves with its stdout, or rejects with its last stderr line. */
const run = (command, args, timeout) =>
  new Promise((resolve, reject) => {
    let full
    try {
      full = launchArgv(command, args)
    } catch (e) {
      return reject(e)
    }
    execFile(full[0], full.slice(1), { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split('\n').pop()))
      resolve(String(stdout))
    })
  })

/** npm itself: its CLI script run with this node, since Node's npm.cmd is not a plain shim. */
const npm = (args, timeout) => {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return isFile(cli) ? run(process.execPath, [cli, ...args], timeout) : run('npm', args, timeout)
}

const isFile = p => {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** Every codex program on PATH; on Windows the .exe and .cmd files (the bare `codex` is a sh script). */
const onPath = () => {
  const names = isWindows ? ['codex.exe', 'codex.cmd'] : ['codex']
  const found = []
  for (const folder of (process.env.PATH || '').split(path.delimiter)) {
    if (!folder) continue
    for (const n of names) if (isFile(path.join(folder, n))) found.push(path.join(folder, n))
  }
  return found
}

const npmPrefix = async () => {
  try {
    return (await npm(['prefix', '-g'], 20_000)).trim()
  } catch {
    return isWindows && process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : undefined
  }
}

const parseVersion = text => text.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/)?.[1]

const describe = async file => {
  const c = { path: file }
  try {
    c.version = parseVersion(await run(file, ['--version'], 15_000))
    if (!c.version) c.error = 'printed no version'
  } catch (e) {
    c.error = String(e?.message ?? e).slice(0, 200)
    return c
  }
  try {
    const j = JSON.parse(await run(file, ['debug', 'models'], 20_000))
    const list = Array.isArray(j) ? j : (j.models ?? [])
    c.models = list.map(m => m?.slug).filter(s => typeof s === 'string')
  } catch {}
  return c
}

const main = async () => {
  const out = {}
  if (flag('--update')) {
    try {
      await npm(['i', '-g', '@openai/codex@latest'], 300_000)
      out.updated = true
    } catch (e) {
      out.updateError = String(e?.message ?? e).slice(0, 300)
    }
  }
  let files
  if (override) {
    out.override = override
    files = [override]
  } else {
    files = onPath()
    const prefix = await npmPrefix()
    if (prefix) files.push(isWindows ? path.join(prefix, 'codex.cmd') : path.join(prefix, 'bin', 'codex'))
    const local = process.env.LOCALAPPDATA
    if (local) {
      files.push(path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'))
      files.push(path.join(local, 'Microsoft', 'WinGet', 'Links', 'codex.exe'))
    }
    if (!isWindows) {
      for (const d of [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']) files.push(path.join(d, 'codex'))
    }
  }
  const seen = new Set()
  const unique = []
  for (const f of files) {
    if (!isFile(f)) {
      if (f === override) unique.push(f)
      continue
    }
    let key = f
    try {
      key = fs.realpathSync(f)
    } catch {}
    key = isWindows ? key.toLowerCase() : key
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(f)
  }
  const latest = flag('--no-latest') ? undefined : npm(['view', '@openai/codex', 'version'], 20_000).catch(() => undefined)
  out.candidates = await Promise.all(unique.map(f => (isFile(f) ? describe(f) : { path: f, error: 'no such file' })))
  const l = await latest
  if (l) out.latest = parseVersion(l)
  return out
}

main()
  .then(out => fs.writeFileSync(outFile, JSON.stringify(out)))
  .catch(e => fs.writeFileSync(outFile, JSON.stringify({ candidates: [], error: String(e?.message ?? e) })))
