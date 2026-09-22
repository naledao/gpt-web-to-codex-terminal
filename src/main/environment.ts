import { arch, release } from 'node:os'
import { FALLBACK_ENVIRONMENT } from '../shared/types'
import type { EnvironmentInfo } from '../shared/types'

/**
 * The startup probe, as a single line so it reads well in the terminal pane.
 *
 * It is run through the conversation shell rather than a private throwaway
 * process: the whole point is that the user SEES the terminal open and report
 * what machine this is, and that the same text then feeds the prompt.
 */
export const DETECT_COMMAND = [
  '$os = Get-CimInstance Win32_OperatingSystem;',
  '[ordered]@{',
  'osCaption = [string]$os.Caption;',
  'osVersion = [string]$os.Version;',
  'buildNumber = [string]$os.BuildNumber;',
  'architecture = [string]$os.OSArchitecture;',
  'powerShellVersion = $PSVersionTable.PSVersion.ToString();',
  'powerShellEdition = [string]$PSVersionTable.PSEdition;',
  'workingDirectory = (Get-Location).Path',
  '} | ConvertTo-Json -Compress'
].join(' ')

/** Best effort without PowerShell, so a failed probe still beats a hard-coded guess. */
export function nodeFallback(): EnvironmentInfo {
  const archNames: Record<string, string> = { x64: '64-bit', arm64: 'ARM64', ia32: '32-bit' }
  return {
    ...FALLBACK_ENVIRONMENT,
    osVersion: release(),
    architecture: archNames[arch()] ?? arch()
  }
}

/**
 * The remote probe, as a single POSIX line.
 *
 * Deliberately one `KEY=value|KEY=value` line rather than a JSON blob: the values
 * here (a distro name, `uname -r`, a bash version banner) can contain quotes and
 * parentheses, and hand-quoting them into JSON is exactly the kind of thing that
 * works until the day it doesn't. A `|`-separated record needs no escaping.
 *
 * It is echoed into the same terminal the user is watching, so it stays short.
 */
export const REMOTE_DETECT_COMMAND = [
  'echo "OSCAP=$( . /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-$(uname -s)}" )',
  '|OSVER=$(uname -r)',
  '|ARCH=$(uname -m)',
  '|SHELLP=${SHELL:-/bin/sh}',
  '|SHELLV=$("${SHELL:-/bin/sh}" --version 2>/dev/null | head -n 1)',
  '|CWD=$PWD"'
].join('')

/**
 * Read the remote probe's record.
 *
 * Scans for the line that starts with `OSCAP=` instead of parsing the first line:
 * a login banner or an MOTD can arrive first, and a strict positional read would
 * then quietly produce a machine description made of logon messages.
 */
function parseKeyValues(raw: string): Record<string, string> | null {
  const line = raw
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('OSCAP='))
  if (!line) return null

  const fields: Record<string, string> = {}
  for (const chunk of line.split('|')) {
    const equals = chunk.indexOf('=')
    if (equals === -1) continue
    fields[chunk.slice(0, equals)] = chunk.slice(equals + 1)
  }
  return fields
}

/**
 * Turn the remote probe's output into an EnvironmentInfo.
 *
 * Never throws and never invents a machine: an unreadable report keeps the
 * host's name and address (which came from the connection form and are therefore
 * known to be true) and marks `detected` false, rather than filling in the
 * architecture with the LOCAL one — that would be a confident lie about someone
 * else's server.
 */
export function parseRemoteEnvironment(
  raw: string,
  remoteName: string,
  remoteTarget: string
): EnvironmentInfo {
  const base: EnvironmentInfo = {
    ...FALLBACK_ENVIRONMENT,
    kind: 'posix',
    osCaption: '',
    architecture: '',
    powerShellExe: '',
    remoteName,
    remoteTarget
  }

  const fields = parseKeyValues(raw)
  if (!fields) return base

  return {
    ...base,
    osCaption: fields.OSCAP || '',
    osVersion: fields.OSVER || '',
    architecture: fields.ARCH || '',
    shellPath: fields.SHELLP || '',
    shellVersion: fields.SHELLV || '',
    workingDirectory: fields.CWD || '',
    detected: Boolean(fields.OSCAP || fields.OSVER)
  }
}

function parseReport(raw: string): Partial<EnvironmentInfo> | null {
  const text = raw.trim()
  if (text === '') return null

  // Anything before the object (a banner, a stray warning) would break a strict
  // parse, so fall back to the outermost braces.
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  for (const candidate of first === -1 || last <= first ? [text] : [text, text.slice(first, last + 1)]) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') {
        const pick = (key: string): string =>
          typeof parsed[key] === 'string' ? (parsed[key] as string) : ''
        return {
          osCaption: pick('osCaption'),
          osVersion: pick('osVersion'),
          buildNumber: pick('buildNumber'),
          architecture: pick('architecture'),
          powerShellVersion: pick('powerShellVersion'),
          powerShellEdition: pick('powerShellEdition'),
          workingDirectory: pick('workingDirectory')
        }
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/**
 * Turn the LOCAL PowerShell probe's raw output into an EnvironmentInfo.
 *
 * Never throws and never returns something half-filled: when the report cannot be
 * read, the Node-level values take over and `detected` stays false so the UI can
 * say so.
 */
export function parseWindowsEnvironment(raw: string, powerShellExe: string): EnvironmentInfo {
  const fallback: EnvironmentInfo = {
    ...nodeFallback(),
    kind: 'windows',
    powerShellExe
  }
  const reported = parseReport(raw)
  if (!reported) return fallback

  return {
    ...fallback,
    ...reported,
    // A blank field means the probe could not read it; keep the Node value.
    osVersion: reported.osVersion || fallback.osVersion,
    architecture: reported.architecture || fallback.architecture,
    workingDirectory: reported.workingDirectory || fallback.workingDirectory,
    powerShellExe,
    detected: reported.osCaption !== '' || reported.powerShellVersion !== ''
  }
}
