// The memory store, against a temp HOME so the real one is never touched.
//
//   node --test test/memory.test.mjs
//
// memory.js reads os.homedir() when it is imported, so HOME is set before
// the import rather than after — hence the dynamic import below.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mem-'));
process.env.HOME = home;
const mem = await import('../src/memory.js');

const projects = path.join(home, 'Development');
before(() => {
  // A little world to scan: two projects, one nested, one decoy.
  const make = (rel, files) => {
    const dir = path.join(projects, rel);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  };
  make('alpha', { 'package.json': JSON.stringify({ name: 'alpha', description: 'The alpha service' }) });
  // A README alone is not a project — that would sweep up docs folders —
  // so beta is a repo whose description has to come from its README.
  make('beta', { 'README.md': '# Beta\n\nThe beta tool\n' });
  fs.mkdirSync(path.join(projects, 'beta', '.git'), { recursive: true });
  make('house/gamma', { 'package.json': JSON.stringify({ name: 'gamma' }) });
  make('house', { 'package.json': JSON.stringify({ name: 'house', description: 'A place things live' }) });
  fs.mkdirSync(path.join(projects, 'notaproject'), { recursive: true });
  fs.mkdirSync(path.join(projects, 'alpha', 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(projects, 'alpha', 'node_modules', 'dep', 'package.json'), '{}');
});
after(() => {
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test('finds projects by their markers, not by name', () => {
  const { projects: found } = mem.loadIndex({ refresh: true, roots: [projects] });
  const names = found.map((p) => p.name);
  assert.ok(names.includes('alpha'), 'a package.json makes a project');
  assert.ok(names.includes('beta'), 'so does a .git');
  assert.ok(!names.includes('notaproject'), 'a directory with no marker is not one');
  assert.ok(!names.includes('dep'), 'and node_modules is never walked into');
});

test('a project inside another is found as well as it', () => {
  const { projects: found } = mem.loadIndex({ refresh: true, roots: [projects] });
  const names = found.map((p) => p.name);
  assert.ok(names.includes('house'), 'the container');
  assert.ok(names.includes('gamma'), 'and what it contains');
});

test('a README alone does not make a project', () => {
  const dir = path.join(projects, 'justdocs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Notes\n');
  const { projects: found } = mem.loadIndex({ refresh: true, roots: [projects] });
  assert.ok(!found.some((p) => p.name === 'justdocs'),
    'otherwise every docs folder on the disk becomes a project');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('describes a project from whatever it has', () => {
  const { projects: found } = mem.loadIndex({ refresh: true, roots: [projects] });
  assert.equal(found.find((p) => p.name === 'alpha').what, 'The alpha service', 'package description');
  assert.equal(found.find((p) => p.name === 'beta').what, 'Beta', 'else the README heading');
  assert.equal(found.find((p) => p.name === 'gamma').what, '', 'and nothing when there is nothing');
});

test('an exact name beats a partial one', () => {
  mem.loadIndex({ refresh: true, roots: [projects] });
  assert.equal(mem.findProjects('alpha').length, 1);
  assert.equal(mem.findProject('alpha').name, 'alpha');
  assert.equal(mem.findProject('ALPHA').name, 'alpha', 'case does not matter');
});

test('an ambiguous name comes back ambiguous', () => {
  mem.loadIndex({ refresh: true, roots: [projects] });
  const hits = mem.findProjects('a');           // alpha, beta, gamma, house all contain "a"
  assert.ok(hits.length > 1, 'every match is returned rather than one at random');
});

test('a name that is nothing gives nothing', () => {
  assert.deepEqual(mem.findProjects('zzz'), []);
  assert.equal(mem.findProject('zzz'), null);
  assert.deepEqual(mem.findProjects(''), []);
  assert.deepEqual(mem.findProjects(null), []);
});

test('notes are kept, dated and tagged', () => {
  const line = mem.remember('deploys through Vercel', 'alpha');
  assert.match(line, /^- \[\d{4}-\d{2}-\d{2}\] \(alpha\) deploys through Vercel$/);
  assert.ok(mem.loadNotes().includes(line));
});

test('the same fact learned twice is kept once', () => {
  const before = mem.loadNotes().length;
  mem.remember('deploys through Vercel', 'alpha');
  assert.equal(mem.loadNotes().length, before, 'a memory that repeats itself is not being used');
});

test('nothing is not remembered', () => {
  assert.equal(mem.remember('   '), null);
  assert.equal(mem.remember(''), null);
  assert.equal(mem.remember(null), null);
});

test('forgetting takes every note that matches', () => {
  mem.remember('uses pnpm', 'beta');
  mem.remember('pnpm again elsewhere');
  const gone = mem.forget('pnpm');
  assert.equal(gone, 2);
  assert.ok(!mem.loadNotes().some((n) => n.includes('pnpm')));
  assert.equal(mem.forget('nothing matches this'), 0);
  assert.equal(mem.forget(''), 0, 'an empty match must not empty the store');
});

test('the prompt block stays within its budget', () => {
  for (let i = 0; i < 300; i++) mem.remember(`a note number ${i} with some length to it`.repeat(3));
  mem.loadIndex({ refresh: true, roots: [projects] });
  const block = mem.memoryBlock({ maxChars: 2000 });
  assert.ok(block.length < 4000, `block was ${block.length} chars — it goes into every prompt`);
  assert.ok(block.includes('alpha'), 'and still says where things are');
});

test('the newest notes are the ones that survive', () => {
  mem.remember('the freshest thing of all');
  const block = mem.memoryBlock({ maxChars: 2000 });
  assert.ok(block.includes('the freshest thing of all'), 'recent notes beat old ones for the space');
});

test('an empty store produces no block at all', () => {
  fs.rmSync(mem.MEMORY_DIR, { recursive: true, force: true });
  mem.loadIndex({ refresh: true, roots: [path.join(home, 'nothing-here')] });
  assert.equal(mem.memoryBlock(), '', 'nothing known means nothing said');
});

// ---- kinds and pins ----
//
// These run after the test above has emptied the store, and each starts
// from a clean notes file. No global beforeEach: the tests further up this
// file deliberately build on each other's state.

const fresh = () => {
  fs.rmSync(path.join(mem.MEMORY_DIR, 'notes.md'), { force: true });
};

test('notes written before any of this still parse', () => {
  // The shape that was on disk before kinds and pins existed.
  const old = mem.parseNote('- [2026-09-20] (sanero) Production deploys go out through Vercel');
  assert.equal(old.pinned, false);
  assert.equal(old.kind, '', 'unfiled, not mis-filed');
  assert.equal(old.project, 'sanero');
  assert.equal(old.text, 'Production deploys go out through Vercel');

  const untagged = mem.parseNote('- [2026-09-21] Prefers node --test over jest');
  assert.equal(untagged.project, '');
  assert.equal(untagged.text, 'Prefers node --test over jest');
});

test('a pin is one character, and a kind is one word', () => {
  const pinned = mem.parseNote('+ [2026-10-15] (jarvis) preference: tests use node --test');
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.kind, 'preference');
  assert.equal(pinned.text, 'tests use node --test');
});

test('only a real kind is treated as one', () => {
  // Otherwise the set stops being closed the first time someone writes a
  // sentence with a colon in it.
  const note = mem.parseNote('- [2026-10-15] Note: ring the office before nine');
  assert.equal(note.kind, '', 'an arbitrary word is not a kind');
  assert.equal(note.text, 'Note: ring the office before nine', 'and the text keeps its colon');

  const url = mem.parseNote('- [2026-10-15] (api) see https://example.com/docs for the schema');
  assert.equal(url.kind, '');
  assert.match(url.text, /^see https/);
});

test('what cannot be parsed is not pretended to be a note', () => {
  assert.equal(mem.parseNote('just some text someone typed'), null);
  assert.equal(mem.parseNote(''), null);
  assert.equal(mem.parseNote(null), null);
});

test('a note survives the round trip to text and back', () => {
  for (const note of [
    { pinned: true, date: '2026-10-15', project: 'jarvis', kind: 'preference', text: 'node --test' },
    { pinned: false, date: '2026-10-15', project: '', kind: '', text: 'a plain observation' },
    { pinned: false, date: '2026-10-15', project: 'api', kind: 'location', text: 'config lives in ~/.config' },
  ]) {
    const back = mem.parseNote(mem.formatNote(note));
    assert.equal(back.pinned, note.pinned);
    assert.equal(back.project, note.project);
    assert.equal(back.kind, note.kind);
    assert.equal(back.text, note.text);
  }
});

test('a note can be filed and pinned when it is kept', () => {
  fresh();
  const line = mem.remember('tests are written with node --test', '', { kind: 'preference', pinned: true });
  assert.match(line, /^\+ \[\d{4}-\d{2}-\d{2}\] preference: tests are written with node --test$/);
  const [note] = mem.parseNotes();
  assert.equal(note.pinned, true);
  assert.equal(note.kind, 'preference');
});

test('a kind that is not a kind is simply dropped', () => {
  fresh();
  const line = mem.remember('something', 'alpha', { kind: 'nonsense' });
  assert.match(line, /\(alpha\) something$/, 'the note is kept, the made-up kind is not');
  assert.equal(mem.parseNotes()[0].kind, '');
});

test('learning a fact again can pin it, but never unpin it', () => {
  fresh();
  mem.remember('deploys through Vercel', 'alpha');
  assert.equal(mem.parseNotes().length, 1);

  const pinned = mem.remember('deploys through Vercel', 'alpha', { pinned: true, kind: 'decision' });
  assert.equal(mem.parseNotes().length, 1, 'still one fact, not two');
  assert.equal(mem.parseNotes()[0].pinned, true, 'learning it again with a pin pins it');
  assert.equal(mem.parseNotes()[0].kind, 'decision');
  assert.match(pinned, /^\+ /);

  mem.remember('deploys through Vercel', 'alpha');
  assert.equal(mem.parseNotes()[0].pinned, true, 'mentioning it in passing does not unpin it');
  assert.equal(mem.parseNotes()[0].kind, 'decision', 'nor unfile it');
});

test('the same fact about a different project is a different fact', () => {
  fresh();
  mem.remember('uses pnpm', 'alpha');
  mem.remember('uses pnpm', 'beta');
  assert.equal(mem.parseNotes().length, 2);
});

test('pinned notes are not dropped for age', () => {
  fresh();
  mem.remember('the oldest pinned thing', '', { pinned: true });
  for (let i = 0; i < 250; i++) mem.remember(`ordinary note ${i}`);
  const notes = mem.parseNotes();
  assert.ok(notes.some((n) => n.text === 'the oldest pinned thing'),
    'a note someone asked to keep is kept');
  assert.ok(!notes.some((n) => n.text === 'ordinary note 0'), 'the oldest unpinned one went');
  assert.ok(notes.some((n) => n.text === 'ordinary note 249'), 'the newest is there');
});

test('pinned notes get their own section, ahead of the rest', () => {
  fresh();
  mem.loadIndex({ refresh: true, roots: [path.join(home, 'nothing-here')] });
  mem.remember('an ordinary observation');
  mem.remember('tests use node --test', '', { kind: 'preference', pinned: true });

  const block = mem.memoryBlock();
  const standing = block.indexOf('Standing facts');
  const learned = block.indexOf('What you have learned');
  assert.ok(standing !== -1 && learned !== -1, 'both sections appear');
  assert.ok(standing < learned, 'what is always true comes first');
  assert.ok(block.indexOf('node --test') < learned, 'and the pinned note is in that section');
});

test('a pinned note survives a budget that drops everything else', () => {
  fresh();
  mem.loadIndex({ refresh: true, roots: [path.join(home, 'nothing-here')] });
  mem.remember('the one thing that must always be known', '', { pinned: true });
  for (let i = 0; i < 60; i++) mem.remember(`a chatty note number ${i} with some length to it`);

  const block = mem.memoryBlock({ maxChars: 400 });
  assert.ok(block.includes('must always be known'), 'surviving truncation is what pinning is for');
  assert.ok(!block.includes('a chatty note'), 'while everything ordinary was dropped for it');
});

test('no pinned notes means no pinned section', () => {
  fresh();
  mem.loadIndex({ refresh: true, roots: [path.join(home, 'nothing-here')] });
  mem.remember('just an ordinary note');
  const block = mem.memoryBlock();
  assert.ok(!block.includes('Standing facts'), 'a heading over nothing is worse than no heading');
  assert.ok(block.includes('just an ordinary note'));
});

test('a line this module cannot parse is not destroyed by writing near it', () => {
  fresh();
  mem.remember('a real note');
  const notes = path.join(mem.MEMORY_DIR, 'notes.md');
  fs.appendFileSync(notes, 'a stray line someone typed into the file\n');
  mem.remember('another real note');
  assert.match(fs.readFileSync(notes, 'utf8'), /a stray line someone typed into the file/,
    'notes.md is a file people edit; writing to it must not eat what it finds');
});

test('forgetting still takes pinned and filed notes', () => {
  fresh();
  mem.remember('deploys through Vercel', 'alpha', { pinned: true, kind: 'decision' });
  assert.equal(mem.forget('Vercel'), 1, 'a pin keeps a note from ageing out, not from being dropped');
  assert.deepEqual(mem.parseNotes(), []);
});
