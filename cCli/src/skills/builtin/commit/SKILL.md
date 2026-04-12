---
name: commit
description: Use when the user asks to commit changes, create a git commit, or says "提交" or "commit"
allowed-tools: git, Bash
user-invocable: true
---

# Git Commit Skill

## 规范

遵循 Conventional Commits 格式：

```
<type>(<scope>): <subject>

[body]
```

### Type 类型

| type | 说明 |
|------|------|
| feat | 新功能 |
| fix | 修复 Bug |
| refactor | 重构（不改变外部行为） |
| docs | 文档变更 |
| chore | 构建/工具/依赖变更 |
| test | 测试相关 |
| style | 代码格式（不影响逻辑） |
| perf | 性能优化 |

### Scope（可选）

括号内标注影响的模块，如 `feat(ui):`、`fix(core):`。

### Subject

- 使用中文或英文均可，保持与项目已有提交风格一致
- 不超过 72 字符
- 不以句号结尾

## 流程

1. **查看变更**：调用 `git` 工具的 `status` 子命令查看工作区变更
2. **查看提交历史**：调用 `git` 工具的 `log` 子命令（count=10）了解项目的提交风格
3. **分析变更**：理解所有改动的目的和关联
4. **查看详细 diff**：如需了解具体改动，调用 `git` 工具的 `diff` 子命令
5. **草拟消息**：根据变更内容选择合适的 type 和 scope
6. **提交**：调用 `git` 工具的 `commit` 子命令（指定 files 和 message）
7. **确认状态**：调用 `git` 工具的 `status` 子命令确认提交成功

## 注意事项

- 不要提交包含密钥的文件（.env、credentials.json 等）— git 工具会自动拦截
- 不要使用 `--amend` 除非用户明确要求（如需 amend，使用 bash 工具）
- 不要自动 push，除非用户明确要求（push 使用 bash 工具）
- commit 的 files 参数必须逐个指定文件，不要使用 `git add -A` 或 `git add .`
