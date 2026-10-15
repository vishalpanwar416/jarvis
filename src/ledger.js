// What happened, written down as it happens.
//
// The notes in memory.js are what Jarvis was *told* to keep: they exist only
// when the model thought to call `remember`. That leaves the most ordinary
// question of all — "what were we doing?" — unanswerable, because nobody
// writes down the obvious at the time.
//
// This is the other half: a plain record of the work, folded out of the
// events the session already emits. No model call, no judgement, no prompt
// cost. A line per question asked, answer given, file changed and command
// run, tagged with the project it happened in. working-set.js reads it back.
//
// Three things keep an automatic recorder honest, and all three are here:
// an off switch, a horizon past which entries are deleted, and redaction of
// the things that should never have been written down in the first place.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MEMORY_DIR, projectAt } from './memory.js';

export const LEDGER_DIR = path.join(MEMORY_DIR, 'ledger');

const DAY_MS = 24 * 60 * 60 * 1000;
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Tools whose arguments are the interesting part. Everything else is noise
// at this resolution: a Read is not work, it is how work gets done.
const WATCHED = new Set([...EDIT_TOOLS, 'Bash']);

const day = (at = new Date()) => at.toISOString().slice(0, 10);

export const ledgerPath = (date = day()) => path.join(LEDGER_DIR, `${date}.jsonl`);

// Secrets get typed into terminals, and a command log is exactly the wrong
// place to find one six weeks later. Keep the shape of the command — which
// is the useful part — and drop the part that unlocks something.
export function redactCommand(command) {
  return String(command ?? '')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, 'gh_<redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-<redacted>')
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, 'AKIA<redacted>')
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY))=\S+/gi, '$1=<redacted>')
    .replace(/(--?(?:token|password|passwd|secret|api[-_]?key)[=\s])\S+/gi, '$1<redacted>')
    .replace(/((?:Authorization|X-Api-Key):\s*)\S+/gi, '$1<redacted>');
}

// Paths are recorded the way a person would say them: relative to the
// project when they are inside it, and under ~ when they are not. An
// absolute path to someone's home directory is noise in a log and a small
// leak in anything the log is later pasted into.
export function tidyPath(file, root = '') {
  // Guarded before resolve(): path.resolve('') is the working directory,
  // which would turn "no file" into a confident wrong answer.
  const raw = String(file ?? '').trim();
  if (!raw) return '';
  const full = path.resolve(raw);
  if (root && (full === root || full.startsWith(`${root}${path.sep}`))) {
    return path.relative(root, full) || path.basename(full);
  }
  const home = os.homedir();
  return full.startsWith(`${home}${path.sep}`) ? `~/${path.relative(home, full)}` : full;
}

// ---- writing ----

export function append(entry) {
  const line = { at: new Date().toISOString(), ...entry };
  try {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    fs.appendFileSync(ledgerPath(), `${JSON.stringify(line)}\n`);
  } catch {
    // A ledger that cannot be written is not worth failing a session over.
    return null;
  }
  return line;
}

// Entries older than the horizon go. Called when a session opens, which is
// often enough for a store that grows by a few kilobytes a day and never
// needs a scheduled job to look after it.
export function prune(keepDays = 30) {
  const oldest = day(new Date(Date.now() - keepDays * DAY_MS));
  let gone = 0;
  let files;
  try {
    files = fs.readdirSync(LEDGER_DIR);
  } catch {
    return 0;                                   // nothing written yet
  }
  for (const file of files) {
    const date = file.replace(/\.jsonl$/, '');
    if (file === date || date >= oldest) continue;
    try {
      fs.unlinkSync(path.join(LEDGER_DIR, file));
      gone += 1;
    } catch {
      // a file we cannot delete is not a reason to stop deleting
    }
  }
  return gone;
}

// ---- reading ----

// Oldest first, which is the order they happened in and the order a summary
// wants to read them. A day with no file is a day nothing was done.
export function readEntries({ days = 5, project = '', kinds = null } = {}) {
  const out = [];
  for (let back = days - 1; back >= 0; back--) {
    const file = ledgerPath(day(new Date(Date.now() - back * DAY_MS)));
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;                               // a half-written line, skip it
      }
      if (project && entry.project !== project) continue;
      if (kinds && !kinds.includes(entry.kind)) continue;
      out.push(entry);
    }
  }
  return out;
}

// What a stretch of ledger adds up to. Counts rather than a transcript:
// the working set has a line or two to say this in, not a page.
export function digest(entries) {
  const files = [];
  let edits = 0;
  let commands = 0;
  let failed = 0;
  let lastAsk = '';

  for (const entry of entries) {
    switch (entry.kind) {
      case 'edit':
        edits += 1;
        // Most recent first, each file once — the same file edited nine
        // times is one thing being worked on, not nine.
        if (entry.file) {
          const at = files.indexOf(entry.file);
          if (at !== -1) files.splice(at, 1);
          files.unshift(entry.file);
        }
        break;
      case 'run':
        commands += 1;
        if (entry.failed) failed += 1;
        break;
      case 'ask':
        if (entry.text) lastAsk = entry.text;
        break;
      default:
        break;
    }
  }
  return { edits, commands, failed, files, lastAsk };
}

