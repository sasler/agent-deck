// agent-deck: checks whether a process id is still alive without a shell.
//
//   node pid-alive.mjs <pid>
//
// Prints one JSON line: {"alive": true|false}. EPERM means the process exists
// (owned by another user); ESRCH means it is gone.
const raw = process.argv[2] ?? ''
if (!/^\d+$/.test(raw)) {
  process.stderr.write('usage: node pid-alive.mjs <pid>\n')
  process.exit(2)
}
const pid = Number.parseInt(raw, 10)
if (!Number.isSafeInteger(pid) || pid <= 0) {
  process.stderr.write('usage: node pid-alive.mjs <pid>\n')
  process.exit(2)
}
let alive = false
try {
  process.kill(pid, 0)
  alive = true
} catch (err) {
  alive = err?.code === 'EPERM'
}
process.stdout.write(`${JSON.stringify({ alive })}\n`)
