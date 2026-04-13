// src/App.tsx

import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom'
import { ToastProvider } from './components/Toast'
import { Sidebar } from './components/Sidebar'
import { ChatPage } from './pages/ChatPage'

// 路由懒加载：非核心页面按需加载，减小首屏 bundle
const OverviewPage = lazy(() => import('./pages/OverviewPage').then(m => ({ default: m.OverviewPage })))
const ConversationsPage = lazy(() => import('./pages/ConversationsPage').then(m => ({ default: m.ConversationsPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })))
const LogsPage = lazy(() => import('./pages/LogsPage').then(m => ({ default: m.LogsPage })))

/** ChatPage 包装器：从 URL 提取 sessionId */
function ChatPageWrapper() {
  const { sessionId } = useParams<{ sessionId: string }>()
  return <ChatPage targetSessionId={sessionId ?? null} />
}

/** 懒加载 fallback */
function PageLoading() {
  return (
    <div className="flex items-center justify-center h-full text-txt-muted">
      <span className="animate-pulse">Loading...</span>
    </div>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
      <div className="flex h-screen bg-base text-txt-primary">
        <Sidebar />
        <div className="flex-1 overflow-y-auto">
          <Suspense fallback={<PageLoading />}>
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
          </Suspense>
        </div>
      </div>
      </ToastProvider>
    </BrowserRouter>
  )
}
