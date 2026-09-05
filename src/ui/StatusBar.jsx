// The bottom line: model, spend, and which modes are armed.
// Kept to a single row that truncates rather than wraps, so a narrow terminal
// degrades instead of scrambling the layout.
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from './theme.js';

export default function StatusBar({
  model,
  totals,
  permissionMode,
  autopilot,
  voiceOut,
  listening,
  handsFree,
  awareness,
}) {
  const { colors, glyphs, layout } = useTheme();
  if (!layout.showStatus) return null;

  // Cache reads and writes are billed too, so they belong in the running count.
  const tokens =
    (totals.inputTokens ?? 0) +
    (totals.outputTokens ?? 0) +
    (totals.cacheReadTokens ?? 0) +
    (totals.cacheWriteTokens ?? 0);
  const compactTokens = tokens > 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

  const flags = [
    autopilot ? { label: 'autopilot', tone: 'warn' } : null,
    permissionMode !== 'default' ? { label: permissionMode, tone: 'warn' } : null,
    voiceOut ? { label: 'speech', tone: 'ok' } : null,
    awareness ? { label: 'aware', tone: 'ok' } : null,
    // Armed but quiet reads differently from actually hearing you.
    handsFree && !listening ? { label: `${glyphs.mic} hands-free`, tone: 'ok' } : null,
    listening ? { label: `${glyphs.mic} listening`, tone: 'err' } : null,
  ].filter(Boolean);

  return (
    <Box marginTop={1}>
      <Text color={colors.dim} wrap="truncate-end">
        {`${model}  ${glyphs.bullet} ${compactTokens} tok`}
      </Text>
      {flags.map((flag) => (
        <Text key={flag.label} color={colors[flag.tone]} wrap="truncate-end">
          {`  ${glyphs.bullet} ${flag.label}`}
        </Text>
      ))}
    </Box>
  );
}
