// src/core/result-truncator.ts

/**
 * result-truncator — 工具结果截断策略单模块。
 *
 * 背景(docs/plans/20260420012229_agent-loop重构评审.md P0-02):
 * 重构前,截断常量和截断函数散落在 agent-loop.ts 与 parallel-executor.ts 两处,
 * 数值一致但定义重复,且 parallel-executor 内部用 inline slice 而非函数调用,
 * 工具专属 TRUNCATION_HINTS 只在串行路径生效。本模块作为唯一真源。
 *
 * 三层截断策略:
 * - Summary(200):UI 卡片/tool_done.resultSummary 一行展示
 * - Full(100K):tool_done.resultFull + SessionLogger JSONL + Web 回放
 * - LLM(40K):兜底截断,防 bash/task_output 极端输出撑爆 history,附工具专属引导
 */

// ═══════════════════════════════════════════════
// 常量 — 所有截断阈值的唯一定义源
// ═══════════════════════════════════════════════

/** resultSummary 最大长度(CLI/UI 单行展示) */
export const SUMMARY_MAX_CHARS = 200

/** resultFull 最大长度(Web 回放 + JSONL 持久化) */
export const FULL_MAX_CHARS = 100_000

/** 回传 LLM history 的工具结果最大字符数(兜底层) */
export const LLM_MAX_CHARS = 40_000

/** 小长度阈值:低于此值用简短省略号,高于此值附带原长度信息 */
const LONG_TRUNCATION_THRESHOLD = 10_000

/** 工具专属的截断后引导文案,LLM 看到后可自行改用更精确的过滤手段 */
const TRUNCATION_HINTS: Record<string, string> = {
    bash: '请用 grep/head/tail 过滤输出,或拆分为更小的命令',
    task_output: '输出过长,请用 bash 配合 grep/tail 过滤关键信息',
    grep: '请缩小 pattern 范围或指定更精确的搜索路径',
    read_file: '请指定行号范围读取特定区域',
}

// ═══════════════════════════════════════════════
// 通用 helper
// ═══════════════════════════════════════════════

/**
 * 通用字符串截断。超过阈值时,长文本附带 "(truncated, total N chars)" 标记,
 * 短文本只加 "..."。供 host payload / 诊断日志等非结果场景使用。
 */
export function truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text
    return maxLength >= LONG_TRUNCATION_THRESHOLD
        ? text.slice(0, maxLength) + `\n... (truncated, total ${text.length} chars)`
        : text.slice(0, maxLength) + '...'
}

// ═══════════════════════════════════════════════
// 语义化 API — 三种截断场景
// ═══════════════════════════════════════════════

/** 摘要级:给 UI 卡片/resultSummary 用,单行展示 */
export function truncateForSummary(text: string): string {
    return truncate(text, SUMMARY_MAX_CHARS)
}

/** 完整级:给 resultFull/SessionLogger/Web 回放用,保留较多上下文 */
export function truncateForFull(text: string): string {
    return truncate(text, FULL_MAX_CHARS)
}

/**
 * LLM 级:回传 history 前做兜底截断,附工具专属引导文案。
 * 大部分工具内部已截断(read_file 20K / grep 50 条),本函数防 bash/task_output 极端场景。
 */
export function truncateForLLM(output: string, toolName: string): string {
    if (output.length <= LLM_MAX_CHARS) return output
    const hint = TRUNCATION_HINTS[toolName] ?? '结果过长已截断,请尝试缩小查询范围'
    return output.slice(0, LLM_MAX_CHARS) +
        `\n\n[结果已截断:共 ${output.length} 字符,仅保留前 ${LLM_MAX_CHARS} 字符。${hint}]`
}
