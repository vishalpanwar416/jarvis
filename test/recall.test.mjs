// Lexical recall, against a temp HOME with a small world in it.
//
//   node --test test/recall.test.mjs
//
// recall.js reads through memory.js and ledger.js, both of which resolve
// their paths from os.homedir() when imported — so HOME is set first.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-recall-'));
process.env.HOME = home;
const { tokenize, corpus, search, recallBlock } = await import('../src/recall.js');
const memory = await import('../src/memory.js');
const ledger = await import('../src/ledger.js');
const { framePrompt } = await import('../src/persona.js');

const alpha = path.join(home, 'Development', 'alpha');
const beta = path.join(home, 'Development', 'beta');

before(() => {
  for (const [dir, description] of [[alpha, 'The alpha payments service'], [beta, 'The beta scheduler']]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir), description }));
  }
  memory.loadIndex({ refresh: true });
});
beforeEach(() => {
  fs.rmSync(path.join(memory.MEMORY_DIR, 'notes.md'), { force: true });
  fs.rmSync(ledger.LEDGER_DIR, { recursive: true, force: true });
});
after(() => {
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const config = (cwd = alpha, patch = {}) => ({
  cwd,
  ledger: { enabled: true, keepDays: 30 },
  recall: { enabled: true, limit: 5, maxChars: 600, days: 30, ...patch },
});
const lines = (block) => (block.match(/^[-+] .*/gm) ?? []);

test('words are lowercased, and the ones that mean nothing are dropped', () => {
  assert.deepEqual(tokenize('What is THE Deploy'), ['deploy'],
    'what, is and the match everything and so distinguish nothing');
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});

test('a path and a camelCase name both come apart', () => {
  assert.deepEqual(tokenize('src/voice.js'), ['src', 'voice', 'js']);
  // The whole word is kept as well, so an exact query still scores highest.
  assert.deepEqual(tokenize('memoryBlock'), ['memoryblock', 'memory', 'block']);
});

test('everything known is searchable', () => {
  memory.remember('deploys through Vercel', 'alpha');
  ledger.append({ kind: 'ask', text: 'why is the scheduler slow', project: 'beta' });
  const docs = corpus(config());
  const sources = new Set(docs.map((doc) => doc.source));
  assert.ok(sources.has('note') && sources.has('ledger') && sources.has('project'),
    'notes, the record of work, and where projects are');
});

test('a pinned note is not retrieved, because it is already in front of you', () => {
  memory.remember('tests use node --test', '', { pinned: true });
  memory.remember('builds with esbuild', '');
  const docs = corpus(config());
  assert.ok(!docs.some((doc) => doc.text.includes('node --test')), 'retrieving it would say it twice');
  assert.ok(docs.some((doc) => doc.text.includes('esbuild')));
});

test('a note is found by the words in it', () => {
  memory.remember('production deploys go out through Vercel', 'alpha');
  const [hit] = search('how does deployment to vercel work', { config: config() });
  assert.equal(hit.source, 'note');
  assert.match(hit.line, /Vercel/);
});

test('work done before is found the same way', () => {
  ledger.append({ kind: 'edit', file: 'src/scheduler.js', project: 'beta' });
  ledger.append({ kind: 'run', command: 'npm run migrate', project: 'beta', failed: true });
  const hits = search('the scheduler migration', { config: config() });
  assert.ok(hits.length, 'the ledger is part of what is known');
  assert.ok(hits.some((hit) => hit.line.includes('scheduler')));
});

test('a failed command is reported as one', () => {
  ledger.append({ kind: 'run', command: 'npm run migrate', project: 'alpha', failed: true });
  const [hit] = search('migrate', { config: config() });
  assert.match(hit.line, /failed/, 'that it did not work is the useful half');
});

test('where you are standing decides a tie', () => {
  ledger.append({ kind: 'ask', text: 'the caching question', project: 'alpha' });
  ledger.append({ kind: 'ask', text: 'the caching question', project: 'beta' });
  const [first] = search('caching question', { config: config(beta) });
  assert.equal(first.project, 'beta', 'the project you are in is the likelier one to mean');
});

test('recent beats old when the words are equal', () => {
  const old = new Date(Date.now() - 300 * 24 * 60 * 60 * 1000).toISOString();
  ledger.append({ kind: 'ask', text: 'the indexing question', project: 'alpha', at: old });
  ledger.append({ kind: 'ask', text: 'the indexing question again', project: 'alpha' });
  const [first] = search('indexing question', { config: config() });
  assert.match(first.line, /again/);
});

test('matching one common word out of three is not a match', () => {
  memory.remember('the alpha service is written in Go', 'alpha');
  // "service" is shared; "kubernetes" and "ingress" are nowhere.
  assert.deepEqual(search('kubernetes ingress service', { config: config() }), [],
    'a document that accounts for a sliver of the question has answered none of it');
});

test('a question about nothing known returns nothing', () => {
  memory.remember('deploys through Vercel', 'alpha');
  assert.deepEqual(search('what colour is the sky', { config: config() }), []);
});

test('the question is not handed back as its own answer', () => {
  ledger.append({ kind: 'ask', text: 'fix the scheduler', project: 'alpha' });
  const hits = search('fix the scheduler', { config: config() });
  assert.ok(!hits.some((hit) => hit.line.includes('asked "fix the scheduler"')),
    'being told you asked this yesterday answers nothing');
});

test('the same line twice is one hit', () => {
  // Enough other history that a command repeated four times is still a
  // small share of it — which is the situation where this matters at all.
  for (let i = 0; i < 16; i++) ledger.append({ kind: 'ask', text: `some other thing ${i}`, project: 'alpha' });
  for (let i = 0; i < 4; i++) ledger.append({ kind: 'run', command: 'npm run build', project: 'alpha' });
  const hits = search('npm run build', { config: config() });
  const built = hits.filter((hit) => hit.line.includes('npm run build'));
  assert.equal(built.length, 1, 'four identical lines are one thing that happened');
});

test('no more hits than were asked for', () => {
  for (let i = 0; i < 20; i++) {
    ledger.append({ kind: 'ask', text: `a question about scheduling number ${i}`, project: 'alpha' });
  }
  assert.ok(search('scheduling', { config: config(), limit: 3 }).length <= 3);
});

// ---- the block that rides with a question ----

test('an acknowledgement is not a question', () => {
  memory.remember('the alpha service deploys on Friday', 'alpha');
  for (const ack of ['go ahead', 'continue', 'ok thanks', 'yes please', 'do it', 'carry on', 'nice']) {
    assert.equal(recallBlock(ack, config()), '', `"${ack}" refers to the turn before it`);
  }
});

test('but a real question that opens with one is still a question', () => {
  memory.remember('production deploys go out through Vercel', 'alpha');
  assert.notEqual(recallBlock('go and check the vercel deployment', config()), '',
    'the list is anchored to the whole message, not its first word');
});

test('one content word is a perfectly good question', () => {
  memory.remember('deploys through Vercel', 'alpha');
  // "who is aanshika" is one content word after the stop list has had it,
  // and refusing to look that up to guard against noise would be trading a
  // real answer for a problem the scoring already handles.
  assert.notEqual(recallBlock('vercel', config()), '');
});

test('a word that names nothing still comes back quiet', () => {
  memory.remember('deploys through Vercel', 'alpha');
  assert.equal(recallBlock('hmm', config()), '', 'nothing matches it, so there is nothing to say');
  assert.equal(recallBlock('', config()), '');
});

test('the block names what it found and says it may be wrong', () => {
  memory.remember('production deploys go out through Vercel', 'alpha');
  const block = recallBlock('how does the vercel deployment happen', config());
  assert.match(block, /^\[recalled\]/, 'marked the way the other per-turn prefixes are');
  assert.match(block, /ignore the rest/, 'retrieval is a guess and should be presented as one');
  assert.equal(lines(block).length, 1);
});

test('a note is not given a second bullet', () => {
  memory.remember('production deploys go out through Vercel', 'alpha');
  const block = recallBlock('how does the vercel deployment happen', config());
  assert.ok(!block.includes('- - ['), 'the note already carries the character that says it is unpinned');
});

test('the block stays inside its budget', () => {
  for (let i = 0; i < 30; i++) {
    ledger.append({ kind: 'ask', text: `a long question about the scheduler and its timing, number ${i}`, project: 'alpha' });
  }
  const block = recallBlock('the scheduler timing question', config(alpha, { maxChars: 200, limit: 20 }));
  assert.ok(block.length < 500, `block was ${block.length} chars — it rides on every turn`);
  assert.ok(lines(block).length < 5, 'the budget cut it short rather than the limit');
});

test('switched off, it says nothing', () => {
  memory.remember('production deploys go out through Vercel', 'alpha');
  assert.equal(recallBlock('how does the vercel deployment happen', config(alpha, { enabled: false })), '');
  assert.equal(recallBlock('how does the vercel deployment happen', { ...config(), memory: false }), '');
});

test('a question with nothing behind it adds nothing to the turn', () => {
  const text = 'what colour is the sky today';
  assert.equal(framePrompt(text, { config: config() }), text);
});

test('recall reaches the model through the turn, not the system prompt', () => {
  memory.remember('production deploys go out through Vercel', 'alpha');
  const text = 'how does the vercel deployment happen';
  const framed = framePrompt(text, { config: config() });
  assert.match(framed, /^\[recalled\]/);
  assert.ok(framed.endsWith(text), 'the question stays last, closest to the answer');
});

test('without a config there is nothing to search and nothing is added', () => {
  memory.remember('production deploys go out through Vercel', 'alpha');
  const text = 'how does the vercel deployment happen';
  assert.equal(framePrompt(text), text);
  assert.equal(framePrompt(text, { voice: false, autopilot: false }), text);
});
