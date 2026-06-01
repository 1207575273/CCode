// src/core/initializer.ts

/**
 * 启动初始化器 — 在 CLI 入口最早期执行，确保运行环境就绪。
 *
 * 职责：
 * 1. 确保 ~/.ccode/ 目录存在（全局配置）
 * 2. 确保 config.json 存在且关键字段完整
 * 3. 确保 .mcp.json 存在（空模板）
 * 4. 确保项目级 .ccode/ 目录和 settings.local.json 存在（项目权限配置）
 * 5. 启动诊断：当前 provider 是否配了 apiKey
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { configManager } from '../config/config-manager.js'
import { ccodeHome } from '../platform/path-utils.js'

/** 初始化基础目录路径（经 ccodeHome() 防御式解析，支持 CCODE_HOME 覆盖） */
const CCODE_HOME = ccodeHome()
const MCP_CONFIG_PATH = join(CCODE_HOME, '.mcp.json')

/** .mcp.json 默认模板 */
const DEFAULT_MCP_CONFIG = {
  mcpServers: {},
}

/** settings.local.json 默认模板 — 空权限，遵循默认询问机制 */
const DEFAULT_LOCAL_SETTINGS = {
  permissions: {
    allow: [],
  },
}

/**
 * hooks.json 默认模板 — 内置 PostToolUse 验证 hook。
 *
 * 对 TypeScript 项目：write_file / edit_file 后自动跑 tsc --noEmit，
 * 诊断结果通过 additionalContext 注入 LLM 上下文，引导自动修正。
 *
 * 优先级：项目级 > 用户级（bootstrap.ts 按 plugin → project → user 顺序加载，
 * 同名 matcher 全部执行，不覆盖）。
 *
 * 用户可按项目语言自行修改检查命令（Python → ruff、Rust → cargo check 等）。
 */
const DEFAULT_HOOKS_CONFIG = {
  hooks: {
    PostToolUse: [
      {
        matcher: '^(write_file|edit_file)$',
        hooks: [
          {
            type: 'command',
            // TypeScript 项目：检测 tsconfig.json 存在才跑 tsc --noEmit
            command: 'if [ -f tsconfig.json ]; then result=$(npx tsc --noEmit 2>&1 | head -30); if [ -n "$result" ]; then echo "{\\"additionalContext\\":\\"TypeScript check:\\n$result\\"}"; fi; fi',
            timeout: 20000,
          },
          {
            type: 'command',
            // Java 项目：检测 pom.xml（Maven）或 build.gradle（Gradle）存在才编译检查
            // Maven: mvn compile -q 静默编译，只输出错误
            // Gradle: gradle compileJava -q 静默编译
            command: 'if [ -f pom.xml ]; then result=$(mvn compile -q 2>&1 | tail -30); if echo "$result" | grep -qi "error"; then echo "{\\"additionalContext\\":\\"Java Maven check:\\n$result\\"}"; fi; elif [ -f build.gradle ] || [ -f build.gradle.kts ]; then result=$(gradle compileJava -q 2>&1 | tail -30); if echo "$result" | grep -qi "error"; then echo "{\\"additionalContext\\":\\"Java Gradle check:\\n$result\\"}"; fi; fi',
            timeout: 60000,
          },
        ],
      },
    ],
  },
}

export interface InitDiagnostic {
  /** 是否有配置问题需要警告用户 */
  warnings: string[]
  /** 初始化过程中创建了哪些文件 */
  created: string[]
}

/**
 * 执行启动初始化，返回诊断信息。
 * 幂等：已存在的文件不会被覆盖。
 */
export function initialize(): InitDiagnostic {
  const warnings: string[] = []
  const created: string[] = []

  // 1. 确保 ~/.ccode/ 目录存在
  if (!existsSync(CCODE_HOME)) {
    mkdirSync(CCODE_HOME, { recursive: true })
  }

  // 2. 配置文件：委托给 ConfigManager（唯一配置 IO 权威）
  //    - 不存在 → 写默认 config.yml
  //    - 存在旧 config.json → 迁移为 config.yml（回读校验通过才切换，否则降级保留 JSON）
  //    - 损坏 → 备份并重置
  //    - 顺带做 apiKey 诊断
  //    取代了此处原先直接读写 config.json 的逻辑，避免与 ConfigManager 双写打架。
  const configInit = configManager.ensureInitialized()
  created.push(...configInit.created)
  warnings.push(...configInit.warnings)

  // 3. 确保 .mcp.json 存在
  if (!existsSync(MCP_CONFIG_PATH)) {
    writeFileSync(MCP_CONFIG_PATH, JSON.stringify(DEFAULT_MCP_CONFIG, null, 2), 'utf-8')
    created.push(MCP_CONFIG_PATH)
  }

  // 4. 确保项目级 .ccode/settings.local.json 存在
  const projectCcodeDir = join(process.cwd(), '.ccode')
  const localSettingsPath = join(projectCcodeDir, 'settings.local.json')
  if (!existsSync(localSettingsPath)) {
    if (!existsSync(projectCcodeDir)) {
      mkdirSync(projectCcodeDir, { recursive: true })
    }
    writeFileSync(localSettingsPath, JSON.stringify(DEFAULT_LOCAL_SETTINGS, null, 2), 'utf-8')
    created.push(localSettingsPath)
  }

  // 5. 确保 hooks.json 存在（项目级 + 用户级）
  //    bootstrap 加载顺序：plugin → project → user，规则叠加执行。
  //    项目级放完整默认规则（tsc 检查等），用户级放空模板（避免重复执行）。
  //    用户可按需修改任意一级的 hooks.json 自定义检查命令。
  const projectHooksPath = join(projectCcodeDir, 'hooks.json')
  if (!existsSync(projectHooksPath)) {
    if (!existsSync(projectCcodeDir)) {
      mkdirSync(projectCcodeDir, { recursive: true })
    }
    writeFileSync(projectHooksPath, JSON.stringify(DEFAULT_HOOKS_CONFIG, null, 2), 'utf-8')
    created.push(projectHooksPath)
  }
  const userHooksPath = join(CCODE_HOME, 'hooks.json')
  if (!existsSync(userHooksPath)) {
    // 用户级为空模板，避免和项目级重复执行。
    // 用户可在此配全局规则（所有项目生效）。
    writeFileSync(userHooksPath, JSON.stringify({ hooks: {} }, null, 2), 'utf-8')
    created.push(userHooksPath)
  }

  // apiKey 诊断已并入步骤 2 的 configManager.ensureInitialized()

  return { warnings, created }
}
