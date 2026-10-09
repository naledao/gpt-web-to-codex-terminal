import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatPlatform } from '../shared/platforms'
import type { InterceptorPageEvent } from '../shared/types'

type PlatformId = ChatPlatform['id']
type Metadata = Record<string, string | number | boolean | null>

export interface ReplyDiagnosticContext {
  viewId: number | null
  conversationId: string | null
  mainPendingQuestion: boolean
  questionAccepted?: boolean
}

const events = new Set([
  'installed', 'configured', 'sent', 'sent-raw', 'scan', 'reply-state', 'question',
  'question-cleared', 'command', 'read-files', 'parse-failed', 'task-finished', 'end-task', 'reply-watchdog'
])
const reasons = new Set([
  'no-turns', 'not-assistant-turn', 'no-key', 'already-handled', 'question-still-generating',
  'question-not-live', 'invalid-question', 'invalid-read-files', 'no-command', 'still-generating',
  'terminal-mode-off', 'result-sent', 'user-sent', 'question-detected', 'non-command-reply',
  'history-baseline', 'manual-resume', 'file-send-submitted', 'configured-baseline', 'task-ended'
])

function identifier(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,160}$/.test(value) ? value : null
}

/** Explicit metadata whitelist: never retain commands, questions, prose, DOM text or URLs. */
export function replyDiagnosticMetadata(
  platformId: PlatformId,
  payload: InterceptorPageEvent,
  context: ReplyDiagnosticContext
): Metadata | null {
  if (!['chatgpt', 'deepseek', 'claude', 'gemini'].includes(platformId) || !events.has(payload.event)) return null
  const details: Metadata = {
    platformId,
    event: payload.event,
    viewId: Number.isSafeInteger(context.viewId) && Number(context.viewId) >= 0 ? context.viewId : null,
    conversationId: identifier(context.conversationId),
    mainPendingQuestion: context.mainPendingQuestion === true
  }
  if (payload.reason !== undefined) details.reason = reasons.has(payload.reason) ? payload.reason : 'unknown'
  for (const key of ['messageId', 'lastHandledMessageId', 'lastVisibleMessageId', 'visibleAnswerOwnerMessageId'] as const) {
    if (payload[key] !== undefined) details[key] = identifier(payload[key])
  }
  for (const key of [
    'taskPromptGeneration', 'assistantTurnCount', 'replyTextLength', 'codeBlockCount', 'textLength', 'objectCount',
    'selectedNodeTextLength', 'replyTextContentLength', 'visibleAssistantTurnCount', 'lastVisibleReplyTextLength',
    'lastVisibleReplyCodeBlockCount', 'visibleAnswerMarkerCount', 'visibleAnswerTextLength',
    'visibleAnswerCodeBlockCount', 'visibleCodeBlockCount', 'lastScanAgeMs', 'lastMutationAgeMs'
  ] as const) {
    const value = payload[key]
    if (Number.isSafeInteger(value) && Number(value) >= 0) details[key] = Number(value)
  }
  for (const key of [
    'enabled', 'awaitingReply', 'awaitingReplyBefore', 'taskActive', 'pendingQuestionFound', 'replySnapshotAvailable',
    'answerMarkerFound', 'replyRootIsTurn', 'stopButtonFound', 'stopButtonOnPage',
    'composerFound', 'toolbarRootFound', 'bracesBalanced', 'live', 'completed', 'selectedNodeVisible',
    'selectedReplyVisible', 'selectedMatchesLastVisible', 'replySettlePending', 'fileSendPending'
  ] as const) {
    if (typeof payload[key] === 'boolean') details[key] = payload[key]!
  }
  for (const key of ['replyKind', 'lastVisibleReplyKind', 'visibleAnswerKind'] as const) {
    if (['empty', 'questions', 'read-files', 'command', 'prose'].includes(payload[key] ?? '')) details[key] = payload[key]!
  }
  for (const key of ['lastScanAgeMs', 'lastMutationAgeMs'] as const) {
    if (payload[key] === null) details[key] = null
  }
  if (['true', 'false', 'missing', 'unknown'].includes(payload.replyStreamingState ?? '')) details.replyStreamingState = payload.replyStreamingState!
  if (typeof context.questionAccepted === 'boolean') details.questionAccepted = context.questionAccepted
  if (typeof payload.command === 'string') details.commandLength = payload.command.length
  if (typeof payload.text === 'string' && details.textLength === undefined) details.textLength = payload.text.length
  if (Array.isArray(payload.questions)) details.questionCount = payload.questions.length
  else if (typeof payload.question === 'string') details.questionCount = 1
  return details
}

/** Always-on reply tracing; synchronous append preserves the last event before an app exit. */
export class ReplyDiagnosticLog {
  private readonly directory: string
  private readonly maxBytes: number
  private readonly files = new Map<PlatformId, { path: string; bytes: number }>()
  private serial = 0
  private sequence = 0

  constructor(directory = join(tmpdir(), 'gpt-login-diag'), maxBytes = 2 * 1024 * 1024) {
    this.directory = directory
    this.maxBytes = maxBytes
  }

  write(platformId: PlatformId, payload: InterceptorPageEvent, context: ReplyDiagnosticContext): string | null {
    try {
      const details = replyDiagnosticMetadata(platformId, payload, context)
      if (!details) return null
      const now = new Date().toISOString()
      const line = `${now} ${JSON.stringify({ sequence: ++this.sequence, ...details })}\n`
      const bytes = Buffer.byteLength(line)
      let file = this.files.get(platformId)
      if (!file || file.bytes + bytes > this.maxBytes) {
        mkdirSync(this.directory, { recursive: true })
        file = {
          path: join(this.directory, `${platformId}-reply-${now.replace(/[:.]/g, '-')}-${process.pid}-${++this.serial}.log`),
          bytes: 0
        }
        this.files.set(platformId, file)
      }
      appendFileSync(file.path, line, 'utf8')
      file.bytes += bytes
      return file.path
    } catch {
      // Full disks or unavailable temporary directories must not interrupt the command loop.
      return null
    }
  }
}

const replyLog = new ReplyDiagnosticLog()
export function writeReplyDiagnostic(platformId: PlatformId, payload: InterceptorPageEvent, context: ReplyDiagnosticContext): string | null {
  return replyLog.write(platformId, payload, context)
}
