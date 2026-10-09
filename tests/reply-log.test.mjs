// User-run offline checks: temporary files only, no Electron, browser, network or shell.
// Run: node --experimental-strip-types --test tests/reply-log.test.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ReplyDiagnosticLog, replyDiagnosticMetadata } from '../src/main/reply-log.ts'

const context = { viewId: 7, conversationId: 'dfc47d69-0249-4885-9370-5f5a00eb41a6', mainPendingQuestion: false }
const payload = { event: 'scan', reason: 'question-not-live', messageId: 'text:b4ffcd9a:597', awaitingReply: false, replyKind: 'questions' }
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'reply-log-test-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}
const records = (path) => readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line.slice(line.indexOf(' ') + 1)))

test('scan metadata preserves correlation and waiting/generation evidence', () => {
  const value = replyDiagnosticMetadata('claude', {
    ...payload, awaitingReplyBefore: true, replyStreamingState: 'true',
    stopButtonFound: false, stopButtonOnPage: true, answerMarkerFound: false, replyTextLength: 597
  }, context)
  assert.equal(value.conversationId, context.conversationId)
  assert.equal(value.viewId, 7)
  assert.equal(value.messageId, payload.messageId)
  assert.equal(value.reason, 'question-not-live')
  assert.equal(value.awaitingReplyBefore, true)
  assert.equal(value.replyStreamingState, 'true')
  assert.equal(value.stopButtonFound, false)
  assert.equal(value.stopButtonOnPage, true)
})

test('default traces omit commands, question content, page text and unrecognized values', () => {
  const secret = 'sensitive-sentinel'
  const value = replyDiagnosticMetadata('claude', {
    ...payload, reason: secret, messageId: `https://example.test/${secret}`,
    command: secret, text: secret, textHead: secret, lastObject: secret, cls: secret,
    selectors: [secret], questions: [{ question: secret, placeholder: secret }],
    replyKind: secret, replyStreamingState: secret
  }, context)
  assert.equal(value.reason, 'unknown')
  assert.equal(value.messageId, null)
  assert.equal(value.commandLength, secret.length)
  assert.equal(value.textLength, secret.length)
  assert.equal(value.questionCount, 1)
  assert.ok(!JSON.stringify(value).includes(secret))
})

test('main-process acceptance is retained without question text', () => {
  const value = replyDiagnosticMetadata('claude', {
    event: 'question', messageId: 'text:a123:200', live: true,
    questions: [{ question: 'private question' }], pendingQuestionFound: true
  }, { ...context, questionAccepted: true, mainPendingQuestion: true })
  assert.equal(value.questionAccepted, true)
  assert.equal(value.mainPendingQuestion, true)
  assert.equal(value.questionCount, 1)
  assert.ok(!JSON.stringify(value).includes('private question'))
})

test('reply tracing writes synchronously with the optional app log disabled', (t) => {
  const previous = process.env.DSH_APP_LOG
  process.env.DSH_APP_LOG = '0'
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_APP_LOG
    else process.env.DSH_APP_LOG = previous
  })
  const log = new ReplyDiagnosticLog(directory(t))
  const path = log.write('claude', payload, context)
  assert.ok(path)
  assert.equal(records(path)[0].reason, 'question-not-live')
  assert.equal(records(path)[0].sequence, 1)
})

test('rotation preserves earlier records and monotonic event sequence', (t) => {
  const path = directory(t)
  const log = new ReplyDiagnosticLog(path, 1)
  const first = log.write('claude', payload, context)
  const second = log.write('claude', { event: 'reply-state', reason: 'non-command-reply', awaitingReplyBefore: true, awaitingReply: false }, context)
  assert.notEqual(first, second)
  assert.equal(readdirSync(path).length, 2)
  assert.equal(records(first)[0].sequence, 1)
  assert.equal(records(second)[0].sequence, 2)
})

test('unrelated reports do not create logs and filesystem failures do not escape', (t) => {
  const parent = directory(t)
  const unused = join(parent, 'unused')
  assert.equal(new ReplyDiagnosticLog(unused).write('claude', { event: 'theme' }, context), null)
  assert.equal(existsSync(unused), false)
  const blocked = join(parent, 'not-a-directory')
  writeFileSync(blocked, 'fixture')
  const log = new ReplyDiagnosticLog(blocked)
  assert.doesNotThrow(() => assert.equal(log.write('claude', payload, context), null))
})

test('watchdog logs retain hidden-message and debounce evidence without answer content', (t) => {
  const log = new ReplyDiagnosticLog(directory(t))
  const path = log.write('chatgpt', {
    event: 'reply-watchdog', messageId: 'old-message', lastVisibleMessageId: 'new-message',
    visibleAnswerOwnerMessageId: 'new-message', selectedNodeVisible: false, selectedReplyVisible: false,
    selectedMatchesLastVisible: false, visibleAssistantTurnCount: 1, visibleAnswerMarkerCount: 1,
    lastVisibleReplyKind: 'command', visibleAnswerKind: 'command', lastVisibleReplyTextLength: 900,
    visibleAnswerTextLength: 900, visibleCodeBlockCount: 1, replySettlePending: true,
    fileSendPending: false, lastScanAgeMs: 12000, lastMutationAgeMs: 50,
    textHead: 'private-answer-sentinel', visibleAnswerText: 'private-answer-sentinel'
  }, context)
  const value = records(path)[0]
  assert.equal(value.event, 'reply-watchdog')
  assert.equal(value.lastVisibleMessageId, 'new-message')
  assert.equal(value.visibleAnswerOwnerMessageId, 'new-message')
  assert.equal(value.selectedNodeVisible, false)
  assert.equal(value.visibleAnswerKind, 'command')
  assert.equal(value.replySettlePending, true)
  assert.equal(value.lastScanAgeMs, 12000)
  assert.equal(value.lastMutationAgeMs, 50)
  assert.ok(!readFileSync(path, 'utf8').includes('private-answer-sentinel'))
})

test('watchdog identifiers and age values are validated and missing scan ages remain explicit', () => {
  const value = replyDiagnosticMetadata('chatgpt', {
    event: 'reply-watchdog', lastVisibleMessageId: 'https://private.test/secret',
    visibleAnswerOwnerMessageId: 'valid-message', lastScanAgeMs: null, lastMutationAgeMs: -1,
    visibleAnswerTextLength: Infinity, lastVisibleReplyKind: 'invalid'
  }, context)
  assert.equal(value.lastVisibleMessageId, null)
  assert.equal(value.visibleAnswerOwnerMessageId, 'valid-message')
  assert.equal(value.lastScanAgeMs, null)
  assert.equal(value.lastMutationAgeMs, undefined)
  assert.equal(value.visibleAnswerTextLength, undefined)
  assert.equal(value.lastVisibleReplyKind, undefined)
})
