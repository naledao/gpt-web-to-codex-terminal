import type { WebContents } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PreparedAttachment } from './file-access'
import type { FileSendOutcome } from '../shared/file-requests'
import type { FileReadingPlatform } from '../shared/types'

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const diagnosticLogPaths = new Map<FileReadingPlatform['id'], string>()

/** Append only upload diagnostics, never the message payload or file bytes. */
function writeDiagnostic(platformId: FileReadingPlatform['id'], token: string, event: string, details: Record<string, unknown>): void {
  try {
    let diagnosticLogPath = diagnosticLogPaths.get(platformId)
    if (!diagnosticLogPath) {
      const directory = join(tmpdir(), 'gpt-login-diag')
      mkdirSync(directory, { recursive: true })
      diagnosticLogPath = join(directory, `${platformId}-file-send-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.log`)
      diagnosticLogPaths.set(platformId, diagnosticLogPath)
    }
    appendFileSync(diagnosticLogPath, `${new Date().toISOString()} ${JSON.stringify({ token, event, ...details })}\n`)
  } catch { /* Diagnostics must never interrupt an upload. */ }
}

function diagnosticSnapshot(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return { available: false }
  const snapshot = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of ['status', 'rootFound', 'images', 'imagesExpected', 'namesSeen', 'uploading', 'error', 'inputFiles', 'composerFound', 'sendFound', 'sendDisabled', 'draftEmpty', 'stopFound', 'draftCleared', 'newTurnSeen', 'turnFilesSeen', 'edited', 'turnPosition', 'baselinePosition', 'turnKeyPresent', 'turnKeyKnown', 'baselineKeyCount', 'userTurnCount', 'baselinePositionAvailable']) {
    if (typeof snapshot[key] === 'boolean' || typeof snapshot[key] === 'number' || (key === 'status' && typeof snapshot[key] === 'string')) result[key] = snapshot[key]
  }
  if (Array.isArray(snapshot.fileInputs)) result.fileInputs = snapshot.fileInputs.slice(0, 12).map((raw) => {
    const input = raw as Record<string, unknown>
    return { accept: String(input.accept ?? '').slice(0, 500), multiple: !!input.multiple, disabled: !!input.disabled, nearComposer: !!input.nearComposer }
  })
  if (Array.isArray(snapshot.attachmentAncestors)) result.attachmentAncestors = snapshot.attachmentAncestors.slice(0, 8).map((raw) => {
    const ancestor = raw as Record<string, unknown>
    const safe: Record<string, boolean | number> = {}
    for (const key of ['depth', 'hasMessages', 'selectedRoot', 'controls', 'images', 'textNameMatches', 'labelNameMatches']) {
      if (typeof ancestor[key] === 'boolean' || typeof ancestor[key] === 'number') safe[key] = ancestor[key] as boolean | number
    }
    return safe
  })
  if (Array.isArray(snapshot.userAttachmentAncestors)) result.userAttachmentAncestors = snapshot.userAttachmentAncestors.slice(0, 7).map((raw) => {
    const ancestor = raw as Record<string, unknown>
    const safe: Record<string, boolean | number> = {}
    for (const key of ['depth', 'selectedRoot', 'hasOtherMessages', 'hasAssistant', 'hasComposer', 'images', 'filenameMatches']) {
      if (typeof ancestor[key] === 'boolean' || typeof ancestor[key] === 'number') safe[key] = ancestor[key] as boolean | number
    }
    return safe
  })
  return result
}

