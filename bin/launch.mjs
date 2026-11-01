// How agent-deck starts a CLI without a shell, shared by run.mjs and models.mjs.
import fs from 'node:fs'
import path from 'node:path'

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
export const launchArgv = (command, args) => {
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
