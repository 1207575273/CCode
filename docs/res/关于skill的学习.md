# Claude Code Skill 完全指南

> 基于 Superpowers 插件 v5.0.0 整理

---

## 一、Skill 是什么？

Skill 是 Claude Code 的**可复用知识模块**——一份结构化的 Markdown 文档，让 Claude 实例能快速发现、理解并正确应用某个技术/模式/工作流。

简单理解：**Skill = YAML 元数据 + 结构化 Markdown 正文**。

---

## 二、Skill 的目录结构

```
skills/
  skill-name/
    SKILL.md              # 主文件（必须）
    supporting-file.*     # 辅助文件（可选，仅在需要时）
```

### 存放位置

| 作用域 | 路径 |
|--------|------|
| 个人 Skill | `~/.claude/skills/` |
| 项目 Skill | 项目根目录 `skills/` |
| 插件 Skill | `~/.claude/plugins/cache/...` （通过插件系统管理） |

---

## 三、SKILL.md 文件结构

### 3.1 Frontmatter（YAML 元数据，必须）

```yaml
---
name: my-skill-name
description: Use when [具体的触发条件和场景]
---
```

- 只支持 `name` 和 `description` 两个字段
- 总计不超过 **1024 字符**
- **关键规则**：`description` 只写"何时用"，不写"怎么用"——否则 Claude 会走捷径跳过正文

### 3.2 正文部分

| 章节 | 说明 |
|------|------|
| Overview | 核心原理，1-2 句话说清楚这是什么 |
| When to Use | 触发场景、症状列表，以及何时不用 |
| Core Pattern | 核心模式/技术，前后对比代码 |
| Quick Reference | 速查表格或要点，方便扫读 |
| Implementation | 实现细节，简单的内联，复杂的引用外部文件 |
| Common Mistakes | 常见错误 + 修复方式 |
| Real-World Impact | （可选）实际效果案例 |

---

## 四、Skill 的三种类型

| 类型 | 说明 | 示例 |
|------|------|------|
| **Technique** | 有明确步骤可遵循的具体方法 | TDD 红绿重构流程 |
| **Pattern** | 指导如何思考问题的思维模型 | 系统化调试方法论 |
| **Reference** | 查阅型资料 | API 文档、语法指南 |

---

## 五、创建 Skill 的关键规则

1. **命名**：用连字符、动词优先。如 `condition-based-waiting`，不用 `async-helpers`
2. **描述**：只写触发条件（"Use when..."），不写工作流摘要
3. **示例**：一个优秀示例胜过多个平庸示例，不必写多语言版本
4. **TDD 创建法**：先写失败测试（基线行为）→ 写 Skill → 验证通过 → 堵漏洞

---

## 六、Superpowers 插件 — 14 个内置 Skill 详解

Superpowers 是一个完整的软件开发工作流插件，包含 14 个核心 Skill。

### 6.1 主流程 Skill（按工作流顺序）

#### 1. brainstorming — 头脑风暴 / 设计细化

- **触发时机**：任何创造性工作之前（新功能、组件、行为变更）
- **核心流程**：
  1. 探索上下文 → 提出澄清问题
  2. 提供 2-3 个方案选项
  3. 分段呈现设计方案 → 获得用户批准
  4. 输出设计文档 → 调用 writing-plans
- **铁律**：**在设计获批之前，绝不写代码、不搭脚手架、不做任何实现动作**

#### 2. using-git-worktrees — Git Worktree 隔离工作区

- **触发时机**：需要隔离当前工作区的特性开发，或执行实施计划前
- **核心流程**：
  1. 检查已有目录 → 检查 CLAUDE.md 配置 → 询问用户
  2. 验证目录在 .gitignore 中 → 运行项目初始化 → 验证测试基线
- **目录优先级**：`.worktrees/` → `worktrees/` → `~/.config/superpowers/worktrees/` → 询问用户

#### 3. writing-plans — 编写实施计划

- **触发时机**：有需求/规格说明的多步骤任务，编码之前
- **核心原则**：假设读者对代码库零了解，每个任务需文档化所有必要信息
- **粒度要求**：每个步骤 2-5 分钟（分别写测试、跑测试、实现、提交）
- **必需头部**：目标、架构、技术栈、复选框语法
- **保存位置**：`docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`

#### 4a. subagent-driven-development — 子代理驱动开发（有子代理时）

- **触发时机**：在当前会话中执行有独立任务的实施计划
- **核心原则**：每任务一个全新子代理 + 两阶段审查（规格合规 → 代码质量）
- **流程**：实现子代理 → 规格合规审查 → 代码质量审查 → 修复差距 → 重复直到通过
- **实现者状态**：`DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED`
- **模型选择**：机械任务用便宜/快速模型，架构决策用最强模型

