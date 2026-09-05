// Shown when the agent wants to use a tool that isn't pre-approved.
// y — once, a — always this tool, n/esc — deny.
import React from 'react';
import { Box, Text } from 'ink';
import { summarizeInput } from './ToolLine.jsx';
import { useTheme } from './theme.js';

export default function PermissionPrompt({ request }) {
  const { colors, glyphs, layout } = useTheme();
  if (!request) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle={layout.borderStyle}
      borderColor={colors.warn}
      paddingX={1}
      marginTop={1}
    >
      <Box>
        <Text color={colors.warn}>{`${glyphs.tool} permission  `}</Text>
        <Text color={colors.tool} bold>
          {request.toolName}
        </Text>
      </Box>
      <Text color={colors.toolArg}>{summarizeInput(request.toolName, request.input)}</Text>
      <Text color={colors.dim}>
        <Text color={colors.ok}>y</Text> allow once {glyphs.bullet} <Text color={colors.ok}>a</Text> always allow{' '}
        {glyphs.bullet} <Text color={colors.err}>n</Text> deny
      </Text>
    </Box>
  );
}
