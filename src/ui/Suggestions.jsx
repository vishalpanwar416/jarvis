// The slash-command menu under the prompt. Appears as soon as you type "/",
// narrows as you keep typing. Drawn by Composer, which owns the key handling.
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from './theme.js';

const VISIBLE = 8;

export default function Suggestions({ items, index }) {
  const { colors, glyphs } = useTheme();
  if (!items?.length) return null;

  // Scroll the window so the highlighted row is always on screen.
  const start =
    items.length <= VISIBLE ? 0 : Math.min(Math.max(0, index - VISIBLE + 1), items.length - VISIBLE);
  const shown = items.slice(start, start + VISIBLE);
  const width = Math.max(...items.map((item) => item.name.length));
  const hidden = items.length - shown.length;

  return (
    <Box flexDirection="column" marginLeft={2}>
      {shown.map((item, at) => {
        const on = start + at === index;
        return (
          <Box key={item.name}>
            <Text color={colors.accent}>{on ? `${glyphs.user} ` : '  '}</Text>
            <Text color={on ? colors.accent : colors.dim} bold={on}>
              {`/${item.name}`.padEnd(width + 1)}
            </Text>
            <Text color={colors.dim}>{`  ${item.help}`}</Text>
          </Box>
        );
      })}
      <Text color={colors.dim}>
        {`  ${hidden ? `…${hidden} more ${glyphs.bullet} ` : ''}tab complete ${glyphs.bullet} enter run ${glyphs.bullet} esc dismiss`}
      </Text>
    </Box>
  );
}
