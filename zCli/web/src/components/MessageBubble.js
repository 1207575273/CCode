import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// src/components/MessageBubble.tsx
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
export function MessageBubble({ message }) {
    const isUser = message.role === 'user';
    const sourceTag = message.source === 'web' ? ' (web)' : message.source === 'cli' ? ' (cli)' : '';
    return (_jsx("div", { className: `flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`, children: _jsxs("div", { className: `max-w-[80%] rounded-lg px-4 py-3 ${isUser ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-100'}`, children: [sourceTag && (_jsx("span", { className: "text-xs opacity-50 mb-1 block", children: sourceTag })), isUser ? (_jsx("p", { className: "whitespace-pre-wrap", children: message.content })) : (_jsx("div", { className: "prose prose-invert prose-sm max-w-none", children: _jsx(ReactMarkdown, { rehypePlugins: [rehypeHighlight], children: message.content }) }))] }) }));
}