#### 4b. executing-plans — 执行实施计划（无子代理时）

- **触发时机**：在另一个会话中加载并执行已编写的实施计划
- **流程**：读取计划 → 批判性审查 → 创建 Todo → 按序执行 → 调用 finishing-a-development-branch
- **何时停止**：遇到阻碍、计划有缺口、指令不清晰、验证反复失败

#### 5. finishing-a-development-branch — 完成开发分支

- **触发时机**：实现完成、所有测试通过、需要决定集成方式
- **四个选项**：
  1. 本地合并到主分支
  2. 推送并创建 PR
  3. 保持当前状态（不做操作）
  4. 丢弃（需要打字确认）
- **Worktree 清理**：仅选项 1 和 4 清理；选项 2 和 3 保留

---

### 6.2 支撑性 Skill（在主流程中随时调用）

#### 6. test-driven-development — 测试驱动开发

- **触发时机**：实现任何功能、修复、重构或行为变更
- **铁律**：**没有失败的测试，就不写生产代码**
- **循环**：写失败测试 → 观察失败 → 写最小代码通过 → 观察通过 → 重构
- **红旗信号**：先写代码再补测试、测试直接通过、给自己找"就这一次"的借口

#### 7. systematic-debugging — 系统化调试

- **触发时机**：任何 Bug、测试失败、异常行为、性能问题
- **铁律**：**不找到根因，就不尝试修复。修症状就是失败。**
- **四阶段**：根因调查 → 模式分析 → 假设验证 → 实施修复
- **架构升级**：如果 3 次修复都失败，质疑架构本身，不要尝试第 4 次修复

#### 8. verification-before-completion — 完成前验证

- **触发时机**：声称工作完成、Bug 已修复、测试已通过之前
- **铁律**：**没有新鲜的验证证据，就不声称完成**
- **门控函数**：确定命令 → 运行 → 读输出 → 验证声明 → 然后才做声明
- **红旗信号**：使用"应该"、"大概"、"看起来"等模糊用语；验证前就表达满意

#### 9. requesting-code-review — 请求代码审查

- **触发时机**：完成任务后、实现重大功能后、合并前
- **流程**：获取 git SHA → 派遣 code-reviewer 子代理 → 处理反馈
- **问题严重度**：Critical 立即修 → Important 先处理再继续 → Minor 后续处理
- **推回策略**：如果审查者有误，用技术推理推回

#### 10. receiving-code-review — 接收代码审查

- **触发时机**：收到代码审查反馈、实施建议之前
- **响应模式**：阅读 → 理解 → 验证 → 评估 → 回应 → 实施
- **禁止行为**："你说得太对了！"——不做表演性认同，不盲目实施
- **YAGNI 检查**：如果审查者建议了未使用的功能，删除它
- **何时推回**：建议破坏功能、审查者缺少上下文、违反 YAGNI、技术上不正确

#### 11. dispatching-parallel-agents — 派遣并行代理

- **触发时机**：面对 2+ 个独立的、无共享状态的任务
- **核心原则**：每个独立问题域派遣一个代理，让它们并发工作
- **适用场景**：3+ 个测试文件因不同根因失败、多个子系统独立故障
- **不适用**：故障相关联、需要全系统上下文、代理之间会互相干扰
- **效率提升**：3 个问题并行解决，比串行快 50-67%

---

### 6.3 元 Skill

#### 12. using-superpowers — Skill 系统入口

- **触发时机**：每次对话开始（子代理执行特定任务时除外）
- **铁律**：**哪怕只有 1% 的可能性某个 Skill 适用，你也必须调用它**
- **优先级**：用户指令 > Superpowers Skill > 默认系统提示
- **红旗信号**："这只是个简单问题"、"让我先收集信息"、"这个 Skill 太重了"

#### 13. writing-skills — 编写 Skill

- **触发时机**：创建新 Skill、编辑已有 Skill、验证 Skill 是否有效
- **核心原则**：编写 Skill 就是 TDD 应用于流程文档
- **TDD 映射**：测试用例 = 压力场景，生产代码 = SKILL.md
- **RED 阶段**：不带 Skill 运行场景，记录基线行为和合理化借口
- **GREEN 阶段**：编写最小 Skill 解决那些具体违规
- **REFACTOR 阶段**：堵漏洞、建合理化借口表、红旗信号列表

#### 14. simplify — 代码简化审查

- **触发时机**：代码变更完成后，审查复用性、质量和效率
- **核心原则**：审查改动代码，发现问题直接修复

---

