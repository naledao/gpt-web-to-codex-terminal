import type { ReactElement } from 'react'
import type { AppTheme } from '../../../shared/types'
import CodeViewer from './CodeViewer'

interface SqlViewerProps {
  value: string
  theme: AppTheme
  label: string
  compact?: boolean
}

/** Keep the SQL viewer API while sharing read-only controls with JSON viewing. */
export default function SqlViewer(props: SqlViewerProps): ReactElement {
  return <CodeViewer {...props} language="sql" />
}
