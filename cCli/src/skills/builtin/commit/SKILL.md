---
name: commit
description: Use when the user asks to commit changes, create a git commit, or says "提交" or "commit"
allowed-tools: Bash
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

1. **查看变更**：运行 `git status` 和 `git diff`（含 staged 和 unstaged）
2. **查看提交历史**：运行 `git log --oneline -10` 了解项目的提交风格
3. **分析变更**：理解所有改动的目的和关联
4. **草拟消息**：根据变更内容选择合适的 type 和 scope
5. **暂存文件**：按文件名逐个 `git add`，不使用 `git add -A` 或 `git add .`
6. **提交**：使用 HEREDOC 格式传递 commit message

```bash
git commit -m "$(cat <<'EOF'
type(scope): subject

EOF
)"
```

## 注意事项

- 不要提交包含密钥的文件（.env、credentials.json 等）
- 不要使用 `--no-verify` 跳过 hooks
- 不要使用 `--amend` 除非用户明确要求
- 提交后运行 `git status` 确认状态
- 不要自动 push，除非用户明确要求
