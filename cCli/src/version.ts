/**
 * 应用版本号 — 运行时唯一 source of truth
 *
 * bump 版本时需同步修改的位置（共 3 处）：
 *   1. 本文件 APP_VERSION
 *   2. cCli/package.json       → "version" 字段（npm 发布必需）
 *   3. cCli/web/package.json   → "version" 字段（Web 端独立包）
 *
 * 以下位置通过 import 引用本常量，无需手动改动：
 *   - bin/ccli.ts              → --help / --version 输出
 *   - src/ui/WelcomeScreen.tsx → 欢迎界面版本显示
 *   - src/mcp/mcp-manager.ts   → MCP Client 注册版本号
 */
export const APP_VERSION = '0.11.0'
