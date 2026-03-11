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

## 能力 2：多语言 Hello World

用以下 4 种语言分别输出 Hello World 程序：

### Java

```java
public class HelloWorld {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}
```

### Python

```python
print("Hello, World!")
```

### Node.js

```javascript
console.log("Hello, World!");
```

### Go

```go
package main

import "fmt"

func main() {
    fmt.Println("Hello, World!")
}
```

## 执行规则

- 如果用户只说 "hello world" 或 "输出 hello world"，执行能力 1
- 如果用户提到 "多语言" 或 "java python node go"，执行能力 2
- 如果不确定，执行能力 2（展示所有语言版本）
