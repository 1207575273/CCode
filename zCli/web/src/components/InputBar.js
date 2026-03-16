import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// src/components/InputBar.tsx
import { useState, useCallback } from 'react';
export function InputBar({ onSubmit, disabled }) {
    const [text, setText] = useState('');
    const handleSubmit = useCallback(() => {
        const trimmed = text.trim();
        if (!trimmed || disabled)
            return;
        onSubmit(trimmed);
        setText('');
    }, [text, disabled, onSubmit]);
    const handleKeyDown = useCallback((e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    }, [handleSubmit]);
    return (_jsxs("div", { className: "flex gap-2 p-4 border-t border-gray-700", children: [_jsx("textarea", { value: text, onChange: e => setText(e.target.value), onKeyDown: handleKeyDown, placeholder: "\u8F93\u5165\u6D88\u606F... (Enter \u53D1\u9001, Shift+Enter \u6362\u884C)", disabled: disabled, className: "flex-1 bg-gray-800 text-gray-100 rounded-lg px-4 py-3 resize-none outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500 disabled:opacity-50", rows: 2 }), _jsx("button", { onClick: handleSubmit, disabled: disabled || !text.trim(), className: "self-end px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600 transition-colors", children: "\u53D1\u9001" })] }));
}
