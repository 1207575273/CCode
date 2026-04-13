// src/pages/LogsPage.tsx

export function LogsPage() {
  return (
    <div className="p-6 max-w-4xl">
      <h2 className="text-xl font-bold mb-4">日志浏览</h2>
      <div className="bg-elevated rounded-lg p-6">
        <p className="text-txt-secondary mb-4">日志浏览功能开发中。当前可直接查看 JSONL 文件：</p>
        <div className="bg-surface rounded p-3 font-mono text-sm text-txt-primary">
          <p>会话日志: ~/.ccode/sessions/</p>
          <p className="mt-1">数据库: ~/.ccode/data/ccode.db</p>
        </div>
        <p className="text-txt-secondary text-xs mt-4">
          每个会话生成一个 JSONL 文件，包含完整的事件链（LLM 调用、工具执行、token 用量等）。
        </p>
      </div>
    </div>
  )
}
