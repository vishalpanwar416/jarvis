// The greeting block. The art itself lives in themes/*.json under "banner".
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from './theme.js';

export default function Banner({ persona, model, cwd, hint }) {
  const { colors, glyphs, layout, banner } = useTheme();
  if (!layout.showBanner) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {(banner ?? []).map((line, index) => (
        <Text key={index} color={colors.banner}>
          {line}
        </Text>
      ))}
      <Box marginTop={banner?.length ? 1 : 0}>
        <Text color={colors.accent} bold>
          {persona.name}
        </Text>
        <Text color={colors.dim}>{`  ${glyphs.bullet} ${model}  ${glyphs.bullet} ${cwd}`}</Text>
      </Box>
      <Text color={colors.dim}>{hint}</Text>
    </Box>
  );
}
