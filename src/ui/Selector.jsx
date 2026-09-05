// A list you arrow through. Any command can open one with api.pick({...}),
// which resolves to the chosen item — or null if the user backs out.
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from './theme.js';

export default function Selector({ request, onResolve }) {
  const { colors, glyphs, layout } = useTheme();
  const items = request.items;
  const [index, setIndex] = useState(() => {
    const at = items.findIndex((item) => item.current);
    return at === -1 ? 0 : at;
  });

  useInput((input, key) => {
    if (key.escape || input === 'q') return onResolve(null);
    if (key.return) return onResolve(items[index]);
    if (key.upArrow || input === 'k') return setIndex((at) => (at - 1 + items.length) % items.length);
    if (key.downArrow || input === 'j') return setIndex((at) => (at + 1) % items.length);
    // 1-9 jump straight to a row, the way you'd expect of a short menu.
    const digit = Number.parseInt(input, 10);
    if (digit >= 1 && digit <= items.length) onResolve(items[digit - 1]);
  });

  const width = Math.max(...items.map((item) => item.label.length));

  return (
    <Box
      flexDirection="column"
      borderStyle={layout.borderStyle}
      borderColor={colors.accent}
      paddingX={1}
      marginTop={1}
    >
      <Text color={colors.accent} bold>
        {request.title}
      </Text>
      {request.hint ? <Text color={colors.dim}>{request.hint}</Text> : null}

      <Box flexDirection="column" marginTop={1}>
        {items.map((item, at) => {
          const on = at === index;
          return (
            <Box key={item.id}>
              <Text color={colors.accent}>{on ? `${glyphs.user} ` : '  '}</Text>
              <Text color={on ? colors.assistant : colors.dim} bold={on}>
                {item.label.padEnd(width)}
              </Text>
              {item.note ? <Text color={colors.dim}>{`  ${item.note}`}</Text> : null}
              {item.current ? <Text color={colors.ok}>{`  ${glyphs.ok} in use`}</Text> : null}
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text color={colors.dim}>
          {`↑↓ move ${glyphs.bullet} enter select ${glyphs.bullet} 1-${items.length} jump ${glyphs.bullet} esc cancel`}
        </Text>
      </Box>
    </Box>
  );
}
