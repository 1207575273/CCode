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
        <span className="text-warning text-lg">⚠</span>
        <span className="font-medium text-yellow-200">权限确认</span>
      </div>
      <p className="text-sm text-txt-primary mb-1">
        工具 <span className="font-mono text-yellow-300">{toolName}</span> 请求执行：
      </p>
      <pre className="text-xs bg-surface rounded p-2 mb-3 overflow-x-auto text-txt-secondary">
        {JSON.stringify(args, null, 2)}
      </pre>
      <div className="flex gap-2">
        <button onClick={onAllow} className="px-4 py-1.5 bg-success text-white rounded hover:bg-success text-sm">
          允许
        </button>
        <button onClick={onAlwaysAllow} className="px-4 py-1.5 bg-accent text-white rounded hover:bg-accent-hover text-sm">
          始终允许
        </button>
        <button onClick={onDeny} className="px-4 py-1.5 bg-error text-white rounded hover:bg-error text-sm">
          拒绝
        </button>
      </div>
    </div>
  )
}
