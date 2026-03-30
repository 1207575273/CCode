// src/components/PermissionCard.tsx

interface Props {
  toolName: string
  args: Record<string, unknown>
  onAllow: () => void
  onAlwaysAllow: () => void
  onDeny: () => void
}

export function PermissionCard({ toolName, args, onAllow, onAlwaysAllow, onDeny }: Props) {
  return (
    <div className="mx-4 my-2 p-4 bg-yellow-900/30 border border-yellow-600/50 rounded-lg">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-yellow-400 text-lg">⚠</span>
        <span className="font-medium text-yellow-200">权限确认</span>
      </div>
      <p className="text-sm text-gray-300 mb-1">
        工具 <span className="font-mono text-yellow-300">{toolName}</span> 请求执行：
      </p>
      <pre className="text-xs bg-gray-900 rounded p-2 mb-3 overflow-x-auto text-gray-400">
        {JSON.stringify(args, null, 2)}
      </pre>
      <div className="flex gap-2">
        <button onClick={onAllow} className="px-4 py-1.5 bg-green-600 text-white rounded hover:bg-green-500 text-sm">
          允许
        </button>
        <button onClick={onAlwaysAllow} className="px-4 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-500 text-sm">
          始终允许
        </button>
        <button onClick={onDeny} className="px-4 py-1.5 bg-red-600 text-white rounded hover:bg-red-500 text-sm">
          拒绝
        </button>
      </div>
    </div>
  )
}
