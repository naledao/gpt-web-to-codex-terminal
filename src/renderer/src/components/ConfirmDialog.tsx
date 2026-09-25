import { useEffect } from 'react'
import type { ReactElement, ReactNode } from 'react'

export interface ConfirmDialogItem {
  icon: ReactNode
  label: string
  value: string
  tone?: 'danger' | 'success' | 'neutral'
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  description?: string
  icon?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  busy?: boolean
  danger?: boolean
  dismissOnBackdrop?: boolean
  dismissOnEscape?: boolean
  items?: ConfirmDialogItem[]
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  open,
  title,
  description,
  icon = '!',
  confirmLabel = '确认',
  cancelLabel = '取消',
  busy = false,
  danger = false,
  dismissOnBackdrop = true,
  dismissOnEscape = true,
  items = [],
  onConfirm,
  onCancel
}: ConfirmDialogProps): ReactElement | null {
  useEffect(() => {
    if (!open || busy || !dismissOnEscape) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, busy, dismissOnEscape, onCancel])

  if (!open) return null

  return (
    <div
      className="confirm-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy && dismissOnBackdrop) onCancel()
      }}
    >
      <div className="confirm-dialog__box">
        <button type="button" className="confirm-dialog__close" aria-label="关闭" disabled={busy} onClick={onCancel}>×</button>
        <div className={danger ? 'confirm-dialog__icon confirm-dialog__icon--danger' : 'confirm-dialog__icon'}>{icon}</div>
        <h2 className="confirm-dialog__title">{title}</h2>
        {description ? <p className="confirm-dialog__description">{description}</p> : null}
        {items.length > 0 ? (
          <div className="confirm-dialog__items">
            {items.map((item, index) => (
              <div className="confirm-dialog__item" key={`${item.label}-${index}`}>
                <span className="confirm-dialog__item-icon">{item.icon}</span>
                <span className="confirm-dialog__item-label">{item.label}</span>
                <span className={`confirm-dialog__badge confirm-dialog__badge--${item.tone ?? 'neutral'}`}>{item.value}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="confirm-dialog__foot">
          <button type="button" className="confirm-dialog__cancel" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className={danger ? 'confirm-dialog__confirm confirm-dialog__confirm--danger' : 'confirm-dialog__confirm'} disabled={busy} onClick={onConfirm}>
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}