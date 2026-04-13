// src/components/Toast.tsx

import { useState, useCallback, createContext, useContext } from 'react'

interface ToastItem {
  id: number
  message: string
  type: 'success' | 'error'
}

interface ToastContextValue {
  success: (message: string) => void
  error: (message: string) => void
}

const ToastContext = createContext<ToastContextValue>({ success: () => {}, error: () => {} })

export function useToast(): ToastContextValue {
  return useContext(ToastContext)
}

let idCounter = 0

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const add = useCallback((message: string, type: 'success' | 'error') => {
    const id = ++idCounter
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000)
  }, [])

  const success = useCallback((message: string) => add(message, 'success'), [add])
  const error = useCallback((message: string) => add(message, 'error'), [add])

  return (
    <ToastContext.Provider value={{ success, error }}>
      {children}
      {/* Toast 容器 */}
      <div className="fixed top-4 right-4 z-50 space-y-2">
        {toasts.map(t => (
          <div key={t.id} className={`px-4 py-2 rounded-lg shadow-lg text-sm animate-fade-in ${
            t.type === 'success' ? 'bg-success text-white' : 'bg-error text-white'
          }`}>
            {t.type === 'success' ? '✓ ' : '✗ '}{t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
