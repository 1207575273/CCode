// src/App.tsx

import { ChatPage } from './pages/ChatPage.js'

/** 从 URL 路径中提取 sessionId: /session/:id */
function getSessionIdFromUrl(): string | null {
  const match = window.location.pathname.match(/^\/session\/(.+)/)
  return match ? match[1]! : null
}

export function App() {
  const sessionId = getSessionIdFromUrl()
  return <ChatPage targetSessionId={sessionId} />
}
