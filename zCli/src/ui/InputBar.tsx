// src/ui/InputBar.tsx
import React, { useState } from 'react'
import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'
import { useTerminalSize } from './useTerminalSize.js'

interface InputBarProps {
  onSubmit: (value: string) => void
  placeholder?: string
  disabled?: boolean
}

export function InputBar({
  onSubmit,
  placeholder = 'Try "how does <filepath> work?"',
  disabled = false,
}: InputBarProps) {
  const [value, setValue] = useState('')
  const { columns } = useTerminalSize()

  function handleSubmit(text: string) {
    if (disabled) return
    const trimmed = text.trim()
    if (!trimmed) return
    onSubmit(trimmed)
    setValue('')
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{'─'.repeat(columns)}</Text>
      </Box>
      <Box paddingLeft={1}>
        {disabled
          ? <Text dimColor>❯ </Text>
          : <Text color="green">❯ </Text>
        }
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder={placeholder}
        />
      </Box>
      <Box>
        <Text dimColor>{'─'.repeat(columns)}</Text>
      </Box>
    </Box>
  )
}
