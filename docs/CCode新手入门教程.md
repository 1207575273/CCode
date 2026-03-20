# CCode 新手入门教程

> 零基础也能用的 AI 编程助手，跟着做就行。

---

## 第一步：安装 nvm（Node 版本管理器）

### nvm 是什么？

**nvm**（Node Version Manager）是一个管理 Node.js 版本的小工具。

为什么需要它？
- Node.js 经常更新版本，不同项目可能需要不同版本
- 有了 nvm，你可以**一条命令切换版本**，不用反复卸载重装
- 避免系统权限问题（nvm 安装的 Node 在用户目录下，不需要管理员权限）

### Windows 安装 nvm

1. 打开 https://github.com/coreybutler/nvm-windows/releases
2. 下载最新的 `nvm-setup.exe`
3. 双击安装，一路点"下一步"
4. 安装完成后，**关闭所有终端窗口**，重新打开 **命令提示符**（按 `Win + R`，输入 `cmd`，回车）
5. 验证安装：

```bash
nvm version
# 看到版本号说明成功，如：1.1.12
```

### Mac / Linux 安装 nvm

打开 **终端**（Mac 在启动台搜索"终端"），输入：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
```

安装完成后，**关闭终端重新打开**，验证：

```bash
nvm --version
# 看到版本号说明成功，如：0.40.0
```

---

## 第二步：用 nvm 安装 Node.js

**Node.js** 是一个让 JavaScript 在电脑上运行的工具。CCode 需要 Node.js 20 或以上版本。

```bash
# 安装 Node.js 20（LTS 长期支持版）
nvm install 20

# 设置为默认版本
nvm use 20

# 验证安装成功
node --version
# 看到 v20.x.x 就说明成功了

