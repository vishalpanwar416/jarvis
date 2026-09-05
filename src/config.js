// Config + theme loading.
//
// Resolution order (later wins):
//   1. DEFAULTS below
//   2. <project>/jarvis.config.json
//   3. ~/.jarvis/config.json          (personal overrides, not in the repo)
//   4. command-line flags
//
// Themes are separate files in themes/ so UI tweaking never touches config.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const USER_DIR = path.join(os.homedir(), '.jarvis');

export const DEFAULTS = {
  // Identity — shapes the system prompt. See src/persona.js.
  persona: {
    name: 'Jarvis',
    address: 'sir',
    traits: 'dry, precise, unhurried, quietly competent',
    style: 'Lead with the answer. Short sentences. No filler, no flattery.',
    rules: [
      'Speak plainly; never pad a reply to sound busy.',
      'When you act on the machine, say what you did in one line.',
      'If something is unclear and the answer changes what you do, ask.',
    ],
  },

  model: 'claude-opus-5',
  // The menu /model offers. Empty means the built-in list in src/models.js;
  // set it here to pin your own, e.g. [{ "id": "claude-sonnet-5", "label": "Sonnet 5" }].
  // Either way /model <id> still accepts an id that isn't on the list.
  models: [],
  effort: 'high',
  cwd: process.cwd(),

  // 'default' prompts you in-app before risky tools run (recommended).
  // 'acceptEdits' auto-approves file edits. 'bypassPermissions' approves everything.
  permissionMode: 'default',
  // Tools approved up front, never prompted for. Enforced by our own permission
  // callback (see isPreApproved in src/agent.js), so answering "always allow" at
  // a prompt extends this list for the rest of the session.
  allowedTools: ['Read', 'Glob', 'Grep', 'TodoWrite', 'WebFetch', 'WebSearch'],
  disallowedTools: [],
  // Load your CLAUDE.md / settings / skills from disk, same as Claude Code.
  settingSources: ['user', 'project', 'local'],
  // Autopilot: allow every tool, answer every question with its recommended
  // option, resolve every picker, and tell the model not to ask. Toggle live
  // with ctrl+p or /autopilot; start armed with --autopilot. See src/autopilot.js.
  autopilot: false,

  ui: {
    theme: 'midnight',
    showThinking: true,
    // Lines of tool output to keep on screen per tool call.
    toolResultLines: 3,
  },

  // Ambient panel. Toggle live with ctrl+a.
  awareness: {
    enabled: false,
    intervalMs: 5000,
    // Built-ins: 'clock' | 'cwd' | 'git' | 'system'
    builtins: ['clock', 'git', 'system'],
    // Add your own. Output is trimmed to one line.
    // { "label": "crons", "command": "hermes jobs --count", "tone": "dim" }
    probes: [],
  },

  // Voice. Toggle output with ctrl+o, push-to-talk with ctrl+t.
  voice: {
    output: false,
    input: false,
    // Send a transcript immediately, or drop it into the composer to edit first.
    autoSend: false,
    // 'auto' picks the first backend found on PATH. See src/voice.js for the
    // chains, or pin one: tts.engine = 'spd-say', stt.engine = 'whisper-cpp'.
    tts: { engine: 'auto', voice: '', rate: '', command: '' },
    // stt.command transcribes a finished take; streamCommand transcribes while
    // you speak, so the words appear in the composer as you say them. Empty
    // means `jarvis-stt-stream` if it's on PATH. prewarm loads its model at
    // startup so the first ctrl+t doesn't wait for it; streaming: false pins
    // the old transcribe-afterwards behaviour.
    // settleMs is how long a key-ended take waits for its last frames before
    // asking for the transcript; finalTimeoutMs is how long it waits for the
    // answer before settling for what it already has.
    stt: {
      engine: 'auto',
      model: '',
      command: '',
      streamCommand: '',
      streaming: true,
      prewarm: true,
      settleMs: 120,
      finalTimeoutMs: 5000,
    },
    // Voice activity detection. It ends a take on silence so ctrl+t is one
    // press rather than two, and in hands-free it starts one as well.
    // threshold 0 learns the room's noise floor; set it to pin the gate.
    vad: { enabled: true, threshold: 0, startMs: 140, silenceMs: 850, maxMs: 30000, preRollMs: 320 },
    // Hands-free keeps the mic open and sends each utterance as you finish it.
    // It goes deaf while a turn is running so it can't answer its own reply.
    handsFree: { enabled: false, pauseWhileBusy: true },
    recorder: { engine: 'auto', device: '' },
  },

  // Shell tasks Jarvis can run for you. Each becomes a tool the model can call
  // AND a `/run <name>` command. {{arg}} placeholders are shell-quoted.
  automations: [],
};

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function merge(base, patch) {
  if (!isObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isObject(value) && isObject(base?.[key]) ? merge(base[key], value) : value;
  }
  return out;
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
}

export function loadConfig(overrides = {}) {
  let config = DEFAULTS;
  config = merge(config, readJson(path.join(ROOT, 'jarvis.config.json')) ?? {});
  config = merge(config, readJson(path.join(USER_DIR, 'config.json')) ?? {});
  config = merge(config, overrides);
  config.cwd = path.resolve(config.cwd);
  return config;
}

export function themePath(name) {
  const candidates = [
    path.join(USER_DIR, 'themes', `${name}.json`),
    path.join(ROOT, 'themes', `${name}.json`),
  ];
  return candidates.find((file) => fs.existsSync(file));
}

export function listThemes() {
  const names = new Set();
  for (const dir of [path.join(ROOT, 'themes'), path.join(USER_DIR, 'themes')]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.json')) names.add(file.replace(/\.json$/, ''));
    }
  }
  return [...names].sort();
}

export function loadTheme(name) {
  const file = themePath(name) ?? themePath('midnight');
  if (!file) throw new Error(`no theme found for "${name}" and no midnight fallback in themes/`);
  const theme = readJson(file);
  // A theme may extend another so you only override the few keys you care about.
  if (theme.extends) return merge(loadTheme(theme.extends), { ...theme, extends: undefined });
  return theme;
}
