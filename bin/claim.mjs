// agent-deck atomic delivery marker helper: serializes delivered.txt updates
// across concurrent plugin copies using an exclusive-create lockfile (O_EXCL).
//
//   node claim.mjs claim   <dir> <token> <nowMs> <ttlMs>
//   node claim.mjs refresh <dir> <token> <nowMs>
//   node claim.mjs deliver <dir> <atMs>
//   node claim.mjs release <dir> <token>
//
// Prints one JSON line: { state, token?, at? }. A delivered timestamp is never
// overwritten by a claim or a release.
import fs from 'node:fs'
import path from 'node:path'

const STALE_LOCK_MS = 30_000
const LOCK_WAIT_MS = 1_500
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4))

const sleepMs = ms => {
  try {
    Atomics.wait(SLEEP_BUF, 0, 0, ms)
  } catch {}
}

const parseMark = text => {
  const t = String(text ?? '').trim()
  if (!t) return { state: 'none' }
  const m = t.match(/^claim (\S+) (-?\d+)$/)
  return m ? { state: 'claimed', token: m[1], at: Number(m[2]) } : { state: 'delivered' }
}

const readFile = file => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

const withLock = (dir, fn) => {
  fs.mkdirSync(dir, { recursive: true })
  const lockFile = path.join(dir, 'delivered.lock')
  const deadline = Date.now() + LOCK_WAIT_MS
  let fd
  while (true) {
    try {
      fd = fs.openSync(lockFile, 'wx')
      fs.writeSync(fd, `${process.pid} ${Date.now()}\n`)
      fs.closeSync(fd)
      fd = undefined
      break
    } catch (err) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd)
        } catch {}
        fd = undefined
      }
      if (err?.code !== 'EEXIST') throw err
      try {
        const stat = fs.statSync(lockFile)
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          fs.rmSync(lockFile, { force: true })
          continue
        }
      } catch {}
      if (Date.now() >= deadline) throw new Error('lock busy')
      sleepMs(15)
    }
  }
  try {
    return fn()
  } finally {
    try {
      fs.rmSync(lockFile, { force: true })
    } catch {}
  }
}

const [action, dir, arg1, arg2, arg3] = process.argv.slice(2)
if (!action || !dir) {
  process.stderr.write('usage: node claim.mjs <claim|refresh|deliver|release> <dir> ...\n')
  process.exit(2)
}

const out = obj => {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exit(0)
}

try {
  const file = path.join(dir, 'delivered.txt')
  const result = withLock(dir, () => {
    const mark = parseMark(readFile(file))
    if (action === 'claim') {
      const token = String(arg1 ?? '')
      const now = Number(arg2)
      const ttlMs = Number(arg3)
      if (!token || !Number.isFinite(now) || !Number.isFinite(ttlMs)) throw new Error('invalid claim args')
      if (mark.state === 'delivered') return { state: 'delivered' }
      if (mark.state === 'claimed') {
        if (mark.token === token) return { state: 'owned', token: mark.token, at: mark.at }
        if (now - mark.at < ttlMs) return { state: 'taken', token: mark.token, at: mark.at }
      }
      fs.writeFileSync(file, `claim ${token} ${now}`)
      return { state: 'claimed', token, at: now }
    }
    if (action === 'refresh') {
      const token = String(arg1 ?? '')
      const now = Number(arg2)
      if (!token || !Number.isFinite(now)) throw new Error('invalid refresh args')
      if (mark.state === 'delivered') return { state: 'delivered' }
      if (mark.state === 'claimed' && mark.token === token) {
        fs.writeFileSync(file, `claim ${token} ${now}`)
        return { state: 'owned', token, at: now }
      }
      return { state: mark.state === 'claimed' ? 'taken' : 'none' }
    }
    if (action === 'deliver') {
      const at = Number(arg1)
      if (!Number.isFinite(at)) throw new Error('invalid deliver args')
      if (mark.state !== 'delivered') fs.writeFileSync(file, String(at))
      return { state: 'delivered' }
    }
    if (action === 'release') {
      const token = String(arg1 ?? '')
      if (!token) throw new Error('invalid release args')
      if (mark.state === 'delivered') return { state: 'delivered' }
      if (mark.state === 'claimed' && mark.token === token) {
        fs.writeFileSync(file, '')
        return { state: 'released' }
      }
      return { state: 'kept' }
    }
    throw new Error(`unknown action: ${action}`)
  })
  out(result)
} catch (err) {
  process.stderr.write(`${String(err?.message ?? err)}\n`)
  process.exit(1)
}
