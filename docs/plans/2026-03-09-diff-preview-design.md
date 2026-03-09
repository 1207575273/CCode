# Diff 预览设计

> 状态：已确认 | 日期：2026-03-09

## 核心目标

在 PermissionDialog 审批文件操作前，展示 unified diff，让用户看到具体变更再决定是否允许。

## 技术选型

**diff 库：`diff`（jsdiff）**
- npm 生态最成熟的 diff 库，零依赖
- `structuredPatch()` 产出 hunks（带行号、上下文行、增删行）
- `diffLines()` 用于新建文件的全量 diff

## 涉及工具

| 工具 | 场景 | diff 来源 |
|------|------|-----------|
| `edit_file` | 替换已有内容 | 读取原文 vs 替换后文本，`structuredPatch()` |
| `write_file` | 覆盖已有文件 | 读取原文 vs 新内容，`structuredPatch()` |
| `write_file` | 新建文件 | oldStr = ''，展示前 20 行 + 截断提示 |

## 显示样式

Unified（单列）：删除行红色 `-`，新增行绿色 `+`，上下文行白色。

## 组件架构

```
PermissionDialog (已有)
├── 标题栏：Edit file / Write file + 文件路径
├── DiffView (新建组件)
│   ├── Hunk[] — 每个 hunk 带行号范围标题（@@...@@）
│   │   ├── 上下文行：白色，带行号
│   │   ├── 删除行：红色 -，带行号
│   │   └── 新增行：绿色 +，带行号
│   └── 新建文件截断提示（如有）
├── 变更统计：+N / -M
└── 操作选项：1.Yes / 2.Yes all / 3.No
```

## 数据流

```
permission_request 事件
  → PermissionDialog 接收 toolName + args
  → 对 edit_file / write_file：
      1. 同步读取原文件（不存在则 oldStr = ''）
      2. 计算新内容（edit: 做替换；write: 直接取 content 参数）
      3. jsdiff.structuredPatch(filePath, filePath, old, new)
      4. 传入 DiffView 渲染
  → 其他工具：不显示 diff，保持原有行为
```

## DiffView Props

```typescript
interface DiffViewProps {
  filePath: string
  hunks: Hunk[]          // jsdiff structuredPatch 的输出
  additions: number       // 新增行数
  deletions: number       // 删除行数
  isNewFile: boolean
  truncatedLines?: number // 被截断的行数（新建文件 > 20 行时）
}
```

## 新建文件截断规则

- 行数 <= 20：全量显示，所有行绿色 `+`
- 行数 > 20：显示前 20 行 + `... 还有 N 行未显示`

## 边界情况

| 场景 | 处理 |
|------|------|
| 原文件不存在（新建） | oldStr = ''，标记 isNewFile |
| 原文件读取失败（权限等） | 降级为纯文本显示参数，不阻塞审批 |
| diff 过长（大文件编辑） | 最多显示 5 个 hunks，超出截断提示 |
| 二进制文件 | 检测到非文本显示 `Binary file, N bytes` |

## 渲染示例

### edit_file

```
── Edit file ──────────────────────
 src/utils/parser.ts
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 @@ -12,4 +12,4 @@
  12  const x = 1
  13- const y = 2
  13+ const y = 3
  14  const z = 4

 +1 -1
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 ❯ 1. Yes
   2. Yes, allow all edits (meta+m)
   3. No
```

### write_file 新建

```
── Create file ────────────────────
 src/config/defaults.ts  (new)
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
   1+ export const DEFAULTS = {
   2+   timeout: 5000,
   3+   retries: 3,
   4+ }

 +4
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 ❯ 1. Yes
   2. Yes, allow all writes (meta+m)
   3. No
```
