// User-run configuration/login/run/terminal checks. Default: memory fakes only.
// --pty: explicitly opts into a local /bin/sh PTY check on Linux x86_64.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const logDir = path.join(os.tmpdir(), 'gpt-login-diag')
fs.mkdirSync(logDir, { recursive: true })
const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const logPath = path.join(logDir, `web2term-server-check-${timestamp}.log`)
const cwd = path.resolve(__dirname, '../../agents/linux')
const append = (message) => fs.appendFileSync(logPath, message, 'utf8')
const args = process.argv.slice(2)
const pty = args.includes('--pty')
const invalid = args.some((arg) => arg !== '--pty') ||
  (pty && (process.platform !== 'linux' || process.arch !== 'x64'))
if (invalid) {
  append('[argument-error] Only --pty is accepted; --pty requires Linux x86_64.\n')
  console.error(`默认检查：node tools/diag/web2term-server-check.cjs；真实 PTY 检查仅在 Linux x86_64 使用 --pty。日志：${logPath}`)
  process.exit(1)
}
// Run configuration tests on the host, even after a cross-build in the same shell.
const testEnv = {
  ...process.env,
  GOOS: process.platform === 'win32' ? 'windows' : process.platform,
  GOARCH: process.arch === 'x64' ? 'amd64' : process.arch,
  CGO_ENABLED: '0',
  GOTOOLCHAIN: 'local',
  GOPROXY: 'off',
  GOSUMDB: 'off',
  // Never inherit an opt-in accidentally from the parent shell.
  WEB2TERM_PTY_INTEGRATION: pty ? '1' : '0'
}

append(`[start] ${new Date().toISOString()}\n[mode] ${pty ? 'local Linux PTY + offline checks' : 'offline memory fakes; no real Shell'}\n[command] go test -count=1 -v -timeout=90s ./...\n`)
console.log(`日志：${logPath}`)

const child = spawn('go', ['test', '-count=1', '-v', '-timeout=90s', './...'], {
  cwd,
  env: testEnv,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (data) => {
  append(data)
  process.stdout.write(data)
})
child.stderr.on('data', (data) => {
  append(data)
  process.stderr.write(data)
})
child.on('error', (error) => {
  append(`[spawn-error] ${error.message}\n`)
  console.error(`无法启动 Go 检查：${error.message}`)
})
child.on('close', (code, signal) => {
  append(`\n[end] exit=${code} signal=${signal || 'none'}\n`)
  console.log(`检查结束，日志：${logPath}`)
  process.exitCode = code === 0 ? 0 : 1
})
