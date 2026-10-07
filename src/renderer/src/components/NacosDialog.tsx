import type { ReactElement } from 'react'
import type { AppTheme } from '../../../shared/types'

interface NacosDialogProps {
  open: boolean
  theme: AppTheme
  onClose: () => void
}

/**
 * The Nacos connection page, opened from the toolbox.
 *
 * Full-screen like the Git and MySQL dialogs next to it, because a connection form plus
 * whatever service/config browsing comes later does not belong in a small card. Only the
 * shell exists for now: the connection form, service list and config management are the
 * next steps, so nothing here pretends to have tested a connection yet.
 */
export default function NacosDialog({ open, theme, onClose }: NacosDialogProps): ReactElement | null {
  if (!open) return null

  return (
    <div
      className={theme === 'dark' ? 'modal modal--nacos nacos-page--dark' : 'modal modal--nacos'}
      role="dialog"
      aria-modal="true"
      aria-label="Nacos 连接"
    >
      <div className="nacos-page">
        <header className="nacos-page__head">
          <div className="nacos-page__mark">
            <svg width="26" height="26" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <circle cx="7" cy="12" r="3.1" fill="#267FFF" />
              <circle cx="17" cy="6.5" r="3.1" fill="#267FFF" />
              <circle cx="17" cy="17.5" r="3.1" fill="#267FFF" />
              <path d="M7 12 17 6.5M7 12 17 17.5" stroke="#267FFF" strokeWidth="1.5" strokeLinecap="round" opacity="0.55" />
            </svg>
          </div>

          <div className="nacos-page__titles">
            <h2 className="nacos-page__title">Nacos 连接</h2>
            <p className="nacos-page__sub">配置管理与服务发现</p>
          </div>

          <button type="button" className="nacos-page__close" aria-label="关闭" onClick={onClose}>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div className="nacos-page__body">
          <div className="nacos-page__empty">
            <div className="nacos-page__empty-mark">
              <svg width="40" height="40" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <circle cx="7" cy="12" r="3.1" fill="currentColor" />
                <circle cx="17" cy="6.5" r="3.1" fill="currentColor" />
                <circle cx="17" cy="17.5" r="3.1" fill="currentColor" />
                <path d="M7 12 17 6.5M7 12 17 17.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.55" />
              </svg>
            </div>
            <h3 className="nacos-page__empty-title">尚未连接 Nacos</h3>
            <p className="nacos-page__empty-sub">连接与配置管理功能即将上线，敬请期待。</p>
          </div>
        </div>
      </div>
    </div>
  )
}