import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app/App'
import './styles/app.css'

const container = document.getElementById('root') ?? document.body

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
