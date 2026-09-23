import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ManagerApp from './ManagerApp'
import './assets/main.css'

const container = document.getElementById('root')

if (!container) {
  throw new Error('Renderer bootstrap failed: no element with id "root" was found.')
}

createRoot(container).render(
  <StrictMode>
    {new URLSearchParams(window.location.search).get('view') === 'manager' ? <ManagerApp /> : <App />}
  </StrictMode>
)