// Drop every entry mentioning something, across every day still kept.
// Memory has `forget` for the notes; without the same reach here, a fact
// struck from the notes would still be sitting in the record of the work
// that produced it, and "forget that" would not have been true.
export function forgetEntries(match) {
  const needle = String(match ?? '').trim().toLowerCase();
  if (!needle) return 0;                        // an empty match must not empty the store
  let files;
  try {
    files = fs.readdirSync(LEDGER_DIR);
  } catch {
    return 0;
  }
  let gone = 0;
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const full = path.join(LEDGER_DIR, file);
    let lines;
    try {
      lines = fs.readFileSync(full, 'utf8').split('\n').filter((line) => line.trim());
    } catch {
      continue;
    }
    const kept = lines.filter((line) => !line.toLowerCase().includes(needle));
    if (kept.length === lines.length) continue;
    gone += lines.length - kept.length;
    try {
      if (kept.length) fs.writeFileSync(full, `${kept.join('\n')}\n`);
      else fs.unlinkSync(full);                 // a day with nothing left is not a day
    } catch {
      gone -= lines.length - kept.length;       // it is still there; do not claim it is not
    }
  }
  return gone;
}

// ---- the session recorder ----

// Folds a session's events into ledger lines. Everything interesting is
// already emitted by agent.js, so this listens rather than instruments.
//
// Tool calls are held until their result comes back: an Edit that errored
// changed nothing, and a log that cannot tell the difference is worse than
// no log. Anything still pending when the turn ends is written as it stands
// — an interrupted command did run, we just never heard how it went.
export function attachLedger(session, config) {
  const settings = config.ledger ?? {};
  if (settings.enabled === false) return () => {};

  const maxChars = settings.maxEntryChars ?? 240;
  const cwd = config.cwd;
  const here = projectAt(cwd);

  // Which project the work is in, in order of how much the answer is worth
  // trusting. A working directory inside a project settles it outright —
  // it was chosen deliberately and cannot be wrong.
  //
  // Run from somewhere that is no project — a home directory, most often,
  // which is where this actually gets run from — there is nothing to read
  // off the path, and the old answer was to tag the work with nothing at
  // all. But a turn that edits a file says perfectly clearly what it is
  // about. So those entries wait until the turn ends and are stamped with
  // whatever the turn turned out to touch.
  //
  // That waiting is why this is not simply done at write time: the
  // question is recorded before the first tool call, and the question is
  // the entry most worth having tagged.
  const fixed = here?.name ?? '';
  let root = here?.path ?? cwd;
  let turn = '';                                // what this turn's paths say
  let learned = '';                             // what an earlier turn's said
  const held = [];                              // waiting to be told where they happened
  const pending = new Map();
  let noted = '';                               // the session already written down

  prune(settings.keepDays ?? 30);

  const clip = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars);

  const write = (entry) => {
    // Stamped now even when it is written later, so the record stays in
    // the order things happened rather than the order they were resolved.
    const stamped = { at: new Date().toISOString(), ...entry };
    if (fixed) return append({ project: fixed, ...stamped });
    held.push(stamped);
    return null;
  };

  // The turn is over and whatever it was going to touch, it has touched.
  const settle = () => {
    const project = turn || learned;
    if (project) learned = project;             // carried to a turn that touches nothing
    for (const entry of held) append({ project, ...entry });
    held.length = 0;
    turn = '';
  };

  // Any path the turn mentions, whether or not it is worth recording. A
  // Read is not work and never becomes an entry, but it says as plainly as
  // an Edit does which project is being talked about.
  const observe = (input) => {
    if (fixed || turn) return;                  // settled, or already answered
    for (const key of ['file_path', 'notebook_path', 'path']) {
      const value = input?.[key];
      if (typeof value !== 'string' || !value.trim()) continue;
      const found = projectAt(path.resolve(cwd, value));
      if (!found) continue;
      turn = found.name;
      root = found.path;
      return;                                   // the first one named wins
    }
  };

  const flush = (id, failed) => {
    const held = pending.get(id);
    if (!held) return;
    pending.delete(id);
    write({ ...held, ...(failed === undefined ? {} : { failed }) });
  };

  const onEvent = (event) => {
    switch (event.kind) {
      case 'init':
        // The SDK announces itself more than once in a long conversation,
        // with the same id each time. One line per session, not per
        // announcement.
        if (event.sessionId && event.sessionId === noted) return;
        noted = event.sessionId ?? '';
        write({ kind: 'session', sessionId: event.sessionId, model: event.model, cwd: tidyPath(config.cwd) });
        return;

      case 'submitted': {
        turn = '';                              // a new question, asked afresh
        // The turn framing (autopilot, voice) is prepended to the message and
        // is not what was asked. Keep the last paragraph, which is.
        const text = clip(String(event.text ?? '').split('\n\n').pop());
        if (text) write({ kind: 'ask', text });
        return;
      }

      case 'tool-start': {
        observe(event.input);
        if (!WATCHED.has(event.name)) return;
        if (EDIT_TOOLS.has(event.name)) {
          const file = tidyPath(event.input?.file_path ?? event.input?.notebook_path ?? '', root);
          if (file) pending.set(event.id, { kind: 'edit', file, tool: event.name });
          return;
        }
        const command = clip(redactCommand(event.input?.command));
        if (command) pending.set(event.id, { kind: 'run', command });
        return;
      }

      case 'tool-end':
        flush(event.id, event.isError);
        return;

      case 'result': {
        for (const id of [...pending.keys()]) flush(id);
        const text = clip(String(event.text ?? '').split('\n').find((l) => l.trim()) ?? '');
        if (text) write({ kind: 'answer', text, error: event.isError || undefined });
        settle();
        return;
      }

      case 'closed':
        for (const id of [...pending.keys()]) flush(id);
        settle();
        return;

      default:
        return;
    }
  };

  session.on('event', onEvent);
  return () => session.off('event', onEvent);
}
