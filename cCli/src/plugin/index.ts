// src/plugin/index.ts

export type {
  CCodePlugin,
  PluginContext,
  PluginCommand,
  InputAction,
  StatusBarItem,
  PluginStorage,
  LoadedPluginInfo,
  Disposable,
} from './types.js'

export { PluginRegistry, pluginRegistry } from './registry.js'
export type { PluginBridge } from './registry.js'
export { createPluginStorage } from './storage.js'
