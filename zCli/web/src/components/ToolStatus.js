import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** 从 args 中提取关键参数作为摘要（模仿 CLI 的 ToolStatusLine） */
function formatArgsSummary(args) {
    if (args['file_path'])
        return `(${args['file_path']})`;
    if (args['path'])
        return `(${args['path']})`;
    if (args['pattern'])
        return `(${args['pattern']})`;
    if (args['command']) {
        const cmd = String(args['command']);
        return `(${cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd})`;
    }
    return '';
}
export function ToolStatus({ events }) {
    if (events.length === 0)
        return null;
    return (_jsx("div", { className: "px-4 py-2 space-y-2", children: events.map(e => (_jsxs("div", { className: "text-sm", children: [_jsxs("div", { className: "flex items-center gap-2 text-gray-400", children: [_jsx("span", { className: e.status === 'running'
                                ? 'animate-pulse text-yellow-400'
                                : e.success ? 'text-green-400' : 'text-red-400', children: e.status === 'running' ? '⟳' : e.success ? '✓' : '✗' }), _jsxs("span", { className: "font-mono", children: [e.toolName, formatArgsSummary(e.args)] }), e.durationMs != null && (_jsxs("span", { className: "text-gray-500", children: [e.durationMs, "ms"] }))] }), e.resultSummary && (_jsx("div", { className: "ml-6 mt-0.5 text-gray-500 border-l-2 border-gray-700 pl-2", children: _jsx("pre", { className: "text-xs whitespace-pre-wrap font-mono", children: e.resultSummary.length > 300
                            ? e.resultSummary.slice(0, 297) + '...'
                            : e.resultSummary }) }))] }, e.toolCallId))) }));
}
