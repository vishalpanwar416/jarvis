// One tool call: name, the argument worth seeing, and a clipped result.
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from './theme.js';

// Tools carry different "headline" arguments; show the one that identifies the call.
export function summarizeInput(name, input = {}) {
  const first =
    input.file_path ??
    input.path ??
    input.command ??
    input.pattern ??
    input.url ??
    input.query ??
    input.prompt ??
    input.description;
  if (first === undefined) {
    const keys = Object.keys(input);
    return keys.length ? `${keys[0]}=${String(input[keys[0]]).slice(0, 60)}` : '';
  }
  return String(first).replace(/\s+/g, ' ').slice(0, 100);
}

export default function ToolLine({ name, input, status, isError, preview, resultLines }) {
  const { colors, glyphs } = useTheme();
  const mark = status === 'running' ? glyphs.tool : isError ? glyphs.err : glyphs.ok;
  const markColor = status === 'running' ? colors.tool : isError ? colors.err : colors.ok;
  const label = name.startsWith('mcp__') ? name.split('__').slice(-1)[0] : name;

  const lines = (preview ?? '')
    .split('\n')
    .filter((line) => line.trim())
    .slice(0, resultLines);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={markColor}>{`${mark} `}</Text>
        <Text color={colors.tool}>{label}</Text>
        <Text color={colors.toolArg}>{`  ${summarizeInput(name, input)}`}</Text>
      </Box>
      {lines.map((line, index) => (
        <Text key={index} color={isError ? colors.err : colors.dim}>
          {`    ${line.slice(0, 160)}`}
        </Text>
      ))}
    </Box>
  );
}
