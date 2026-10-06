interface ScrollSnapshot {
  scrollTop: number
  stickToBottom: boolean
  anchorId?: string
  anchorOffset?: number
}

const STORAGE_PREFIX = 'conversation.scroll.v1.'
const snapshots = new Map<string, ScrollSnapshot>()
const BOTTOM_THRESHOLD = 24

/** A workspace, platform and actual conversation each own their reading position. */
export function conversationScrollKey(sessionId: string, platformId: string, conversationId: string | null): string {
  return JSON.stringify([sessionId, platformId, conversationId])
}

function loadSnapshot(key: string): ScrollSnapshot | null {
  const cached = snapshots.get(key)
  if (cached) return cached
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<ScrollSnapshot> | null
    if (!value || !Number.isFinite(value.scrollTop) || Number(value.scrollTop) < 0 || typeof value.stickToBottom !== 'boolean') return null
    const snapshot: ScrollSnapshot = {
      scrollTop: Number(value.scrollTop),
      stickToBottom: value.stickToBottom
    }
    if (typeof value.anchorId === 'string' && Number.isFinite(value.anchorOffset)) {
      snapshot.anchorId = value.anchorId
      snapshot.anchorOffset = value.anchorOffset
    }
    snapshots.set(key, snapshot)
    return snapshot
  } catch {
    return null
  }
}

function saveSnapshot(key: string, snapshot: ScrollSnapshot): void {
  snapshots.set(key, snapshot)
  try {
    // Only coordinates, a message ID and the bottom-follow flag; no message content.
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(snapshot))
  } catch {
    // The in-memory copy still survives view/session remounts when storage is unavailable.
  }
}

function distanceFromBottom(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop)
}

function captureSnapshot(element: HTMLElement): ScrollSnapshot {
  const snapshot: ScrollSnapshot = {
    scrollTop: Math.max(0, element.scrollTop),
    stickToBottom: distanceFromBottom(element) <= BOTTOM_THRESHOLD
  }
  if (snapshot.stickToBottom) return snapshot
  const top = element.getBoundingClientRect().top
  const messages = element.querySelectorAll<HTMLElement>('[data-message-id]')
  // Locate the first visible message without measuring every message on each scroll.
  let low = 0, high = messages.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (messages[middle].getBoundingClientRect().bottom <= top) low = middle + 1
    else high = middle
  }
  const anchor = messages[low]
  if (anchor) {
    snapshot.anchorId = anchor.dataset.messageId
    snapshot.anchorOffset = anchor.getBoundingClientRect().top - top
  }
  return snapshot
}

/** Bind only after this conversation's messages have loaded. Returns a complete teardown. */
export function attachConversationScroll(
  element: HTMLElement,
  content: HTMLElement,
  key: string,
  onAwayFromBottom: (away: boolean) => void
): { toBottom: () => void; dispose: () => void } {
  let snapshot = loadSnapshot(key) ?? { scrollTop: 0, stickToBottom: true }
  let expectedTop: number | null = null
  let layoutFrame: number | null = null
  let saveFrame: number | null = null
  let disposed = false

  const applyPosition = (): void => {
    if (disposed) return
    let target = snapshot.stickToBottom ? element.scrollHeight : snapshot.scrollTop
    if (!snapshot.stickToBottom && snapshot.anchorId !== undefined && snapshot.anchorOffset !== undefined) {
      const anchor = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find(message => message.dataset.messageId === snapshot.anchorId)
      if (anchor) target = element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - snapshot.anchorOffset
    }
    element.scrollTop = Math.max(0, target)
    expectedTop = element.scrollTop
    onAwayFromBottom(distanceFromBottom(element) > BOTTOM_THRESHOLD)
  }
  const onScroll = (): void => {
    if (disposed) return
    onAwayFromBottom(distanceFromBottom(element) > BOTTOM_THRESHOLD)
    // A restore/resize must not replace the desired anchor with a temporarily clamped one.
    if (expectedTop !== null && Math.abs(element.scrollTop - expectedTop) < 1) return
    expectedTop = null
    snapshot = captureSnapshot(element)
    if (saveFrame === null) saveFrame = window.requestAnimationFrame(() => {
      saveFrame = null
      saveSnapshot(key, snapshot)
    })
  }
  const observer = new ResizeObserver(() => {
    if (layoutFrame !== null || disposed) return
    layoutFrame = window.requestAnimationFrame(() => {
      layoutFrame = null
      applyPosition()
    })
  })

  applyPosition()
  element.addEventListener('scroll', onScroll, { passive: true })
  observer.observe(element)
  // One content wrapper also covers appended messages, markdown and late image loads.
  observer.observe(content)

  return {
    toBottom: () => {
      snapshot = { scrollTop: element.scrollHeight, stickToBottom: true }
      applyPosition()
      saveSnapshot(key, snapshot)
    },
    dispose: () => {
      disposed = true
      element.removeEventListener('scroll', onScroll)
      observer.disconnect()
      if (layoutFrame !== null) window.cancelAnimationFrame(layoutFrame)
      if (saveFrame !== null) window.cancelAnimationFrame(saveFrame)
      saveSnapshot(key, snapshot)
    }
  }
}
