// User-run Windows regression tests. Child PowerShell processes and temporary files only;
// no Electron, network, registry writes or changes to the parent process's environment.
// Run: node --experimental-strip-types --test tests/shell-path.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WINDOWS_PATH_REFRESH_FUNCTION, WINDOWS_PATH_REFRESH_SCRIPT } from '../src/main/shell-path.ts'

const windows = process.platform === 'win32'
const powershell = windows ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : ''
const quote = (value) => `'${value.replace(/'/g, "''")}'`
const processEnv = (path) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path')),
  Path: path
})
const pathValue = (env) => Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1]

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'shell-path-test-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

function run(script, path) {
  assert.ok(existsSync(powershell))
  const wrapped = `[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$ErrorActionPreference = 'Stop'\n${script}`
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(wrapped, 'utf16le').toString('base64')], {
    env: processEnv(path), windowsHide: true, encoding: 'utf8', timeout: 15000
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout.trim())
}

test('a stale launcher PATH discovers a newly registered executable while retaining custom paths', { skip: !windows }, (t) => {
  const root = directory(t)
  const launcher = join(root, 'launcher')
  const machine = join(root, 'machine')
  const user = join(root, 'user')
  for (const path of [launcher, machine, user]) mkdirSync(path)
  writeFileSync(join(user, 'ct-path-fixture.cmd'), '@echo off\r\necho PATH_REFRESH_OK\r\n')
  const originalParentPath = pathValue(process.env)
  const value = run(`${WINDOWS_PATH_REFRESH_FUNCTION}
$before = Get-Command ct-path-fixture.cmd -ErrorAction SilentlyContinue
Update-CTProcessPath -MachinePath ${quote(machine)} -UserPath ${quote(user)}
$after = Get-Command ct-path-fixture.cmd -ErrorAction Stop
[ordered]@{ beforeFound = ($null -ne $before); afterSource = $after.Source; path = $env:Path } | ConvertTo-Json -Compress`, launcher)
  assert.equal(value.beforeFound, false)
  assert.equal(value.afterSource, join(user, 'ct-path-fixture.cmd'))
  assert.deepEqual(value.path.split(';'), [launcher, machine, user])
  assert.equal(pathValue(process.env), originalParentPath, 'the parent process environment must stay unchanged')
})

test('merging is case-insensitive, ignores empty entries, expands variables and preserves precedence', { skip: !windows }, (t) => {
  const root = directory(t)
  const existing = join(root, 'custom')
  const fresh = join(root, 'fresh')
  const value = run(`${WINDOWS_PATH_REFRESH_FUNCTION}
$env:CT_PATH_FIXTURE = ${quote(root)}
Update-CTProcessPath -MachinePath ${quote(`${existing.toUpperCase()}\\;;`)} -UserPath '%CT_PATH_FIXTURE%\\fresh;'
[ordered]@{ path = $env:Path } | ConvertTo-Json -Compress`, `;${existing};;`)
  assert.deepEqual(value.path.split(';'), [existing, fresh])
})

test('empty registry paths leave the inherited process PATH intact', { skip: !windows }, () => {
  const original = 'C:\\custom-tools;C:\\existing-tools'
  const value = run(`${WINDOWS_PATH_REFRESH_FUNCTION}
Update-CTProcessPath -MachinePath '' -UserPath ''
[ordered]@{ path = $env:Path } | ConvertTo-Json -Compress`, original)
  assert.equal(value.path, original)
})

test('drive roots remain distinct from drive-relative paths when merging', { skip: !windows }, () => {
  const value = run(`${WINDOWS_PATH_REFRESH_FUNCTION}
Update-CTProcessPath -MachinePath 'C:\\' -UserPath ''
[ordered]@{ path = $env:Path } | ConvertTo-Json -Compress`, 'C:')
  assert.deepEqual(value.path.split(';'), ['C:', 'C:\\'])
})

test('refreshing a second new process reads the newer path rather than caching the first result', { skip: !windows }, (t) => {
  const root = directory(t)
  const launcher = join(root, 'launcher')
  const firstPath = join(root, 'first')
  const secondPath = join(root, 'second')
  const refresh = (user) => run(`${WINDOWS_PATH_REFRESH_FUNCTION}
Update-CTProcessPath -MachinePath '' -UserPath ${quote(user)}
[ordered]@{ path = $env:Path } | ConvertTo-Json -Compress`, launcher).path
  assert.equal(refresh(firstPath), `${launcher};${firstPath}`)
  assert.equal(refresh(secondPath), `${launcher};${secondPath}`)
})

test('the startup refresh reads the saved Windows paths even with a deliberately stale inherited PATH', { skip: !windows }, () => {
  const value = run(`${WINDOWS_PATH_REFRESH_SCRIPT}
$registered = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'))
$registeredParts = @($registered | ForEach-Object { [Environment]::ExpandEnvironmentVariables([string]$_) -split ';' } | Where-Object { $_.Trim().Trim('"') })
$parts = @($env:Path -split ';')
$missing = @($registeredParts | Where-Object {
  $expected = $_.Trim().Trim('"').TrimEnd([char[]]'\/')
  -not @($parts | Where-Object { $_.TrimEnd([char[]]'\/') -ieq $expected }).Count
})
[ordered]@{ registeredCount = $registeredParts.Count; missingCount = $missing.Count; keepsLauncher = ($parts -contains 'C:\\ct-launcher-only') } | ConvertTo-Json -Compress`, 'C:\\ct-launcher-only')
  assert.ok(value.registeredCount > 0)
  assert.equal(value.missingCount, 0)
  assert.equal(value.keepsLauncher, true)
})
