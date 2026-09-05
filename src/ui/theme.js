// Theme plumbing. Components never hardcode a colour or a glyph — they read
// them from here, so themes/*.json is the only file you need to touch to
// restyle the whole app.
import { createContext, useContext } from 'react';

export const ThemeContext = createContext(null);

export function useTheme() {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('useTheme() used outside <ThemeContext.Provider>');
  return theme;
}

// Named tones ('ok', 'warn', 'dim'…) resolve through the palette; anything
// else is passed through so a component can still use a literal colour.
export function useColor(tone, fallback = 'dim') {
  const { colors } = useTheme();
  return colors[tone] ?? colors[fallback] ?? undefined;
}