## 七、完整工作流示意

### 标准开发流程

```
1. brainstorming          → 设计方案获批
       ↓
2. using-git-worktrees    → 隔离工作区就绪
       ↓
3. writing-plans          → 实施计划文档就绪
       ↓
4. subagent-driven-dev    → 逐任务实现 + 审查
   或 executing-plans        （每个任务内部走 TDD 循环）
       ↓
5. finishing-a-branch     → 合并 / PR / 保留 / 丢弃
```

### 支撑 Skill 调用时机

```
实现任意功能时     → test-driven-development
遇到 Bug 时       → systematic-debugging
声称完成前         → verification-before-completion
任务完成后         → requesting-code-review
收到审查反馈时     → receiving-code-review
多个独立故障时     → dispatching-parallel-agents
对话开始时         → using-superpowers（检查适用 Skill）
```

---

## 八、Skill 系统的核心哲学

### 三条铁律

| Skill | 铁律 |
|-------|------|
| TDD | 没有失败的测试，不写生产代码 |
| 调试 | 没有根因调查，不尝试修复 |
| 验证 | 没有验证证据，不声称完成 |

### 设计原则

1. **测试驱动**：先写测试，永远
2. **系统化优于即兴**：流程优于猜测
3. **降低复杂度**：简单是第一目标
4. **证据优于声明**：验证后再宣称成功
5. **设计先于实现**：规格先于代码
6. **计划先于执行**：清晰任务先于动手
7. **根因先于修复**：理解先于行动
8. **压力下保持纪律**：Skill 强制最佳实践

---

## 九、Skill 优先级规则

当多个 Skill 可能适用时：

1. **流程 Skill 优先**（brainstorming、systematic-debugging）→ 决定*如何*处理任务
2. **实现 Skill 其次**（frontend-design、writing-plans）→ 指导执行

例如：
- "让我们构建 X" → 先 brainstorming，再实现 Skill
- "修复这个 Bug" → 先 systematic-debugging，再领域 Skill

---

## 十、在 Claude Code 中使用 Skill

### 调用方式

在对话中使用斜杠命令或让 Claude 自动匹配：

```
/brainstorm          → 触发头脑风暴 Skill
/write-plan          → 触发编写计划 Skill
/execute-plan        → 触发执行计划 Skill
```

或者 Claude 根据 `using-superpowers` 的规则自动检测并调用适用的 Skill。

### 安装 Superpowers 插件

```bash
# 在 Claude Code 中
/install-plugin superpowers
```

---

## 十一、自定义 Skill 快速上手

### 最小示例

```
~/.claude/skills/my-skill/SKILL.md
```

```markdown
---
name: my-custom-skill
description: Use when building REST API endpoints with Express.js
---

## Overview

标准化 Express.js REST 端点的创建流程。

## When to Use

- 创建新的 API 端点
- 重构已有端点结构

## Core Pattern

路由定义 → 参数校验 → 业务逻辑 → 统一响应格式

## Quick Reference

| 步骤 | 做什么 |
|------|--------|
| 1 | 定义路由和 HTTP 方法 |
| 2 | 使用 zod/joi 校验入参 |
| 3 | 调用 Service 层处理逻辑 |
| 4 | 统一返回 { code, data, message } |

## Common Mistakes

- 在路由中直接写数据库查询（应放 Service 层）
- 遗漏错误处理中间件
- 未校验必需参数
```

### TDD 创建流程

1. **RED**：不带 Skill 让 Claude 处理同类任务，记录它做错的地方
2. **GREEN**：写最小 SKILL.md 解决那些具体问题
3. **REFACTOR**：补充红旗信号表、常见借口表、堵住逃逸路径

---

## 十二、subagent-driven vs executing-plans 对比

| 维度 | subagent-driven | executing-plans |
|------|-----------------|-----------------|
| 执行方式 | 当前会话，每任务新建子代理 | 另一个会话，批量执行 |
| 审查机制 | 自动两阶段审查（规格 + 质量） | 依赖人工检查点 |
| 上下文 | 每个子代理全新上下文，无污染 | 共享会话上下文 |
| 适用场景 | 子代理可用时优先 | 子代理不可用或需要人工干预时 |
| TDD 执行 | 由子代理内部自动执行 | 由执行者手动遵循 |

---

> **总结**：Skill 系统的核心思想是将经过验证的工程实践编码为可复用的结构化文档，让 AI 助手在每次交互中都能遵循最佳实践，而不是靠运气或即兴发挥。掌握 Skill 系统 = 掌握与 Claude Code 高效协作的钥匙。



关于skill的一个创建文档

https://skills.sh/anthropics/skills/skill-creator
