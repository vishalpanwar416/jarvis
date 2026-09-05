// A deliberately small markdown renderer — enough for chat replies, small
// enough to rewrite. Handles fenced code, bullets, numbered items, inline
// `code` and **bold**.
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from './theme.js';

function Inline({ text, color }) {
  const { colors } = useTheme();
  // Split on inline code and bold, keeping the delimiters' contents.
  const parts = String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <Text color={color}>
      {parts.map((part, index) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <Text key={index} color={colors.code}>
              {part.slice(1, -1)}
            </Text>
          );
        }
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <Text key={index} bold>
              {part.slice(2, -2)}
            </Text>
          );
        }
        return <Text key={index}>{part}</Text>;
      })}
    </Text>
  );
}

export default function Markdown({ text, color }) {
  const { colors, glyphs } = useTheme();
  const lines = String(text ?? '').split('\n');
  const out = [];
  let fence = null;

  lines.forEach((line, index) => {
    const fenceMatch = /^\s*```(\w*)/.exec(line);
    if (fenceMatch) {
      if (fence) fence = null;
      else fence = fenceMatch[1] || 'code';
      return;
    }

    if (fence !== null) {
      out.push(
        <Text key={index} color={colors.code}>
          {'  ' + line}
        </Text>,
      );
      return;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(
        <Box key={index}>
          <Text color={colors.dim}>{`  ${glyphs.bullet} `}</Text>
          <Inline text={bullet[1]} color={color} />
        </Box>,
      );
      return;
    }

    const numbered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (numbered) {
      out.push(
        <Box key={index}>
          <Text color={colors.dim}>{`  ${numbered[1]}. `}</Text>
          <Inline text={numbered[2]} color={color} />
        </Box>,
      );
      return;
    }

    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.push(
        <Text key={index} bold color={colors.accent}>
          {heading[1]}
        </Text>,
      );
      return;
    }

    out.push(<Inline key={index} text={line} color={color} />);
  });

  return <Box flexDirection="column">{out}</Box>;
}
