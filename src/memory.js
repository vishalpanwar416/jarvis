// What Jarvis knows between conversations.
//
// Two different things share this file, because they answer the same
// question — "what do I already know about this?" — from opposite ends:
//
//   - the project index: where things live. Built by looking, not by being
//     told, so naming "sanero" resolves to a path without anyone having
//     written that down. Rebuilt when it goes stale.
//   - notes: what was learned. Written by Jarvis as it goes, one line at a
//     time, and read back into the system prompt on every session. This is
//     the part that cannot be derived by scanning a disk.
//
// Both are kept small on purpose. They are prepended to every prompt, so
// their cost is paid on every turn of every conversation; a memory that
// grows without limit would quietly eat the context it was meant to help.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const MEMORY_DIR = path.join(os.homedir(), '.jarvis', 'memory');
const NOTES = path.join(MEMORY_DIR, 'notes.md');
const INDEX = path.join(MEMORY_DIR, 'projects.json');

const INDEX_TTL_MS = 6 * 60 * 60 * 1000;   // a working day's half-life
const IN_PROMPT = 14;                       // projects named up front; the rest are a tool call away
const MAX_NOTES = 200;                      // oldest fall off the end
const MAX_NOTE_CHARS = 300;
const MAX_DEPTH = 3;                        // Aarambh/bezelrig is depth 2
const SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor',
  '.venv', 'venv', '__pycache__', '.next', '.cache', 'coverage', 'tmp',
]);
const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'composer.json'];

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

function defaultRoots() {
  return [path.join(os.homedir(), 'Development')].filter((dir) => fs.existsSync(dir));
}

// ---- the project index ----

// What a project is about, in one line. The cheapest true thing wins: a
// package description, else the first real line of the README. Neither is
// guaranteed, and a project with no description is still worth indexing —
// knowing where it is was the point.
function describe(dir) {
  const pkg = read(path.join(dir, 'package.json'));
  if (pkg) {
    try {
      const { description } = JSON.parse(pkg);
      if (description) return String(description).trim();
    } catch {
      // an unparseable package.json is not worth a word here
    }
  }
  for (const name of ['README.md', 'readme.md', 'README']) {
    const text = read(path.join(dir, name));
    if (!text) continue;
    for (const line of text.split('\n')) {
      const clean = line.replace(/^#+\s*/, '').trim();
      if (clean && !clean.startsWith('![') && !clean.startsWith('[!')) return clean.slice(0, 160);
    }
  }
  return '';
}

function gitRemote(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
  } catch {
    return '';
  }
}

// The most recent of the working tree and the last git activity: a repo
// checked out months ago but committed to this morning is a live project.
function touchedAt(dir) {
  let newest = 0;
  for (const rel of ['', '.git/HEAD', '.git/FETCH_HEAD']) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(dir, rel)).mtimeMs);
    } catch {
      // not every project is a repo
    }
  }
  return newest ? new Date(newest).toISOString() : null;
}

function isProject(dir) {
  return MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)));
}

