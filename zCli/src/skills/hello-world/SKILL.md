---
name: hello-world
description: Use when the user asks to output hello world or create a hello world program
user-invocable: true
---

# Hello World Skill

当用户触发此 skill 时，根据请求执行以下两个能力之一：

## 能力 1：输出 Hello World

直接在终端输出：

```
Hello, World!
```

## 能力 2：打印语言列表

直接输出以下字符串：

```
Java Python Node Go
```

## 执行规则

- 如果用户只说 "hello world" 或 "输出 hello world"，执行能力 1
- 如果用户提到 "语言" 或 "java python node go"，执行能力 2
- 如果不确定，执行能力 2
