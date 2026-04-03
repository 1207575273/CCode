# Bridge Server Vite 反代端口冲突与启动时序修复

> 日期: 2026-04-03
> 状态: 已完成
> 关联: Bridge Server、Web Dashboard、dev 模式
> 提交: `8f99769 fix: dev 模式 Vite 反代端口冲突和启动时序问题`

---

## 一、问题现象

dev 模式（`pnpm run dev:web`）启动 cCli 后，访问 `http://localhost:9800/session/:id` 页面显示：

```
Vite dev server 未就绪，请稍等...
```

HTTP 状态码 502。尤其在用户同时运行自己的前端项目时必现。

---

## 二、背景架构

Bridge Server 的 dev 模式采用"反向代理"架构：

```
浏览器 → http://localhost:9800/session/:id
           │
           ├─ /ws、/api → Hono 直接处理（WebSocket、REST API）
           │
           └─ 其余路径 → fetch 反代 → http://localhost:5173/... （Vite dev server）
                                        │
                                        └─ 失败时 catch → 502 "未就绪"
```

- `ccli.ts` 用 `execa('npx', ['vite'])` 启动独立的 Vite dev server 进程
- `server.ts` 将非 API 请求 `fetch` 转发到 Vite 的 5173 端口
- `fetch` 失败时返回 502 错误文本

---

## 三、根因分析

两个独立问题叠加导致：

### 3.1 端口冲突

Vite 端口**硬编码为 5173**（`const VITE_DEV_PORT = 5173`）。用户自己的前端项目（Vue/React 脚手架）默认也用 5173，导致：

- cCli 的 Vite 进程启动失败（端口被占），反代永远 502
- 或者 Vite 静默绑定到其他端口，但反代仍指向 5173，连接到用户的 Vite 实例（错误内容）

### 3.2 启动时序

`execa('npx', ['vite'])` 是**即发即忘**——启动进程后不等就绪就继续执行。Bridge Server 立刻监听 9800 端口，此时 Vite 尚未完成初始化。用户首次访问时 `fetch('http://localhost:5173/...')` 因连接拒绝而抛错，被 `catch` 捕获返回 502。

即使没有端口冲突，**Vite 冷启动（通常 1-3 秒）期间的请求也会全部 502**。

---

## 四、探索过程

### 4.1 方案一：Vite middleware 模式（已放弃）

尝试将 Vite 内嵌到 Bridge Server 进程内（`createViteServer({ server: { middlewareMode: true } })`），消除独立端口和反代。

遇到的问题：

| 问题 | 说明 |
|------|------|
| 依赖解析 | Vite 是 web 子项目的依赖，主项目未安装。需要 `createRequire` 从 web 目录动态解析 |
| Windows ESM | `import()` 不接受裸绝对路径（`D:\...`），需要 `pathToFileURL()` 转换 |
| 路径计算 | `server.ts` 在 `src/server/bridge/`，到 web 目录需要 `../../../web`，初始写成 `../../web`（少一级）|
| Hono 集成 | 替换 `server.listeners('request')` 影响 `@hono/node-ws` 的 WebSocket upgrade |
| SPA fallback | Vite middleware 模式不自带 SPA fallback，`/session/:id` 等路由返回 404 |
| 双写冲突 | Vite connect 中间件直接操作 Node res，Hono 也尝试写 response，需要复杂的协调逻辑 |

**结论**：改动面大、与现有 Hono + node-ws 生态集成成本高，不适合当前架构。

### 4.2 方案二：原有架构最小修复（采纳）

保持反代架构不变，只解决端口冲突和启动时序两个具体问题。

---

## 五、最终方案

### 5.1 改动概览

```
改动前：
  ccli.ts → execa('npx', 'vite')                     // 固定 5173，不等就绪
  server.ts → fetch(`http://localhost:5173/...`)      // 硬编码端口

改动后：
  ccli.ts → net.createServer().listen(0) 找空闲端口    // 动态端口，避免冲突
          → execa('npx', 'vite', '--port', port)      // 用空闲端口启动
          → 轮询 net.createConnection 等端口就绪        // 等 Vite ready，最多 15s
          → startBridgeServer({ dev: true, vitePort })
  server.ts → fetch(`http://localhost:${vitePort}/...`) // 用传入端口
```

### 5.2 具体改动

**`src/server/bridge/server.ts`**：

- 删除 `const VITE_DEV_PORT = 5173` 硬编码常量
- `BridgeServerOptions` 新增 `vitePort?: number` 字段
- 反代 URL 从 `http://localhost:${VITE_DEV_PORT}` 改为 `http://localhost:${options.vitePort}`

**`bin/ccli.ts`**：

1. **动态端口分配**：`net.createServer().listen(0)` 让 OS 分配空闲端口，取到后立即关闭
2. **指定端口启动 Vite**：`execa('npx', ['vite', '--port', String(vitePort)])`
3. **等待 Vite 就绪**：轮询 `net.createConnection({ port })` 检测端口连通性（100ms 间隔，最多 150 次 = 15 秒）
4. **传端口给 Bridge Server**：`startBridgeServer({ dev: true, vitePort })`

### 5.3 时序对比

```
改动前：
  execa(vite)  ──────────────────────→ Vite 就绪（~2s）
  startBridgeServer() ← 立刻执行
  用户访问 9800 ← 502 "未就绪"

改动后：
  findFreePort() → 得到 port
  execa(vite, --port, port) ─────────→ Vite 就绪
  waitForPort(port) ─── 轮询 ─── 连通 ✓
  startBridgeServer({ vitePort: port }) ← Vite 已就绪
  用户访问 9800 ← 正常反代 ✓
```

---

## 六、影响范围

| 范围 | 影响 |
|------|------|
| dev 模式 | ✅ 修复端口冲突和启动时序 |
| 生产模式 | ❌ 无影响（不走 Vite 反代） |
| Web Dashboard | ❌ 无影响（纯前端，不涉及此处改动） |
| WebSocket | ❌ 无影响（/ws 路径不经过反代） |

---

## 七、教训

1. **反代外部进程的两个基本问题**：端口分配（动态 > 硬编码）和启动时序（等就绪 > 即发即忘）。两个都不解决，bug 必现。
2. **Vite middleware 模式的集成成本**：理论上更优（单端口、无反代），但与 Hono node-server + WebSocket 的集成需要处理 request listener 替换、双写响应、SPA fallback 等问题，改动面远超预期。在已有架构上做最小修复是更务实的选择。
3. **Windows ESM 特殊限制**：`import()` 不接受裸绝对路径（如 `D:\...`），必须用 `pathToFileURL()` 转成 `file:///D:/...`。这在 Linux/macOS 上不是问题（`/` 开头的路径被识别为文件路径），但 Windows 上 `D:` 会被当成 URL scheme 报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
