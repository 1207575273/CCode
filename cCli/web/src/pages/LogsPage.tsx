// src/pages/LogsPage.tsx

export function LogsPage() {
  return (
    <div className="p-6 max-w-4xl">
      <h2 className="text-xl font-bold mb-4">日志浏览</h2>
      <div className="bg-gray-800 rounded-lg p-6">
        <p className="text-gray-400 mb-4">日志浏览功能开发中。当前可直接查看 JSONL 文件：</p>
        <div className="bg-gray-900 rounded p-3 font-mono text-sm text-gray-300">
          <p>会话日志: ~/.zcli/sessions/</p>
          <p className="mt-1">数据库: ~/.zcli/data/zcli.db</p>
        </div>
        <p className="text-gray-500 text-xs mt-4">
          每个会话生成一个 JSONL 文件，包含完整的事件链（LLM 调用、工具执行、token 用量等）。
        </p>
      </div>
    </div>
  )
}
