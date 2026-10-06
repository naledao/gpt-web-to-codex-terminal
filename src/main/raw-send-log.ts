import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatPlatform } from '../shared/platforms'
import type { InterceptorPageEvent } from '../shared/types'

const logPaths = new Map<ChatPlatform['id'], string>()
const reasons = ['programmatic-send', 'model-generating', 'image-draft', 'attachment-draft', 'text-draft']

/** Persist only raw-send guard metadata, even when the optional app log is off. */
export function writeRawSendDiagnostic(platformId: ChatPlatform['id'], payload: InterceptorPageEvent): string | null {
  if (!['chatgpt', 'deepseek', 'claude', 'gemini'].includes(platformId) || payload.event !== 'raw-busy') return null
  const details: Record<string, string | number | boolean> = {
    event: 'raw-busy',
    reason: reasons.includes(payload.reason ?? '') ? payload.reason! : 'unknown'
  }
  for (const key of ['composerTextLength', 'attachmentCards', 'attachmentInputFiles', 'attachmentImages'] as const) {
    const value = payload[key]
    if (Number.isSafeInteger(value) && Number(value) >= 0) details[key] = Number(value)
  }
  for (const key of ['stopButtonFound', 'attachmentRootFound', 'attachmentUploading'] as const) {
    if (typeof payload[key] === 'boolean') details[key] = payload[key]
  }
  try {
    let logPath = logPaths.get(platformId)
    if (!logPath) {
      const directory = join(tmpdir(), 'gpt-login-diag')
      mkdirSync(directory, { recursive: true })
      logPath = join(directory, `${platformId}-raw-send-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.log`)
      logPaths.set(platformId, logPath)
    }
    appendFileSync(logPath, `${new Date().toISOString()} ${JSON.stringify(details)}\n`)
    return logPath
  } catch {
    // A logging failure must not affect the command loop or the user's draft.
    return null
  }
}
