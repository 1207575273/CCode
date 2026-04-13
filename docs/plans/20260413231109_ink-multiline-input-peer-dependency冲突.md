# ink-multiline-input Peer Dependency 冲突分析

> **状态：✅ 已解决（2026-04-13）** — 通过方案三（升级 ink 6 + react 19）根治，详见 [升级分析文档](20260413231722_ink6-react19升级可行性分析.md)

## 问题现象

执行 `npm i -g ccode-cli` 时出现 peer dependency 冲突警告：

```
npm warn ERESOLVE overriding peer dependency
npm warn peer ink@">=6" from ink-multiline-input@0.1.0
npm warn peer react@">=19" from ink-multiline-input@0.1.0
```

npm 自动降级解决（overriding），安装可以完成，但存在运行时兼容风险。

## 核心原因

`ink-multiline-input@0.1.0` 声明的 peer dependency 与项目当前依赖版本不兼容：

| 依赖 | ccode-cli 当前版本 | ink-multiline-input 要求 | 冲突 |
|------|-------------------|------------------------|------|
| `ink` | `^5.2.1` | `>=6` | ❌ 差一个大版本 |
| `react` | `^18.3.1` | `>=19` | ❌ 差一个大版本 |

根本矛盾：`ink-multiline-input` 是为 ink 6 生态（ink 6 + react 19）开发的组件，而 cCli 当前停留在 ink 5 + react 18。

## 当前依赖关系

```
ccode-cli@0.10.0
├── ink@^5.2.1
├── react@^18.3.1
├── ink-spinner (依赖 ink 5 + react 18) ✅
├── ink-text-input (依赖 ink 5 + react 18) ✅
└── ink-multiline-input@^0.1.0
    ├── peer ink@">=6"   ← 冲突
    └── peer react@">=19" ← 冲突
```

## 影响评估

- **安装阶段**：npm 会 override 解析，安装能完成，但有警告
- **运行时**：如果 `ink-multiline-input` 未使用 ink 6 / react 19 专属 API，则实际可正常运行；否则会出现运行时错误
- **发布阶段**：用户全局安装时会看到大量 warn，影响信任度

## 解决方案

### 方案一：package.json overrides 强制解析（短期，低成本）

在 `package.json` 中添加 overrides，让 `ink-multiline-input` 使用项目自身的 ink/react：

```json
{
  "overrides": {
    "ink-multiline-input": {
      "ink": "$ink",
      "react": "$react"
    }
  }
}
```

**前提**：需验证 `ink-multiline-input` 实际未使用 ink 6 / react 19 专属 API。

**验证方法**：
```bash
# 查看 ink-multiline-input 源码中的 ink/react import
cd node_modules/ink-multiline-input
grep -r "from 'ink'" src/ --include="*.js" --include="*.ts" --include="*.tsx"
grep -r "from 'react'" src/ --include="*.js" --include="*.ts" --include="*.tsx"
```

### 方案二：替换 ink-multiline-input（中期，中等成本）

如果该包功能简单，可自行实现多行输入组件，消除外部依赖冲突。

cCli 项目中已有 `ControlledMultilineInput` 自管组件，评估是否可以完全替代 `ink-multiline-input`。

### 方案三：升级到 ink 6 + react 19（长期，高成本）

整体升级技术栈，根治兼容性问题。

**需评估的 Breaking Changes**：
- ink 5 → 6：组件 API、渲染行为、生命周期变化
- react 18 → 19：并发特性变化、useEffect 行为调整
- 其他依赖（ink-spinner、ink-text-input）是否有对应 ink 6 版本

**迁移步骤概要**：
1. 升级 react → 19，react-reconciler 对应版本
2. 升级 ink → 6，适配 API 变化
3. 升级 ink-spinner、ink-text-input 到 ink 6 兼容版本
4. 全量回归测试 UI 组件

## 建议优先级

1. **立即**：验证 `ink-multiline-input` 是否实际兼容 ink 5（方案一前置）
2. **短期**：若兼容则加 overrides 消除警告；若不兼容则走方案二替换
3. **长期**：规划 ink 6 + react 19 升级，一次性解决生态对齐问题
