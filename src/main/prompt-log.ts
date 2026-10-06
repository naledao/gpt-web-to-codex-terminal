import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatPlatform } from '../shared/platforms'
import type { InterceptorPageEvent } from '../shared/types'

const logPaths = new Map<ChatPlatform['id'], string>()
const events = ['configured', 'send-observed', 'injected', 'sent', 'inject-failed', 'send-failed', 'send-recovery']
const recoveryActions = ['toolbar-last', 'enter']
const reasons = [
  'accepted', 'programmatic-send', 'terminal-disabled', 'missing-prefix', 'draft-rejected',
  'composer-missing', 'composer-target-mismatch', 'empty-draft', 'ime-composition',
  'shift-enter', 'repeat-key', 'event-prevented'
]

/** Always retain the prompt/send boundary as metadata; optional app logs contain more detail. */
export function writePromptDiagnostic(
  platformId: ChatPlatform['id'],
  payload: InterceptorPageEvent,
  mainState: { taskPromptInjected: boolean; taskPromptGeneration: number }
): string | null {
  if (!['chatgpt', 'deepseek', 'claude', 'gemini'].includes(platformId) || !events.includes(payload.event)) return null
  const details: Record<string, string | number | boolean | null> = { event: payload.event }
  if (payload.event === 'send-observed') {
    details.reason = reasons.includes(payload.reason ?? '') ? payload.reason! : 'unknown'
    if (payload.trigger === 'enter' || payload.trigger === 'click') details.trigger = payload.trigger
  }
  for (const key of ['count', 'prefixLength', 'taskPromptGeneration', 'composerTextLength', 'attempts', 'attempt', 'toolbarCount'] as const) {
    const value = payload[key]
    if (Number.isSafeInteger(value) && Number(value) >= 0) details[key] = Number(value)
  }
  for (const key of [
    'enabled', 'promptInjectionEnabled', 'programmatic', 'promptInjected', 'taskPromptInjected', 'composerFound',
    'targetMatchesComposer', 'defaultPrevented', 'isComposing', 'sendButtonFound',
    'sendButtonDisabled', 'sendButtonVisible', 'sendButtonInComposer', 'stopButtonFound'
  ] as const) {
    if (typeof payload[key] === 'boolean') details[key] = payload[key]!
  }
  if (payload.sendButtonDisabled === null) details.sendButtonDisabled = null
  if (payload.recoveryTried === null) details.recoveryTried = null
  else if (recoveryActions.includes(payload.recoveryTried ?? '')) details.recoveryTried = payload.recoveryTried!
  if (recoveryActions.includes(payload.action ?? '')) details.action = payload.action!
  if (payload.composerKind === null) details.composerKind = null
  else if (['textarea', 'input', 'div'].includes(payload.composerKind ?? '')) details.composerKind = payload.composerKind!
  if (typeof mainState.taskPromptInjected === 'boolean') details.mainTaskPromptInjected = mainState.taskPromptInjected
  if (Number.isSafeInteger(mainState.taskPromptGeneration) && mainState.taskPromptGeneration >= 0) {
    details.mainTaskPromptGeneration = mainState.taskPromptGeneration
  }
  try {
    let logPath = logPaths.get(platformId)
    if (!logPath) {
      const directory = join(tmpdir(), 'gpt-login-diag')
      mkdirSync(directory, { recursive: true })
      logPath = join(directory, `${platformId}-prompt-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.log`)
      logPaths.set(platformId, logPath)
    }
    appendFileSync(logPath, `${new Date().toISOString()} ${JSON.stringify(details)}\n`, 'utf8')
    return logPath
  } catch {
    // A diagnostic failure must never interrupt the user's send.
    return null
  }
}
