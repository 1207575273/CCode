import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles/globals.css'

// 首次加载立即应用主题，避免白闪
;(() => {
  const stored = localStorage.getItem('theme')
  const isDark = stored !== 'light'
  document.documentElement.classList.toggle('dark', isDark)
})()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
