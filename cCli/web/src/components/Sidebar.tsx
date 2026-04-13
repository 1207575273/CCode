// src/components/Sidebar.tsx

/**
 * Sidebar — 左侧导航栏。
 *
 * 结构（从上到下）：
 *   1. 品牌区：CCode + 版本号
 *   2. 导航列表：SVG 图标 + 文字，选中态左侧 accent 竖线
 *   3. 底部：主题切换（三态循环）
 */

import { NavLink } from 'react-router-dom'
import { IconChat, IconChart, IconHistory, IconSettings, IconScroll, IconSun, IconMoon, IconMonitor } from './icons'
import { useTheme } from '../hooks/useTheme'
import type { Theme } from '../hooks/useTheme'
import type { ComponentType } from 'react'

interface NavItem {
  to: string
  icon: ComponentType<{ size?: number; className?: string }>
  label: string
  disabled?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { to: '/session', icon: IconChat, label: '聊天' },
  { to: '/overview', icon: IconChart, label: '总览' },
  { to: '/conversations', icon: IconHistory, label: '历史' },
  { to: '/settings', icon: IconSettings, label: '设置' },
  { to: '/logs', icon: IconScroll, label: '日志', disabled: true },
]

/** 主题循环顺序与对应图标 */
const THEME_CYCLE: Theme[] = ['dark', 'light', 'system']
const THEME_ICON = { light: IconSun, dark: IconMoon, system: IconMonitor } as const
const THEME_LABEL = { light: '亮色', dark: '暗色', system: '系统' } as const

export function Sidebar() {
  const { theme, setTheme } = useTheme()

  const cycleTheme = () => {
    const idx = THEME_CYCLE.indexOf(theme)
    setTheme(THEME_CYCLE[(idx + 1) % THEME_CYCLE.length]!)
  }

  const ThemeIcon = THEME_ICON[theme]

  return (
    <nav className="w-[200px] bg-surface border-r border-border flex flex-col py-3 px-2 shrink-0">
      {/* 品牌区 */}
      <div className="px-3 mb-4">
        <div className="text-lg font-semibold text-txt-primary tracking-tight">CCode</div>
        <div className="text-xs text-txt-muted">CLI Agent</div>
      </div>

      {/* 导航列表 */}
      <div className="flex flex-col gap-0.5 flex-1">
        {NAV_ITEMS.map(item => {
          const Icon = item.icon
          if (item.disabled) {
            return (
              <div
                key={item.to}
                className="flex items-center gap-2.5 px-3 py-2 rounded-md text-txt-muted cursor-not-allowed"
                title={`${item.label}（开发中）`}
              >
                <Icon size={16} />
                <span className="text-sm">{item.label}</span>
              </div>
            )
          }
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `relative flex items-center gap-2.5 px-3 py-2 rounded-md transition-colors text-sm ${
                  isActive
                    ? 'bg-accent-subtle text-accent'
                    : 'text-txt-secondary hover:bg-elevated hover:text-txt-primary'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {/* 选中态左侧竖线指示器 */}
                  {isActive && (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent" />
                  )}
                  <Icon size={16} />
                  <span>{item.label}</span>
                </>
              )}
            </NavLink>
          )
        })}
      </div>

      {/* 底部：主题切换 */}
      <button
        onClick={cycleTheme}
        className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-txt-secondary hover:bg-elevated hover:text-txt-primary transition-colors"
        title={`主题: ${THEME_LABEL[theme]}（点击切换）`}
      >
        <ThemeIcon size={16} />
        <span>{THEME_LABEL[theme]}</span>
      </button>
    </nav>
  )
}
