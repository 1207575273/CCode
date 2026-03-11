# 各语言常见代码审查问题

审查特定语言代码时加载此参考。聚焦容易忽略的语言特有陷阱。

## TypeScript / JavaScript

### 正确性
- `==` 而非 `===`（类型强制转换 Bug）
- 异步调用缺少 `await`（Promise 被静默丢弃）
- 数组索引作为 React `key`（导致重渲染 Bug）
- 对数组使用 `for...in`（会遍历原型属性）
- 在 `.length`、`.map()` 等调用前缺少可选链 `?.`

### 安全性
- `innerHTML` / `dangerouslySetInnerHTML` 未过滤 → XSS
- 模板字符串拼接 SQL 查询 → SQL 注入
- `eval()`、`new Function()`、`child_process.exec()` 接收用户输入
- 密钥写在客户端代码或提交了 `.env` 文件

### 性能
- 在渲染循环内创建函数/对象（React）
- 昂贵计算缺少 `useMemo` / `useCallback`
- `useEffect` 依赖数组缺失或过时
- 对大数组不加限制地使用 `Promise.all`（应分批处理）

---

## Java

### 正确性
- 对 String/Integer 对象使用 `==`（应使用 `.equals()`）
- `Optional.get()` 未先调用 `.isPresent()` 检查
- 缺少 `@Override` 注解（签名不匹配时静默失败）
- 迭代集合的同时修改导致 `ConcurrentModificationException`

### 安全性
- SQL 字符串拼接 → 应使用 PreparedStatement
- `@RequestParam` 未做校验 → 注入风险
- 反序列化不可信数据（`ObjectInputStream`）
- 过度宽松的 `@CrossOrigin("*")`

### 性能
- 循环中拼接字符串（应使用 StringBuilder）
- JPA/Hibernate 的 N+1 查询（使用 `@EntityGraph` 或 join fetch）
- 紧密循环中自动装箱（`Integer` vs `int`）
- 读操作缺少 `@Transactional(readOnly = true)`

---

## Python

### 正确性
- 可变默认参数：`def f(items=[])` → 跨调用共享状态
- `except Exception` 吞掉所有异常（应使用具体异常类型）
- 值比较用 `is` 而非 `==`（特别是非单例对象）
- 可导入脚本缺少 `if __name__ == '__main__'` 守卫

### 安全性
- `pickle.load()` 加载不可信数据 → 任意代码执行
- `os.system()` / `subprocess.shell=True` 接收用户输入 → 命令注入
- `yaml.load()` 未指定 `Loader=SafeLoader` → 任意代码执行
- 硬编码密钥，未使用 `.env` 管理配置

### 性能
- 循环中 append 列表，本可用列表推导式
- 模块级全量导入重型库（应懒导入）
- 高频实例化的 dataclass 缺少 `__slots__`
- 异步上下文中使用同步 I/O（阻塞事件循环）
