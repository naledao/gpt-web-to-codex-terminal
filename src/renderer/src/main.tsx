import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import WorkspaceApp from './WorkspaceApp'
import '@svar-ui/react-filemanager/all.css'
import './assets/main.css'

const container = document.getElementById('root')

if (!container) {
  throw new Error('Renderer bootstrap failed: no element with id "root" was found.')
}

createRoot(container).render(
  <StrictMode>
    <WorkspaceApp />
  </StrictMode>
)
