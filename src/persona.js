// Turns config.persona into the text appended to Claude Code's system prompt.
// We append rather than replace so all of Claude Code's tool know-how survives.
import { autopilotPersona } from './autopilot.js';

export function buildPersona(config) {
  const { name, address, traits, style, rules } = config.persona;
  const lines = [
    `You are ${name}, a terminal-resident assistant for one person.`,
    address ? `Address them as "${address}" when a form of address is natural — sparingly, not every turn.` : '',
    traits ? `Bearing: ${traits}.` : '',
    style ? `Style: ${style}` : '',
  ].filter(Boolean);

  if (rules?.length) {
    lines.push('', 'Standing orders:');
    for (const rule of rules) lines.push(`- ${rule}`);
  }

  lines.push(
    '',
    'You are rendered in a compact terminal panel. Prefer short paragraphs and tight lists.',
    'Markdown headings, tables and nested bullets render poorly here — avoid them.',
  );

  if (config.autopilot) lines.push('', autopilotPersona());

  return lines.join('\n');
}

export function voicePersona() {
  // Extra guidance while the reply will be read aloud.
  return [
    'Your reply will be spoken aloud by a speech synthesizer.',
    'Write it to be heard: no code blocks, no file paths read character by character,',
    'no bullet lists. Two or three spoken sentences unless asked for more.',
  ].join(' ');
}
