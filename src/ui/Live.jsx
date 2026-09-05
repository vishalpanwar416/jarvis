// The region that redraws while a turn is in flight: the reply as it streams,
// the current thought, and any tool still running.
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Markdown from './markdown.jsx';
import ToolLine from './ToolLine.jsx';
import { useTheme } from './theme.js';

export function useSpinner(active) {
  const { glyphs } = useTheme();
  const frames = glyphs.spinner ?? ['-', '\\', '|', '/'];
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setFrame((current) => (current + 1) % frames.length), 90);
    return () => clearInterval(timer);
  }, [active, frames.length]);

  return active ? frames[frame] : ' ';
}

export default function Live({ busy, text, thinking, running, resultLines, elapsedMs }) {
  const { colors, glyphs } = useTheme();
  const spinner = useSpinner(busy);

  if (!busy && !text) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      {thinking ? (
        <Text color={colors.thinking} italic wrap="truncate-end">
          {`${glyphs.thinking} ${thinking.split('\n').pop().slice(0, 160)}`}
        </Text>
      ) : null}

      {running.map((tool) => (
        <ToolLine key={tool.id} {...tool} status="running" resultLines={resultLines} />
      ))}

      {text ? <Markdown text={text} color={colors.assistant} /> : null}

      {busy && !text ? (
        <Text color={colors.dim}>
          {`${spinner} working${elapsedMs > 1500 ? ` ${Math.round(elapsedMs / 1000)}s` : ''}`}
        </Text>
      ) : null}
    </Box>
  );
}