npm --version
# 看到 10.x.x 就说明 npm 也装好了
```

> **npm 是什么？** npm 是 Node.js 自带的包管理器，类似手机上的"应用商店"。安装 Node 后自动就有了。

### nvm 常用命令速查

| 命令 | 说明 |
|------|------|
| `nvm install 20` | 安装 Node.js 20 |
| `nvm use 20` | 切换到 Node.js 20 |
| `nvm list` | 查看已安装的所有版本 |
| `nvm current` | 查看当前使用的版本 |
| `nvm alias default 20` | 设置默认版本（新终端自动使用） |

### 不想用 nvm？直接安装 Node.js 也行

如果你觉得 nvm 太麻烦，也可以直接安装 Node.js：

1. 打开 https://nodejs.org/
2. 下载 **LTS 版本**（左边那个绿色按钮）
3. 双击安装包，一路点"下一步"
4. 验证：`node --version`

---

## 第三步：安装 CCode

打开终端（Windows 用 cmd 或 PowerShell，Mac 用终端），输入：

```bash
npm install -g ccode-cli
```

> **npm 是什么？** 它是 Node.js 自带的包管理器，类似手机上的"应用商店"。`npm install -g` 就是"全局安装一个工具"。

安装完成后，输入 `ccode` 验证：

```bash
ccode
```

看到欢迎界面就说明安装成功了。按 `Ctrl + C` 两次退出。

---

## 第四步：获取 API Key

CCode 需要连接 AI 模型才能工作。你需要一个 API Key（就像一把钥匙）。

### 推荐：智谱 GLM（国内可用，注册送额度）

1. 打开 https://open.bigmodel.cn/
2. 点击右上角"注册"，用手机号注册
3. 登录后，点击左侧菜单"API Keys"
4. 点击"创建 API Key"，复制生成的 Key

### 其他选择

| 模型 | 注册地址 | 特点 |
|------|----------|------|
| 智谱 GLM | https://open.bigmodel.cn/ | 国内可用，注册送额度 |
| DeepSeek | https://platform.deepseek.com/ | 国内可用，价格便宜 |
| OpenAI | https://platform.openai.com/ | GPT-4o，需要海外支付方式 |
| Anthropic | https://console.anthropic.com/ | Claude，需要海外支付方式 |

---

## 第五步：配置 API Key

### 方法一：手动创建配置文件（推荐）

1. 找到你的用户目录：
   - Windows：`C:\Users\你的用户名\`
   - Mac：`/Users/你的用户名/`

2. 在用户目录下创建一个文件夹叫 `.ccode`（注意前面有个点）

3. 在 `.ccode` 文件夹里创建一个文件叫 `config.json`，内容如下：

**如果你用智谱 GLM：**

```json
{
  "defaultProvider": "glm",
  "defaultModel": "glm-5",
  "providers": {
    "glm": {
      "apiKey": "把你的API Key粘贴到这里",
      "baseURL": "https://open.bigmodel.cn/api/coding/paas/v4",
      "models": ["glm-5", "glm-4.7"]
    }
  }
}
```

**如果你用 DeepSeek：**

```json
{
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-chat",
  "providers": {
    "deepseek": {
      "apiKey": "把你的API Key粘贴到这里",
      "baseURL": "https://api.deepseek.com/v1",
      "models": ["deepseek-chat", "deepseek-reasoner"]
    }
  }
}
```

### 方法二：启动 CCode 后自动创建

第一次运行 `ccode` 时会自动创建默认配置文件，你只需要编辑它填入 API Key 即可。

配置文件位置：
- Windows：`C:\Users\你的用户名\.ccode\config.json`
- Mac：`~/.ccode/config.json`

---

## 第六步：开始使用

```bash
ccode
```

启动后你会看到一个输入框，直接打字提问就行：

```
> 你好，帮我写一个 Python 的 Hello World 程序
```

CCode 会帮你写代码、创建文件、执行命令，你只需要用自然语言描述需求。

### 常用操作

| 你想做什么 | 怎么说 |
|-----------|--------|
| 写代码 | "帮我写一个 xxx 功能" |
| 看文件 | "帮我看看 package.json" |
| 改代码 | "把这个函数改成 async 的" |
| 找 bug | "这段代码为什么报错" |
| 执行命令 | "帮我跑一下 npm install" |
| 搜索文件 | "找一下项目里所有的 TODO 注释" |

### 常用指令

在输入框里输入 `/` 开头的指令：

| 指令 | 说明 |
|------|------|
| `/help` | 查看所有可用指令 |
| `/model` | 切换 AI 模型 |
| `/clear` | 清空当前对话 |
| `/compact` | 对话太长时压缩上下文 |
| `/usage` | 查看 Token 用量和费用 |

### 快捷键

| 按键 | 作用 |
|------|------|
| `Enter` | 发送消息 |
| `Escape` | 中断 AI 的回复 |
| `Ctrl + C` 两次 | 退出 CCode |

---

## 常见问题

### Q：安装时报错 "npm 不是内部或外部命令"

Node.js 没有正确安装。重新按第一步和第二步操作，安装完成后重启终端。

### Q：运行 ccode 后提示 API Key 为空

按第五步配置 API Key。确认 `config.json` 文件路径正确，Key 粘贴完整。

### Q：提示"网络连接失败"

如果用国外模型（OpenAI / Claude），可能需要网络代理。建议先用国内模型（GLM / DeepSeek）。

### Q：Token 用完了怎么办

去对应平台充值。GLM 和 DeepSeek 都很便宜，日常使用每月几块钱。

### Q：怎么更新到最新版

```bash
npm install -g ccode-cli@latest
```

---

## 进阶

当你熟悉基本用法后，可以探索：

- **指令文件**：在项目根目录创建 `CCODE.md`，写入你的编码规范，AI 会自动遵守
- **MCP 工具**：连接外部工具（数据库、网页搜索等），扩展 AI 能力
- **会话恢复**：`ccode --resume` 继续上次未完成的对话
- **Web 面板**：`ccode --web`，浏览器打开 `http://localhost:9800/` 查看可视化管理界面

详细文档见 [GitHub](https://github.com/1207575273/CCode)