// Walks the roots looking for project markers. A project that contains
// others (Aarambh does) is listed along with its children rather than
// instead of them — "the bezelrig one" and "the Aarambh one" are both
// things a person says.
function scan(roots) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;                                   // unreadable; not worth a note
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (isProject(full)) found.push({ name: entry.name, path: full });
      walk(full, depth + 1);
    }
  };
  for (const root of roots) walk(root, 1);

  // Two projects can share a name at different depths; the shallower one
  // is the one meant by the bare word.
  const byName = new Map();
  for (const project of found.sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    if (!byName.has(project.name.toLowerCase())) byName.set(project.name.toLowerCase(), project);
  }
  return [...byName.values()].map((project) => ({
    ...project,
    what: describe(project.path),
    remote: gitRemote(project.path),
    // When it was last touched, so the prompt can carry the handful being
    // worked on rather than all sixty.
    touched: touchedAt(project.path),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

export function loadIndex({ refresh = false, roots = null } = {}) {
  const stored = (() => {
    try {
      return JSON.parse(read(INDEX) ?? 'null');
    } catch {
      return null;
    }
  })();
  const fresh = stored && Date.now() - Date.parse(stored.scannedAt ?? 0) < INDEX_TTL_MS;
  if (stored && fresh && !refresh) return stored;

  const use = roots ?? stored?.roots ?? defaultRoots();
  const index = { scannedAt: new Date().toISOString(), roots: use, projects: scan(use) };
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(INDEX, JSON.stringify(index, null, 1));
  } catch {
    // an index that cannot be cached still works for this session
  }
  return index;
}

// An exact name wins outright. Otherwise every project containing the word
// comes back, because "sanero" is three of them here and picking one by
// position would be picking one at random.
export function findProjects(name) {
  const wanted = String(name ?? '').trim().toLowerCase();
  if (!wanted) return [];
  const { projects } = loadIndex();
  const exact = projects.find((p) => p.name.toLowerCase() === wanted);
  if (exact) return [exact];
  return projects.filter((p) => p.name.toLowerCase().includes(wanted));
}

export function findProject(name) {
  return findProjects(name)[0] ?? null;
}

// Which project a directory is *in*, which is a different question from
// which project is called something. Walks up until a marker turns up, so
// src/ui inside a repo answers with the repo rather than with nothing.
//
// Independent of the index on purpose: the working directory is known to be
// real, and waiting on a disk scan to name it would be the slow way round.
export function projectAt(dir) {
  let current = path.resolve(String(dir ?? '.'));
  for (;;) {
    if (isProject(current)) return { name: path.basename(current), path: current };
    const parent = path.dirname(current);
    if (parent === current) return null;        // reached /
    current = parent;
  }
}

// ---- notes ----

// The kinds a note can be filed under. A short closed set on purpose: the
// point is to tell a standing preference apart from a one-off observation,
// not to build a taxonomy nobody maintains.
export const KINDS = ['preference', 'decision', 'location', 'howto'];

// A note on disk, and the two things layer on top of the old shape:
//
//   - [2026-10-15] (jarvis) decision: deploys go out through Vercel
//   + [2026-10-15] (jarvis) preference: tests are written with node --test
//
// The leading + is a pin — it means "this is true regardless of what else
// is going on", and pinned notes keep their place in the prompt and are
// never dropped for age. A person editing notes.md by hand pins something
// by changing one character, which is the whole reason it is a character.
//
// Lines written before any of this parse as unpinned and unfiled, so the
// notes already on disk keep working and keep their meaning.
const NOTE_RE = /^([-+])\s*\[([^\]]*)\]\s*(?:\(([^)]*)\)\s*)?(.*)$/;

export function parseNote(line) {
  const match = NOTE_RE.exec(String(line ?? '').trim());
  if (!match) return null;
  const [, mark, date, project, rest] = match;
  // A kind counts only if it is one of the kinds. Without that check, a
  // note reading "Note: ring the office" gets filed under a kind called
  // "Note", and the set stops being closed the first time anyone writes
  // a sentence with a colon in it.
  const split = /^([A-Za-z]+):\s*(.*)$/.exec(rest);
  const kind = split && KINDS.includes(split[1].toLowerCase()) ? split[1].toLowerCase() : '';
  return {
    raw: line.trim(),
    pinned: mark === '+',
    date,
    project: (project ?? '').trim(),
    kind,
    text: (kind ? split[2] : rest).trim(),
  };
}

export function formatNote({ pinned = false, date, project = '', kind = '', text }) {
  return `${pinned ? '+' : '-'} [${date}]${project ? ` (${project})` : ''}${kind ? ` ${kind}:` : ''} ${text}`;
}

export function loadNotes() {
  return (read(NOTES) ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
}

export function parseNotes() {
  return loadNotes().map(parseNote).filter(Boolean);
}

// Drops the oldest notes past the cap — but only the unpinned ones. A note
// someone pinned is one they asked to keep, and age is not a reason to go
// back on that. Raw lines are carried through untouched, so anything in the
// file that this module cannot parse survives a write.
function cull(lines) {
  const out = [...lines];
  for (let i = 0; i < out.length && out.length > MAX_NOTES; ) {
    if (parseNote(out[i])?.pinned) i += 1;
    else out.splice(i, 1);
  }
  return out;
}

// One line, dated, optionally about a project, optionally filed and pinned.
// Returns what was kept.
//
// A note already held is not written twice: the same fact learned again is
// the same fact, and a memory that repeats itself reads as a memory that
// is not being used. Learning it again *with* a kind or a pin is different
// — that is new information about an old fact — so it upgrades the line
// that is already there rather than being dropped on the floor.
export function remember(note, project = '', { kind = '', pinned = false } = {}) {
  const text = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS);
  if (!text) return null;
  const tag = String(project ?? '').trim();
  const filed = KINDS.includes(String(kind ?? '').toLowerCase()) ? String(kind).toLowerCase() : '';
  const line = formatNote({
    pinned: Boolean(pinned),
    date: new Date().toISOString().slice(0, 10),
    project: tag,
    kind: filed,
    text,
  });

  const notes = loadNotes();
  // The same fact about the same project, whenever it was learned and
  // however it was filed.
  const sameAs = (entry) =>
    entry && entry.text.toLowerCase() === text.toLowerCase() && entry.project === tag;
  const at = notes.findIndex((existing) => sameAs(parseNote(existing)));

  let kept;
  if (at !== -1) {
    const held = parseNote(notes[at]);
    // Only ever upwards: a note does not get unpinned or unfiled by being
    // mentioned again in passing.
    const grown = { ...held, pinned: held.pinned || Boolean(pinned), kind: held.kind || filed };
    if (grown.pinned === held.pinned && grown.kind === held.kind) return held.raw;
    kept = [...notes];
    kept[at] = formatNote(grown);
  } else {
    kept = cull([...notes, line]);
  }

  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(NOTES, `${kept.join('\n')}\n`);
  } catch {
    return null;
  }
  return at !== -1 ? kept[at] : line;
}

