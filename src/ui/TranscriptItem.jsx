// One entry in the scrollback. Every kind the app can log is rendered here,
// so this is the file to edit when you want a different chat layout.
import React from 'react';
import { Box, Text } from 'ink';
import Markdown from './markdown.jsx';
import ToolLine from './ToolLine.jsx';
import Banner from './Banner.jsx';
import { useTheme } from './theme.js';

export default function TranscriptItem({ item, resultLines }) {
  const { colors, glyphs, layout } = useTheme();
  const gap = layout.compact ? 0 : 1;

  switch (item.kind) {
    // The banner is the first scrollback entry rather than part of the live
    // region, so it stays at the top of the log instead of being redrawn under it.
    case 'banner':
      return <Banner persona={item.persona} model={item.model} cwd={item.cwd} hint={item.hint} />;

    case 'user':
      return (
        <Box marginTop={gap}>
          <Text color={colors.accent}>{`${glyphs.user} `}</Text>
          <Text color={colors.user}>{item.text}</Text>
        </Box>
      );

    case 'assistant':
      return (
        <Box marginTop={gap} flexDirection="column">
          <Markdown text={item.text} color={colors.assistant} />
        </Box>
      );

    case 'thinking':
      return (
        <Box marginTop={gap}>
          <Text color={colors.thinking} italic>
            {`${glyphs.thinking} ${item.text}`}
          </Text>
        </Box>
      );

    case 'tool':
      return (
        <Box marginTop={layout.compact ? 0 : 1}>
          <ToolLine {...item} status="done" resultLines={resultLines} />
        </Box>
      );

    case 'note':
      return (
        <Box flexDirection="column">
          {String(item.text).split('\n').map((line, index) => (
            <Text key={index} color={colors.dim}>{`  ${line}`}</Text>
          ))}
        </Box>
      );

    case 'error':
      return (
        <Box marginTop={gap}>
          <Text color={colors.err}>{`${glyphs.err} ${item.text}`}</Text>
        </Box>
      );

    default:
      return null;
  }
}
