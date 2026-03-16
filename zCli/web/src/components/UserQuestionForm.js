import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// src/components/UserQuestionForm.tsx
import { useState, useCallback } from 'react';
export function UserQuestionForm({ questions, onSubmit, onCancel }) {
    const [answers, setAnswers] = useState(() => {
        const init = {};
        for (const q of questions) {
            init[q.key] = q.type === 'multiselect' ? [] : '';
        }
        return init;
    });
    const handleChange = useCallback((key, value) => {
        setAnswers(prev => ({ ...prev, [key]: value }));
    }, []);
    const handleSubmit = useCallback(() => {
        onSubmit(answers);
    }, [answers, onSubmit]);
    return (_jsxs("div", { className: "mx-4 my-2 p-4 bg-blue-900/30 border border-blue-600/50 rounded-lg", children: [_jsxs("div", { className: "flex items-center gap-2 mb-3", children: [_jsx("span", { className: "text-blue-400 text-lg", children: "?" }), _jsx("span", { className: "font-medium text-blue-200", children: "\u9700\u8981\u4F60\u7684\u8F93\u5165" })] }), _jsx("div", { className: "space-y-4", children: questions.map(q => (_jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-300 mb-1", children: q.title }), q.type === 'text' && (_jsx("input", { type: "text", value: answers[q.key], onChange: e => handleChange(q.key, e.target.value), placeholder: q.placeholder, className: "w-full bg-gray-800 text-gray-100 rounded px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500" })), q.type === 'select' && q.options && (_jsx("div", { className: "space-y-1", children: q.options.map(opt => (_jsxs("label", { className: `flex items-start gap-2 p-2 rounded cursor-pointer transition-colors ${answers[q.key] === opt.label ? 'bg-blue-800/50 border border-blue-500' : 'hover:bg-gray-800 border border-transparent'}`, children: [_jsx("input", { type: "radio", name: q.key, checked: answers[q.key] === opt.label, onChange: () => handleChange(q.key, opt.label), className: "mt-1" }), _jsxs("div", { children: [_jsx("div", { className: "text-sm text-gray-200", children: opt.label }), opt.description && _jsx("div", { className: "text-xs text-gray-400", children: opt.description })] })] }, opt.label))) })), q.type === 'multiselect' && q.options && (_jsx("div", { className: "space-y-1", children: q.options.map(opt => {
                                const selected = answers[q.key].includes(opt.label);
                                return (_jsxs("label", { className: `flex items-start gap-2 p-2 rounded cursor-pointer transition-colors ${selected ? 'bg-blue-800/50 border border-blue-500' : 'hover:bg-gray-800 border border-transparent'}`, children: [_jsx("input", { type: "checkbox", checked: selected, onChange: () => {
                                                const current = answers[q.key];
                                                handleChange(q.key, selected ? current.filter(v => v !== opt.label) : [...current, opt.label]);
                                            }, className: "mt-1" }), _jsxs("div", { children: [_jsx("div", { className: "text-sm text-gray-200", children: opt.label }), opt.description && _jsx("div", { className: "text-xs text-gray-400", children: opt.description })] })] }, opt.label));
                            }) }))] }, q.key))) }), _jsxs("div", { className: "flex gap-2 mt-4", children: [_jsx("button", { onClick: handleSubmit, className: "px-4 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-500 text-sm", children: "\u63D0\u4EA4" }), _jsx("button", { onClick: onCancel, className: "px-4 py-1.5 bg-gray-700 text-gray-300 rounded hover:bg-gray-600 text-sm", children: "\u53D6\u6D88" })] })] }));
}
