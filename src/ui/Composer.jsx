// The prompt line. Hand-rolled rather than pulled from a package so the key
// handling stays yours to change.
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from './theme.js';
import { useSpinner } from './Live.jsx';
import Suggestions from './Suggestions.jsx';
import { COMMANDS } from '../commands.js';

// A leading slash with nothing but command characters after it means the user
// is still naming a command — once there's a space they're typing arguments and
// the menu gets out of the way.
function completionsFor(value) {
  const match = /^\/([a-z-]*)$/i.exec(value);
  if (!match) return null;
  const prefix = match[1].toLowerCase();
  const names = Object.keys(COMMANDS).filter((name) => name.startsWith(prefix));
  return names.length ? names.map((name) => ({ name, help: COMMANDS[name].help })) : null;
}

export default function Composer({ value, onChange, onSubmit, active, busy, history, listening, ghost }) {
  const { colors, glyphs } = useTheme();
  const [cursor, setCursor] = useState(value.length);
  const [historyIndex, setHistoryIndex] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const [choice, setChoice] = useState(0);
  const spinner = useSpinner(busy);

  // Text can also arrive from outside — dictation writes each finished phrase
  // straight into the draft. Those edits aren't ours, so the cursor follows to
  // the end rather than staying where the typist left it.
  const own = useRef(value);
  useEffect(() => {
    if (value === own.current) return;
    own.current = value;
    setCursor(value.length);
  }, [value]);

  const matches = dismissed ? null : completionsFor(value);
  // Clamped rather than corrected in an effect, so a shrinking list can never
  // render a highlight that isn't there.
  const index = matches ? Math.min(choice, matches.length - 1) : 0;
  const selected = matches ? matches[index] : null;

  // Any change to the text restarts the menu: it reopens after an esc, and the
  // highlight goes back to the closest match.
  const set = (next, nextCursor = next.length) => {
    own.current = next;
    onChange(next);
    setCursor(Math.max(0, Math.min(nextCursor, next.length)));
    setChoice(0);
    setDismissed(false);
  };

  useInput(
    (input, key) => {
      if (key.ctrl || key.meta) return; // reserved for the global shortcuts

      if (key.escape) return setDismissed(true);

      // While the command menu is up it owns the arrows, tab and enter.
      if (selected) {
        if (key.upArrow) return setChoice((matches.length + index - 1) % matches.length);
        if (key.downArrow) return setChoice((index + 1) % matches.length);
        if (key.tab) return set(`/${selected.name} `);
        if (key.return) {
          setHistoryIndex(null);
          set('');
          onSubmit(`/${selected.name}`);
          return;
        }
      }
      if (key.tab) return; // never type a literal tab into the prompt

      // Typed Enter arrives as its own event with key.return set, but a paste
      // (or piped input) delivers the text and its trailing newline in a single
      // chunk with key.return false — so decide from the string, not the flag.
      // Newlines inside a paste become spaces; only a trailing one sends.
      if (key.return || /[\r\n]/.test(input)) {
        const typed = input.replace(/[\r\n]+$/, '').replace(/[\r\n]+/g, ' ');
        const next = value.slice(0, cursor) + typed + value.slice(cursor);
        const submits = key.return || /[\r\n]$/.test(input);

        if (!submits) return set(next, cursor + typed.length);
        const text = next.trim();
        if (!text) return;
        setHistoryIndex(null);
        set('');
        onSubmit(text);
        return;
      }

      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
        return;
      }

      if (key.leftArrow) return setCursor(Math.max(0, cursor - 1));
      if (key.rightArrow) return setCursor(Math.min(value.length, cursor + 1));

      // Up/down walk the prompt history, newest first.
      if (key.upArrow) {
        if (!history.length) return;
        const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(next);
        return set(history[next]);
      }
      if (key.downArrow) {
        if (historyIndex === null) return;
        const next = historyIndex + 1;
        if (next >= history.length) {
          setHistoryIndex(null);
          return set('');
        }
        setHistoryIndex(next);
        return set(history[next]);
      }

      if (input) set(value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length);
    },
    { isActive: active },
  );

  const before = value.slice(0, cursor);
  const at = value[cursor] ?? ' ';
  const after = value.slice(cursor + 1);

  // The phrase still being spoken, shown dim: it is a guess and will be
  // rewritten once the transcriber hears the end of it.
  // With the cursor at the end its own cell already supplies the gap; anywhere
  // else the spoken words would run into the draft, so add one.
  const gap = value && cursor < value.length && !/\s$/.test(value) ? ' ' : '';
  const spoken = ghost ? `${gap}${ghost}` : '';
  const marker = listening ? glyphs.mic : busy ? spinner : glyphs.user;
  const markerColor = listening ? colors.err : busy ? colors.warn : colors.accent;
  const idle = value.length === 0 && !spoken && !active && !listening;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={markerColor}>{`${marker} `}</Text>
        {idle ? (
          <Text color={colors.border}>waiting…</Text>
        ) : (
          <Text>
            <Text color={colors.user}>{before}</Text>
            <Text inverse={active}>{at}</Text>
            <Text color={colors.user}>{after}</Text>
            <Text color={colors.dim}>{spoken}</Text>
          </Text>
        )}
      </Box>
      {active ? <Suggestions items={matches} index={index} /> : null}
    </Box>
  );
}
