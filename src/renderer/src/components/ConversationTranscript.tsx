import { useLayoutEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { attachConversationScroll } from '../conversation-scroll'

export default function ConversationTranscript({ scrollKey, ready, children }: {
  scrollKey: string
  ready: boolean
  children: ReactNode
}): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<ReturnType<typeof attachConversationScroll> | null>(null)
  const [awayFromBottom, setAwayFromBottom] = useState(false)

  useLayoutEffect(() => {
    if (!ready || !viewportRef.current || !contentRef.current) return
    const scroll = attachConversationScroll(viewportRef.current, contentRef.current, scrollKey, setAwayFromBottom)
    scrollRef.current = scroll
    return () => {
      scroll.dispose()
      scrollRef.current = null
    }
  }, [scrollKey, ready])

  return (
    <>
      <div className="conversation-transcript" ref={viewportRef} tabIndex={0} role="region" aria-label="会话记录">
        <div className="conversation-transcript__content" ref={contentRef}>{children}</div>
      </div>
      {ready && awayFromBottom ? (
        <button type="button" className="conversation-transcript__bottom-button" title="回到对话底部" aria-label="回到对话底部" onClick={() => scrollRef.current?.toBottom()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v14m-5-5 5 5 5-5M5 21h14" />
          </svg>
          回到底部
        </button>
      ) : null}
    </>
  )
}
