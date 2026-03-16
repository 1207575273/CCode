import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// src/pages/ChatPage.tsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { MessageBubble } from '../components/MessageBubble.js';
import { InputBar } from '../components/InputBar.js';
import { ToolStatus } from '../components/ToolStatus.js';
import { PermissionCard } from '../components/PermissionCard.js';
import { UserQuestionForm } from '../components/UserQuestionForm.js';
export function ChatPage({ targetSessionId }) {
    const { connected, lastEvent, send } = useWebSocket({ sessionId: targetSessionId });
    const [sessionId, setSessionId] = useState(null);
    const [sessionModel, setSessionModel] = useState(null);
    const [messages, setMessages] = useState([]);
    const [streaming, setStreaming] = useState('');
    const [isStreaming, setIsStreaming] = useState(false);
    const [toolEvents, setToolEvents] = useState([]);
    const [pendingPermission, setPendingPermission] = useState(null);
    const [pendingQuestions, setPendingQuestions] = useState(null);
    const bottomRef = useRef(null);
    const msgIdCounter = useRef(0);
    useEffect(() => {
        if (!lastEvent)
            return;
        handleServerEvent(lastEvent);
    }, [lastEvent]);
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, streaming, toolEvents]);
    function handleServerEvent(event) {
        switch (event.type) {
            case 'session_init': {
                // 连接时收到：sessionId + JSONL 历史消息还原
                setSessionId(event.sessionId);
                if (event.model)
                    setSessionModel(event.model);
                // URL 同步：如果当前路径不含 sessionId，更新 URL（不触发页面刷新）
                if (!targetSessionId && event.sessionId) {
                    window.history.replaceState(null, '', `/session/${event.sessionId}`);
                }
                // 还原历史消息
                const restored = event.messages.map(m => ({
                    id: m.id,
                    role: m.role,
                    content: m.content,
                }));
                setMessages(restored);
                msgIdCounter.current = restored.length;
                break;
            }
            case 'user_input': {
                // CLI 端的输入同步到 Web 显示
                const msg = {
                    id: `msg-${++msgIdCounter.current}`,
                    role: 'user',
                    content: event.text,
                    source: event.source,
                };
                setMessages(prev => [...prev, msg]);
                setStreaming('');
                setIsStreaming(true);
                break;
            }
            case 'text':
                setStreaming(prev => prev + event.text);
                break;
            case 'tool_start':
                setToolEvents(prev => [...prev, {
                        toolCallId: event.toolCallId,
                        toolName: event.toolName,
                        args: event.args,
                        status: 'running',
                    }]);
                break;
            case 'tool_done':
                setToolEvents(prev => prev.map(e => e.toolCallId === event.toolCallId
                    ? { ...e, status: 'done', durationMs: event.durationMs, success: event.success, resultSummary: event.resultSummary }
                    : e));
                break;
            case 'permission_request':
                setPendingPermission({ toolName: event.toolName, args: event.args });
                break;
            case 'user_question_request':
                setPendingQuestions(event.questions);
                break;
            case 'done': {
                // 将流式内容固化为消息气泡
                setStreaming(prev => {
                    if (prev) {
                        const assistantMsg = {
                            id: `msg-${++msgIdCounter.current}`,
                            role: 'assistant',
                            content: prev,
                        };
                        setMessages(msgs => [...msgs, assistantMsg]);
                    }
                    return '';
                });
                // 将已完成的工具事件写入消息历史（保留展示）
                setToolEvents(prev => {
                    if (prev.length > 0) {
                        const summary = prev.map(e => {
                            const status = e.success ? '✓' : e.success === false ? '✗' : '?';
                            const dur = e.durationMs != null ? ` (${e.durationMs}ms)` : '';
                            const result = e.resultSummary ? `\n  ⎿ ${e.resultSummary}` : '';
                            return `${status} ${e.toolName}${dur}${result}`;
                        }).join('\n');
                        setMessages(msgs => [...msgs, {
                                id: `msg-${++msgIdCounter.current}`,
                                role: 'system',
                                content: summary,
                            }]);
                    }
                    return [];
                });
                setIsStreaming(false);
                setPendingPermission(null);
                setPendingQuestions(null);
                break;
            }
            case 'bridge_stop':
                setMessages(prev => [...prev, {
                        id: `msg-${++msgIdCounter.current}`,
                        role: 'system',
                        content: 'Bridge Server 已关闭',
                    }]);
                break;
            case 'error':
                setStreaming('');
                setIsStreaming(false);
                setMessages(prev => [...prev, {
                        id: `msg-${++msgIdCounter.current}`,
                        role: 'system',
                        content: `错误: ${event.error}`,
                    }]);
                break;
            default:
                break;
        }
    }
    const handleSubmit = useCallback((text) => {
        // 流式中发新消息 → 先中止当前回复，再提交（与 CLI interruptAndSubmit 行为一致）
        if (isStreaming) {
            // 将已有流式内容固化为部分回复
            setStreaming(prev => {
                if (prev) {
                    setMessages(msgs => [...msgs, {
                            id: `msg-${++msgIdCounter.current}`,
                            role: 'assistant',
                            content: prev + '\n\n*(已中断)*',
                        }]);
                }
                return '';
            });
            setToolEvents([]);
            setPendingPermission(null);
            setPendingQuestions(null);
            send({ type: 'abort' });
        }
        setMessages(prev => [...prev, {
                id: `msg-${++msgIdCounter.current}`,
                role: 'user',
                content: text,
                source: 'web',
            }]);
        setStreaming('');
        setIsStreaming(true);
        // 短暂延迟让 abort 先到达 CLI，再发新消息
        setTimeout(() => send({ type: 'chat', text }), 50);
    }, [send, isStreaming]);
    const handlePermission = useCallback((allow) => {
        send({ type: 'permission', allow });
        setPendingPermission(null);
    }, [send]);
    const handleQuestionSubmit = useCallback((answers) => {
        send({ type: 'question', cancelled: false, answers });
        setPendingQuestions(null);
    }, [send]);
    const handleQuestionCancel = useCallback(() => {
        send({ type: 'question', cancelled: true });
        setPendingQuestions(null);
    }, [send]);
    const inputDisabled = !connected;
    return (_jsxs("div", { className: "flex flex-col h-screen", children: [_jsxs("header", { className: "flex items-center justify-between px-4 py-3 border-b border-gray-700", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("h1", { className: "text-lg font-semibold", children: "ZCli" }), sessionModel && _jsx("span", { className: "text-xs text-gray-400 bg-gray-800 px-2 py-0.5 rounded", children: sessionModel }), sessionId && _jsx("span", { className: "text-xs text-gray-500 font-mono", children: sessionId.slice(0, 8) })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: `text-xs px-2 py-1 rounded ${connected ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}`, children: connected ? '已连接' : '断开' }), _jsx("button", { onClick: () => {
                                    if (window.confirm('确定关闭 Bridge Server？所有 Web 客户端将断开连接。')) {
                                        fetch('/api/bridge/stop', { method: 'POST' }).catch(() => { });
                                    }
                                }, className: "text-xs px-2 py-1 rounded bg-red-900/50 text-red-400 hover:bg-red-800 transition-colors", title: "\u5173\u95ED Bridge Server", children: "\u5173\u95ED Bridge" })] })] }), _jsxs("div", { className: "flex-1 overflow-y-auto p-4", children: [messages.map(msg => (_jsx(MessageBubble, { message: msg }, msg.id))), streaming && (_jsx(MessageBubble, { message: { id: 'streaming', role: 'assistant', content: streaming } })), _jsx(ToolStatus, { events: toolEvents }), pendingPermission && (_jsx(PermissionCard, { toolName: pendingPermission.toolName, args: pendingPermission.args, onAllow: () => handlePermission(true), onDeny: () => handlePermission(false) })), pendingQuestions && (_jsx(UserQuestionForm, { questions: pendingQuestions, onSubmit: handleQuestionSubmit, onCancel: handleQuestionCancel })), _jsx("div", { ref: bottomRef })] }), _jsx(InputBar, { onSubmit: handleSubmit, disabled: inputDisabled })] }));
}
