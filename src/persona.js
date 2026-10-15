// Turns config.persona into the text appended to Claude Code's system prompt.
// We append rather than replace so all of Claude Code's tool know-how survives.
import { autopilotPersona, autopilotPrefix } from './autopilot.js';
import { memoryBlock } from './memory.js';
import { workingSetBlock } from './working-set.js';
import { recallBlock } from './recall.js';

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
  if (config.askFirst) lines.push('', askFirstPersona());

  if (config.memory !== false) {
    // Where the work is, before what is known about it. The smallest and
    // most specific thing goes first because it is the thing most likely to
    // be what the next question is about.
    const now = workingSetBlock(config);
    if (now) lines.push('', now);

    // What is already known, so a named project does not have to be hunted
    // for and a preference does not have to be stated twice.
    const known = memoryBlock();
    if (known) lines.push('', known);
  }

  return lines.join('\n');
}

// Said up front where anything beyond reading has to be asked for, so the
// model knows the shape of the place it is working in: a small floating
// window, one person, who may not be looking at it.
export function askFirstPersona() {
  return [
    'Reading, searching and fetching are yours to use. Anything that changes',
    'something — Write, Edit, Bash — is put to the person first, and they may',
    'be away from the screen, so an unanswered request is refused after a',
    'minute or two. Ask for what the work genuinely needs and no more: one',
    'considered edit will be granted where a series of speculative commands',
    'will not. If a request is refused, do not go round it by another tool.',
    'Say plainly what you could not do, give the exact edit or command, and',
    'note that `jarvis` in a terminal has this same conversation and can run',
    'it. Never present code you could not run as though you had run it.',
  ].join(' ');
}

// Extra guidance while the reply will be read aloud, by this machine's
// speech synthesizer, to someone who may not be looking at the screen.
//
// Without this the model writes for a terminal — headings, bullets, paths,
// fenced code — and the layer that reads it out is left stripping markdown
// and cutting mid-thought. Shaping the answer at the source is the only
// place the result is a sentence somebody would actually say.
export function voicePersona() {
  return [
    'This answer will be read out loud. Write it to be heard once, not read.',
    'Lead with the answer in the first sentence. Two or three sentences, forty words or so,',
    'unless more was asked for.',
    'No markdown, no bullet lists, no headings, no code blocks, no URLs: every one of those',
    'is read out as punctuation noise or spelled letter by letter.',
    'Say names the way a person says them — "the voice module", not the whole path;',
    '"about nine hundred lines", not an exact count nobody can hold in their head.',
    'Never read an id, a hash or a long number aloud; say what it is and that it is on screen.',
    'If the real answer is a list, say how many there are and name the two or three that matter.',
    'If you are leaving something out, end by saying so in a clause — the full answer is on screen',
    'and they can ask for the rest.',
  ].join(' ');
}

// The bracketed prefix carried on a single message. The system prompt is
// fixed when a session opens, and voice is decided per question — the same
// terminal conversation is half typed and half spoken — so this rides along
// with the turn rather than being baked in at the start.
export function voicePrefix() {
  return `[spoken] ${voicePersona()}`;
}

// How a turn's prompt is framed, in one place.
//
// A session's system prompt is written once, when it opens; what is true of
// a single turn is not. Autopilot gets switched on mid-conversation, and
// speech comes and goes question by question — the same session is typed at
// and spoken to by turns. Both therefore ride on the message.
//
// All three front ends (the terminal UI, one-shot, serve) come through here,
// so none of them can quietly grow its own idea of the wording.
//
// Recall rides here too, and deliberately not in the system prompt. What is
// worth retrieving changes with every question; the system prompt is fixed
// when the session opens and is the part that gets cached. Rewriting it per
// turn to inject context would cost more than the context is worth.
//
// Without a config there is nothing to search, so framePrompt(text) alone
// still returns exactly what it was given.
export function framePrompt(text, { autopilot = false, voice = false, config = null } = {}) {
  const prefixes = [
    autopilot ? autopilotPrefix() : '',
    voice ? voicePrefix() : '',
    config ? recallBlock(text, config) : '',
  ].filter(Boolean);
  return prefixes.length ? `${prefixes.join('\n\n')}\n\n${text}` : text;
}
