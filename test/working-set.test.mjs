// The opening "where are we" block, against a temp HOME and a real git repo.
//
//   node --test test/working-set.test.mjs
//
// Both working-set.js and the modules it reads resolve their paths from
// os.homedir() at import time, so HOME is set before the import.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ws-'));
process.env.HOME = home;
const { workingSetBlock, gitFacts } = await import('../src/working-set.js');
const ledger = await import('../src/ledger.js');
const memory = await import('../src/memory.js');

const alpha = path.join(home, 'Development', 'alpha');
const plain = path.join(home, 'Development', 'plain');
const loose = path.join(home, 'notes');

const git = (args, cwd) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
  env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' },
});

before(() => {
  fs.mkdirSync(path.join(alpha, 'src'), { recursive: true });
  fs.writeFileSync(path.join(alpha, 'package.json'),
    JSON.stringify({ name: 'alpha', description: 'The alpha service' }));
  git(['init', '-q', '-b', 'main'], alpha);
  git(['add', '.'], alpha);
  git(['commit', '-q', '-m', 'Initial commit of the alpha service'], alpha);
  // One uncommitted change, so the block has something to report.
  fs.writeFileSync(path.join(alpha, 'src', 'voice.js'), '// work in progress\n');

  // A project with no git at all, and a directory that is no project.
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, 'package.json'), JSON.stringify({ name: 'plain' }));
  fs.mkdirSync(loose, { recursive: true });

  memory.loadIndex({ refresh: true });
});
beforeEach(() => {
  fs.rmSync(ledger.LEDGER_DIR, { recursive: true, force: true });
});
after(() => {
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const config = (cwd, patch = {}) => ({ cwd, ledger: { enabled: true, recentDays: 5, ...patch } });

test('says which project the conversation is in, and what it is', () => {
  const block = workingSetBlock(config(alpha));
  assert.match(block, /in alpha — ~\/Development\/alpha — The alpha service/);
});

test('reads the repo rather than guessing at it', () => {
  const block = workingSetBlock(config(alpha));
  assert.match(block, /git: main · 1 uncommitted/);
  assert.match(block, /last commit "Initial commit of the alpha service"/);
});

test('a project with no repo simply says less', () => {
  const block = workingSetBlock(config(plain));
  assert.match(block, /in plain/);
  assert.ok(!block.includes('git:'), 'and does not invent a branch');
  assert.equal(gitFacts(plain), null);
});

test('a subdirectory is reported as the project plus where in it', () => {
  const block = workingSetBlock(config(path.join(alpha, 'src')));
  assert.match(block, /in alpha/, 'the project, not the subdirectory');
  assert.match(block, /working inside src/);
});

test('it reports what was done here, and what was last asked', () => {
  ledger.append({ kind: 'ask', text: 'fix the voice tests', project: 'alpha' });
  ledger.append({ kind: 'edit', file: 'src/voice.js', project: 'alpha' });
  ledger.append({ kind: 'edit', file: 'src/serve.js', project: 'alpha' });
  ledger.append({ kind: 'run', command: 'npm test', project: 'alpha', failed: true });
  ledger.append({ kind: 'ask', text: 'now commit it', project: 'alpha' });

  const block = workingSetBlock(config(alpha));
  assert.match(block, /2 file edits, 1 command \(1 failed\)/);
  assert.match(block, /last touched src\/serve\.js, src\/voice\.js/, 'most recent first');
  assert.match(block, /last asked here: "now commit it"/);
});

test('work done elsewhere today is named but not described', () => {
  ledger.append({ kind: 'ask', text: 'something', project: 'alpha' });
  ledger.append({ kind: 'ask', text: 'elsewhere entirely', project: 'bezelrig' });
  const block = workingSetBlock(config(alpha));
  assert.match(block, /also worked in today: bezelrig/);
  assert.ok(!block.includes('elsewhere entirely'), 'the name is the orientation; the rest is a question');
});

test('another project\'s work is never reported as this one\'s', () => {
  ledger.append({ kind: 'ask', text: 'a question about bezelrig', project: 'bezelrig' });
  ledger.append({ kind: 'edit', file: 'main.py', project: 'bezelrig' });
  const block = workingSetBlock(config(alpha));
  assert.ok(!block.includes('last asked here'), 'nothing was asked here');
  assert.ok(!block.includes('main.py'), 'and nothing was edited here');
});

test('outside a project it does not claim to be in one', () => {
  ledger.append({ kind: 'ask', text: 'a question', project: 'alpha' });
  const block = workingSetBlock(config(loose));
  assert.match(block, /in ~\/notes, which is not inside a project/);
  assert.ok(!block.includes('last asked here'), 'an unscoped "here" would be a lie');
});

test('with nothing to say it says nothing', () => {
  const block = workingSetBlock(config(loose));
  assert.equal(block, '', 'a heading over one derived line is not worth the prompt');
});

test('switched off, only the derived half remains', () => {
  ledger.append({ kind: 'ask', text: 'fix the tests', project: 'alpha' });
  const block = workingSetBlock(config(alpha, { enabled: false }));
  assert.match(block, /in alpha/);
  assert.match(block, /git: main/);
  assert.ok(!block.includes('last asked here'), 'the record is not read when it is not kept');
});

test('it stays inside its budget', () => {
  for (let i = 0; i < 50; i++) ledger.append({ kind: 'edit', file: `src/file-${i}.js`, project: 'alpha' });
  ledger.append({ kind: 'ask', text: 'q'.repeat(400), project: 'alpha' });
  const block = workingSetBlock(config(alpha), { maxChars: 300 });
  assert.ok(block.length <= 300, `block was ${block.length} chars — it goes into every prompt`);
});

test('the block says it is derived, so it is believed over stale notes', () => {
  const block = workingSetBlock(config(alpha));
  assert.match(block, /derived, not remembered/);
});