/** Upload through the page's own file input, then submit exactly once. */
export async function sendPageFiles(
  contents: WebContents,
  platformId: FileReadingPlatform['id'],
  attachments: PreparedAttachment[],
  token: string,
  current: () => boolean,
  signal: AbortSignal
): Promise<FileSendOutcome> {
  const debuggerApi = contents.debugger
  let attached = false
  let submitted = false
  let detached = false
  let uploadError = false
  const ownerUrl = contents.getURL()
  const started = Date.now()
  let stage = 'begin'
  const log = (event: string, details: Record<string, unknown> = {}): void => writeDiagnostic(platformId, token, event, { platformId, stage, elapsedMs: Date.now() - started, ...details })
  const finish = (outcome: FileSendOutcome, reason: string): FileSendOutcome => {
    log('finish', { outcome, reason, submitted })
    if (outcome !== 'ok') console.warn(`[files:${platformId}] ${outcome} at ${stage}: ${reason}; log: ${diagnosticLogPaths.get(platformId) ?? 'unavailable'}`)
    return outcome
  }
  log('start', { attachmentCount: attachments.length, attachments: attachments.map(({ mimeType, sizeBytes, textNameAlias }) => ({ mimeType, sizeBytes, textNameAlias: !!textNameAlias })) })
  const pending = new Set<string>()
  const call = async (method: string, ...args: unknown[]): Promise<unknown> => {
    if (!current() || signal.aborted || contents.isDestroyed()) throw new Error('cancelled')
    return contents.executeJavaScript(`window.__cmdTerminalInterceptor?.${method}(${args.map((arg) => JSON.stringify(arg)).join(',')})`)
  }
  const command = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    let timer: NodeJS.Timeout | undefined
    try {
      log('cdp-start', { method })
      const result = await Promise.race([
        debuggerApi.sendCommand(method, params) as Promise<Record<string, unknown>>,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('CDP 操作超时')), 5000) })
      ])
      log('cdp-done', { method })
      return result
    } finally { if (timer) clearTimeout(timer) }
  }
  const onDetach = (): void => { detached = true; log('debugger-detached') }
  const onMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>): void => {
    const id = String(params.requestId ?? '')
    if (method === 'Network.requestWillBeSent') {
      const request = params.request as { method?: string; headers?: Record<string, string> } | undefined
      const type = Object.entries(request?.headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? ''
      if (request?.method === 'PUT' || (request?.method === 'POST' && /multipart\/form-data|application\/octet-stream|image\//i.test(type))) {
        pending.add(id)
        log('upload-request', { requestId: id, method: request.method, pending: pending.size })
      }
    } else if (method === 'Network.responseReceived' && pending.has(id)) {
      const response = params.response as { status?: number } | undefined
      if ((response?.status ?? 200) >= 400) uploadError = true
      log('upload-response', { requestId: id, status: response?.status })
    } else if (method === 'Network.loadingFailed' || method === 'Network.loadingFinished') {
      if (pending.has(id)) {
        if (method === 'Network.loadingFailed') uploadError = true
        log('upload-complete', { requestId: id, failed: method === 'Network.loadingFailed', errorText: params.errorText })
      }
      pending.delete(id)
    }
  }
  try {
    if (!current() || signal.aborted) return finish('cancelled', 'context-changed')
    if (!attachments.length) return finish('upload-failed', 'no-attachments')
    if (attachments.length && debuggerApi.isAttached()) return finish('upload-failed', 'debugger-already-attached')
    const begin = await call('beginFileSend', token, attachments.map(({ fileName, mimeType, sizeBytes }) => ({ fileName, mimeType, sizeBytes })))
    log('begin-result', { result: begin ?? 'missing-handler' })
    if (begin !== 'ok' && begin !== 'resume') {
      try { log('page-diagnostics', diagnosticSnapshot(await call('attachmentDiagnostics'))) } catch { log('page-diagnostics-unavailable') }
      return finish(begin === 'busy' || begin === 'no-composer' || begin === 'insert-failed' || begin === 'unsupported-file-type' ? begin : 'upload-failed', typeof begin === 'string' ? begin : 'missing-handler')
    }
    if (attachments.length) {
      stage = 'debugger-attach'
      // Do not detach someone else's debugger or borrow their Network listeners.
      if (debuggerApi.isAttached()) return finish('upload-failed', 'debugger-already-attached')
      debuggerApi.attach('1.3')
      attached = true
      debuggerApi.on('detach', onDetach)
      debuggerApi.on('message', onMessage)
      await command('Network.enable')
    }
    if (attachments.length && begin === 'ok') {
      stage = 'file-input'
      if (!current() || signal.aborted) return finish('cancelled', 'context-changed')
      if (await call('refreshFileInput', token) !== true) return finish('upload-failed', 'file-input-refresh-failed')
      const document = await command('DOM.getDocument', { depth: 0 })
      const root = document.root as { nodeId: number }
      const input = await command('DOM.querySelector', { nodeId: root.nodeId, selector: `input[data-codex-file-input="${token}"]` })
      if (!input.nodeId) return finish('upload-failed', 'file-input-node-missing')
      if (!current() || signal.aborted) return finish('cancelled', 'context-changed')
      stage = 'file-selection'
      await command('DOM.setFileInputFiles', { nodeId: input.nodeId, files: attachments.map((file) => file.path) })
      await call('fileSelectionApplied', token)
      log('files-selected', { count: attachments.length })
    }
    stage = 'upload-wait'
    const deadline = Date.now() + (attachments.length ? 120000 : 10000)
    let readySince = 0
    let previousSnapshot = ''
    let lastSnapshotAt = 0
    let lastPageDiagnosticsAt = 0
    while (Date.now() < deadline) {
      if (!current() || signal.aborted) return finish('cancelled', 'context-changed')
      if (detached || uploadError) return finish('upload-failed', detached ? 'debugger-detached' : 'upload-network-error')
      const snapshot = await call('fileSendStatus', token) as { status?: string; namesSeen?: boolean }
      const diagnostics = { ...diagnosticSnapshot(snapshot), pendingRequests: pending.size }
      const signature = JSON.stringify(diagnostics)
      if (signature !== previousSnapshot || Date.now() - lastSnapshotAt >= 10000) {
        log('upload-state', diagnostics)
        previousSnapshot = signature
        lastSnapshotAt = Date.now()
      }
      if (snapshot?.status === 'uploading' && snapshot.namesSeen === false && (!lastPageDiagnosticsAt || Date.now() - lastPageDiagnosticsAt >= 10000)) {
        try { log('page-diagnostics', diagnosticSnapshot(await call('attachmentDiagnostics'))) } catch { log('page-diagnostics-unavailable') }
        lastPageDiagnosticsAt = Date.now()
      }
      if (snapshot?.status === 'busy') return finish('busy', 'draft-changed')
      if (snapshot?.status === 'stale' || snapshot?.status === 'no-composer' || snapshot?.status === 'upload-failed') return finish('upload-failed', snapshot.status)
      if (snapshot?.status === 'ready' && pending.size === 0) {
        readySince ||= Date.now()
        if (Date.now() - readySince >= 1000) break
      } else readySince = 0
      await pause(250)
    }
    if (!readySince || Date.now() >= deadline) return finish('upload-failed', 'upload-ready-timeout')
    if (!current() || signal.aborted) return finish('cancelled', 'context-changed')
    stage = 'submit'
    // From this point, a context loss is ambiguous; never automatically click again.
    submitted = true
    const clicked = await call('submitFileSend', token)
    log('submit-result', { clicked: clicked === true })
    if (clicked !== true) { submitted = false; return finish('upload-failed', 'submit-not-confirmed') }
    stage = 'confirm'
    const confirmDeadline = Date.now() + 10000
    let previousConfirmation = ''
    let lastConfirmDiagnosticsAt = 0
    while (Date.now() < confirmDeadline) {
      if (contents.isDestroyed() || contents.getURL() !== ownerUrl || detached) return finish('unknown', 'page-changed-after-submit')
      // A fast next action can supersede this run; still read the acknowledgement.
      const snapshot = await contents.executeJavaScript(`window.__cmdTerminalInterceptor?.fileSendStatus(${JSON.stringify(token)})`) as { status?: string }
      const diagnostics = diagnosticSnapshot(snapshot)
      const signature = JSON.stringify(diagnostics)
      if (signature !== previousConfirmation) { log('confirm-state', diagnostics); previousConfirmation = signature }
      if (snapshot?.status === 'sent') return finish('ok', 'message-confirmed')
      if (!current() || signal.aborted) return finish('unknown', 'context-changed-after-submit')
      if (diagnostics.newTurnSeen === true && diagnostics.turnFilesSeen === false && (!lastConfirmDiagnosticsAt || Date.now() - lastConfirmDiagnosticsAt >= 3000)) {
        try { log('confirmation-diagnostics', diagnosticSnapshot(await call('attachmentDiagnostics'))) } catch { log('confirmation-diagnostics-unavailable') }
        lastConfirmDiagnosticsAt = Date.now()
      }
      await pause(150)
    }
    return finish('unknown', 'message-confirm-timeout')
  } catch (error) {
    log('exception', { message: (error as Error).message?.slice(0, 500) })
    return finish(submitted ? 'unknown' : signal.aborted || !current() ? 'cancelled' : 'upload-failed', 'exception')
  } finally {
    if (!contents.isDestroyed()) {
      try {
        const released = await contents.executeJavaScript(`window.__cmdTerminalInterceptor?.releaseFileSend(${JSON.stringify(token)})`)
        log('release-result', { released: released === true, submitted })
      } catch { log('release-unavailable') }
    }
    if (attached) {
      debuggerApi.removeListener('message', onMessage)
      debuggerApi.removeListener('detach', onDetach)
      try { if (!detached && debuggerApi.isAttached()) debuggerApi.detach() } catch { /* destroyed contents */ }
    }
  }
}