// Drop every note containing `match`. Returns how many went.
export function forget(match) {
  const needle = String(match ?? '').trim().toLowerCase();
  if (!needle) return 0;
  const notes = loadNotes();
  const kept = notes.filter((line) => !line.toLowerCase().includes(needle));
  if (kept.length === notes.length) return 0;
  try {
    fs.writeFileSync(NOTES, kept.length ? `${kept.join('\n')}\n` : '');
  } catch {
    return 0;
  }
  return notes.length - kept.length;
}

// ---- what goes into the prompt ----

// Named rather than inlined so its length can be reserved out of the
// budget before the notes are fitted into what is left.
const TAIL =
  'Remember anything worth keeping with the remember tool — a decision, a preference, ' +
  'where something lives, how a project is deployed. Keep each one to a line, and do not ' +
  'write down what this block already says. File it as a preference, decision, location ' +
  'or howto when it plainly is one, and pin only what should be in front of you in every ' +
  'conversation regardless of subject — a pinned note costs its space on every turn of ' +
  'every session.';


// Newest first into whatever room is left, then back into the order they
// were written. Filling oldest-first would spend the budget before reaching
// the note most likely to matter.
function fit(entries, room) {
  const keep = [];
  let used = 0;
  for (const entry of [...entries].reverse()) {
    if (used + entry.raw.length + 1 > room) break;
    used += entry.raw.length + 1;
    keep.unshift(entry);
  }
  return keep;
}


// The block prepended to every conversation. Kept to a budget: the index
// is worth more than the notes when both cannot fit, because a wrong path
// wastes a tool call and a missing preference only costs a little polish.
// maxChars budgets the notes, which are the part that grows without limit.
// Three things sit outside it and are always kept: the project index,
// which is worth more than any note when both cannot fit; the closing
// instruction; and pinned notes, which are reserved ahead of both — a pin
// that a budget could drop would not mean anything. So a block can exceed
// maxChars, and does when the index alone is larger than it.
export function memoryBlock({ maxChars = 4000 } = {}) {
  const lines = [];
  const { projects } = loadIndex();
  if (projects.length) {
    // Only the ones in use. Sixty paths in every prompt would cost more
    // context than they save, and the tail is a tool call away.
    const recent = [...projects]
      .sort((a, b) => String(b.touched ?? '').localeCompare(String(a.touched ?? '')))
      .slice(0, IN_PROMPT);
    lines.push('Projects worked on lately, by name — use these paths rather than hunting for them:');
    for (const project of recent) {
      lines.push(`- ${project.name} — ${project.path}${project.what ? ` — ${project.what.slice(0, 70)}` : ''}`);
    }
    if (projects.length > recent.length) {
      lines.push(`There are ${projects.length - recent.length} more. The projects tool finds any of them by name; ` +
        'call it rather than searching the disk, and rather than guessing a path.');
    }
  }
  const notes = parseNotes();
  const section = (heading, entries, reserve = 0) => {
    if (!entries.length) return;
    const room = Math.max(0, maxChars - lines.join('\n').length - reserve);
    const keep = fit(entries, room);
    // A heading over nothing is worse than no heading, and when the budget
    // is this tight it is the likelier outcome of the two.
    if (keep.length) lines.push('', heading, ...keep.map((entry) => entry.raw));
  };

  // Pinned notes get first claim on the budget, because surviving exactly
  // this truncation is what pinning one is for. The ordinary ones take what
  // is left once there is room for the closing instruction too — the one
  // place a note is worth less than the sentence telling the model to keep
  // writing them.
  section('Standing facts — true whatever this conversation turns out to be about:',
    notes.filter((note) => note.pinned));
  section('What you have learned before now (most recent last):',
    notes.filter((note) => !note.pinned), TAIL.length + 2);
  if (!lines.length) return '';
  lines.push('', TAIL);
  return lines.join('\n');
}
