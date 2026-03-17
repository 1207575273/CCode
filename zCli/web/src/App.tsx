// src/App.tsx

import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom'
import { Sidebar } from './components/Sidebar'
import { ChatPage } from './pages/ChatPage'
import { OverviewPage } from './pages/OverviewPage'
import { ConversationsPage } from './pages/ConversationsPage'
import { SettingsPage } from './pages/SettingsPage'
import { LogsPage } from './pages/LogsPage'

/** ChatPage 包装器：从 URL 提取 sessionId */
function ChatPageWrapper() {
  const { sessionId } = useParams<{ sessionId: string }>()
  return <ChatPage targetSessionId={sessionId ?? null} />
}

export function App() {
  return (
    <BrowserRouter>
      <div className="flex h-screen bg-gray-950 text-gray-100">
        <Sidebar />
        <div className="flex-1 overflow-y-auto">
          <Routes>
            <Route path="/session/:sessionId" element={<ChatPageWrapper />} />
            <Route path="/session" element={<ChatPageWrapper />} />
            <Route path="/overview" element={<OverviewPage />} />
            <Route path="/conversations/:id" element={<ConversationsPage />} />
            <Route path="/conversations" element={<ConversationsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/" element={<Navigate to="/overview" replace />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  )
}
