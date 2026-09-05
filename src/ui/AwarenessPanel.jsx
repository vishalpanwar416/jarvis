// The ambient panel: whatever src/awareness.js collected, on one framed row.
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from './theme.js';

export default function AwarenessPanel({ rows }) {
  const { colors, glyphs, layout } = useTheme();
  if (!rows?.length) return null;

  return (
    <Box
      borderStyle={layout.borderStyle}
      borderColor={colors.border}
      paddingX={1}
      marginTop={1}
      flexWrap="wrap"
    >
      {rows.map((row, index) => (
        <Box key={row.label} marginRight={2}>
          <Text color={colors.dim}>{`${row.label} `}</Text>
          <Text color={colors[row.tone] ?? colors.assistant}>{row.value}</Text>
          {index < rows.length - 1 ? <Text color={colors.border}>{`  ${glyphs.bullet}`}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}
