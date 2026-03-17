// src/components/Sidebar.tsx

import { NavLink } from 'react-router-dom'

const NAV_ITEMS = [
  { to: '/session', icon: '💬', label: '聊天' },
  { to: '/overview', icon: '📊', label: '总览大盘' },
  { to: '/conversations', icon: '📋', label: '对话历史' },
  { to: '/settings', icon: '⚙️', label: '设置管理' },
  { to: '/logs', icon: '📜', label: '日志浏览', disabled: true },
]

export function Sidebar() {
  return (
    <nav className="w-40 bg-gray-900 border-r border-gray-700 flex flex-col py-3 px-2 gap-1 shrink-0">
      <div className="text-xs text-gray-500 font-semibold px-2 mb-2 tracking-wide">ZCli</div>
      {NAV_ITEMS.map(item => (
        item.disabled ? (
          <div
            key={item.to}
            className="flex items-center gap-2 px-2 py-2 rounded-lg text-gray-600 cursor-not-allowed"
            title={`${item.label}（开发中）`}
          >
            <span className="text-base">{item.icon}</span>
            <span className="text-sm">{item.label}</span>
          </div>
        ) : (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-2 px-2 py-2 rounded-lg transition-colors ${
                isActive
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
              }`
            }
          >
            <span className="text-base">{item.icon}</span>
            <span className="text-sm">{item.label}</span>
          </NavLink>
        )
      ))}
    </nav>
  )
}
