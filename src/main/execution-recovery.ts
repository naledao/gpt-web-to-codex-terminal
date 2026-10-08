import type { DatabaseSync } from 'node:sqlite'

export const RESTART_INTERRUPTION_NOTICE = '软件在执行期间关闭或异常退出，原执行会话无法恢复；未取得完整结果，请检查实际状态后重新发起指令。'
export const CLOSE_INTERRUPTION_NOTICE = '执行会话已关闭，未取得完整执行结果；请检查实际状态后重新发起指令。'

/** Run once when opening the store, before any execution shell is restored. */
export function recoverInterruptedExecutions(db: DatabaseSync, finishedAt = Date.now()): number {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = db.prepare(`
      UPDATE executions
         SET status = 'interrupted', exit_code = NULL,
             finished_at = COALESCE(finished_at, ?),
             output = CASE WHEN output = '' THEN ? ELSE output || char(10) || ? END,
             delivery_status = CASE
               WHEN kind = 'read_files' THEN CASE WHEN delivery_status = 'uploading' THEN 'unknown' ELSE 'cancelled' END
               ELSE delivery_status END
       WHERE status = 'running'
    `).run(finishedAt, RESTART_INTERRUPTION_NOTICE, RESTART_INTERRUPTION_NOTICE)
    // A crashed process cannot prove whether an in-progress upload was submitted.
    db.exec("UPDATE executions SET delivery_status = 'unknown' WHERE kind = 'read_files' AND delivery_status = 'uploading'")
    db.exec("UPDATE executions SET delivery_status = 'cancelled' WHERE kind = 'read_files' AND status IN ('done', 'failed') AND delivery_status IN ('pending', 'failed')")
    db.exec('COMMIT')
    return Number(result.changes)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Close only commands owned by this runner; other sessions may still be executing. */
export function interruptRunningCommands(db: DatabaseSync, messageIds: Iterable<string>, finishedAt = Date.now()): void {
  const update = db.prepare(`
    UPDATE executions
       SET status = 'interrupted', exit_code = NULL,
           finished_at = COALESCE(finished_at, ?),
           output = CASE WHEN output = '' THEN ? ELSE output || char(10) || ? END
     WHERE message_id = ? AND kind = 'command' AND status = 'running'
  `)
  for (const messageId of messageIds) {
    update.run(finishedAt, CLOSE_INTERRUPTION_NOTICE, CLOSE_INTERRUPTION_NOTICE, messageId)
  }
}
