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
