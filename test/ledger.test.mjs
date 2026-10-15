// The ledger, against a temp HOME so the real record is never touched.
//
//   node --test test/ledger.test.mjs
//
// ledger.js resolves its directory from os.homedir() at import time, so HOME
// is set before the import — same reason as test/memory.test.mjs.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ledger-'));
process.env.HOME = home;
const ledger = await import('../src/ledger.js');

const project = path.join(home, 'Development', 'alpha');
const other = path.join(home, 'Development', 'beta');
before(() => {
  for (const dir of [project, other]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir) }));
  }
});
beforeEach(() => {
  fs.rmSync(ledger.LEDGER_DIR, { recursive: true, force: true });
});
after(() => {
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const config = (patch = {}) => ({ cwd: project, ledger: { enabled: true, ...patch } });

// Drives a fake session through a turn. The real JarvisSession emits exactly
// these shapes (see src/agent.js); nothing here touches the SDK.
function run(events, conf = config()) {
  const session = new EventEmitter();
  ledger.attachLedger(session, conf);
  for (const event of events) session.emit('event', event);
  return ledger.readEntries({ days: 1 });
}

test('secrets never reach the record', () => {
  const r = ledger.redactCommand;
  assert.ok(!r('gh auth login --token ghp_abcdefghijklmnopqrstuvwxyz0123').includes('ghp_abc'));
  assert.match(r('echo ghp_abcdefghijklmnopqrstuvwxyz0123'), /gh_<redacted>/, 'a bare token too');
  assert.match(r('curl -H "Authorization: Bearer abc123xyz" https://api'), /Authorization: <redacted>/);
  assert.match(r('ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop0123 node x.js'), /ANTHROPIC_API_KEY=<redacted>/);
  assert.match(r('psql --password hunter2'), /--password <redacted>/);
  assert.match(r('aws configure set x AKIAIOSFODNN7EXAMPLE'), /AKIA<redacted>/);
  assert.equal(r('git status --porcelain'), 'git status --porcelain', 'an ordinary command is untouched');
  assert.equal(r(null), '', 'and nothing is nothing');
});

test('the shape of a command survives its redaction', () => {
  // The point of keeping the log is being able to see what was tried.
  const out = ledger.redactCommand('deploy --env prod --token ghp_abcdefghijklmnopqrstuvwxyz0123');
  assert.match(out, /deploy --env prod/, 'the useful half stays');
  assert.ok(!out.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'), 'the dangerous half goes');
});

test('paths are recorded the way a person says them', () => {
  assert.equal(ledger.tidyPath(path.join(project, 'src/voice.js'), project), 'src/voice.js');
  assert.equal(ledger.tidyPath(path.join(home, 'Downloads/x.zip')), '~/Downloads/x.zip');
  assert.equal(ledger.tidyPath('/etc/hosts', project), '/etc/hosts', 'outside home, as it is');
  assert.equal(ledger.tidyPath(''), '', 'and nothing is nothing');
});

test('a turn is written down as it happens', () => {
  const entries = run([
    { kind: 'init', sessionId: 's1', model: 'claude-opus-5' },
    { kind: 'submitted', text: 'fix the voice tests' },
    { kind: 'tool-start', id: 't1', name: 'Edit', input: { file_path: path.join(project, 'src/voice.js') } },
    { kind: 'tool-end', id: 't1', isError: false },
    { kind: 'tool-start', id: 't2', name: 'Bash', input: { command: 'npm test' } },
    { kind: 'tool-end', id: 't2', isError: false },
    { kind: 'result', text: 'Fixed. 111 tests pass.', isError: false },
  ]);
  assert.deepEqual(entries.map((e) => e.kind), ['session', 'ask', 'edit', 'run', 'answer']);
  assert.equal(entries[1].text, 'fix the voice tests');
  assert.equal(entries[2].file, 'src/voice.js', 'relative to the project it is in');
  assert.equal(entries[3].command, 'npm test');
  assert.equal(entries[4].text, 'Fixed. 111 tests pass.');
  assert.ok(entries.every((e) => e.project === 'alpha'), 'every line knows where it happened');
  assert.ok(entries.every((e) => Date.parse(e.at)), 'and when');
});

test('a session announced twice is written down once', () => {
  // The SDK re-announces itself during a long conversation, same id each
  // time; a line per announcement would bury the work in session rows.
  const entries = run([
    { kind: 'init', sessionId: 's1', model: 'claude-opus-5' },
    { kind: 'submitted', text: 'first question' },
    { kind: 'init', sessionId: 's1', model: 'claude-opus-5' },
    { kind: 'submitted', text: 'second question' },
  ]);
  assert.equal(entries.filter((e) => e.kind === 'session').length, 1);
  assert.equal(entries.filter((e) => e.kind === 'ask').length, 2, 'the questions are all still there');
});

test('a genuinely new session is a new line', () => {
  const entries = run([
    { kind: 'init', sessionId: 's1' },
    { kind: 'init', sessionId: 's2' },
  ]);
  assert.deepEqual(entries.map((e) => e.sessionId), ['s1', 's2']);
});

test('a tool that failed is not recorded as work done', () => {
  const [edit] = run([
    { kind: 'tool-start', id: 't1', name: 'Write', input: { file_path: path.join(project, 'a.js') } },
    { kind: 'tool-end', id: 't1', isError: true },
  ]);
  assert.equal(edit.kind, 'edit');
  assert.equal(edit.failed, true, 'an edit that errored changed nothing');
});

test('a tool with no result still gets written when the turn ends', () => {
  // An interrupted command did run; we just never heard how it went.
  const entries = run([
    { kind: 'tool-start', id: 't1', name: 'Bash', input: { command: 'sleep 60' } },
    { kind: 'result', text: 'interrupted' },
  ]);
  const run1 = entries.find((e) => e.kind === 'run');
  assert.equal(run1.command, 'sleep 60');
  assert.equal(run1.failed, undefined, 'unknown is not the same as failed');
});

// ---- where the work was, when the working directory does not say ----
//
// Run from a home directory — which is where it mostly is run from —
// there is no project in the path. What the turn touches says instead.

// Home itself is no project, so nothing can be read off the path.
const adrift = (patch = {}) => ({ cwd: home, ledger: { enabled: true, ...patch } });
const inside = (dir, rel) => path.join(dir, rel);

test('a turn is tagged with the project it turned out to touch', () => {
  const entries = run([
    { kind: 'submitted', text: 'fix the alpha tests' },
    { kind: 'tool-start', id: 't1', name: 'Edit', input: { file_path: inside(project, 'src/a.js') } },
    { kind: 'tool-end', id: 't1', isError: false },
    { kind: 'result', text: 'Fixed.' },
  ], adrift());
  assert.ok(entries.length >= 3);
  assert.ok(entries.every((e) => e.project === 'alpha'),
    'the question included, which is the entry most worth having tagged');
  assert.equal(entries.find((e) => e.kind === 'edit').file, 'src/a.js', 'relative to the project it found');
});

test('a file merely read says as much as one written', () => {
  const entries = run([
    { kind: 'submitted', text: 'what does this do' },
    // A Read is never recorded, but it still names the project.
    { kind: 'tool-start', id: 't1', name: 'Read', input: { file_path: inside(other, 'main.js') } },
    { kind: 'tool-end', id: 't1', isError: false },
    { kind: 'result', text: 'It schedules things.' },
  ], adrift());
  assert.ok(entries.every((e) => e.project === 'beta'));
  assert.ok(!entries.some((e) => e.kind === 'edit'), 'and is still not recorded as work');
});

test('a turn that touches nothing is tagged with nothing', () => {
  const entries = run([
    { kind: 'submitted', text: 'what is the time' },
    { kind: 'result', text: 'Half past four.' },
  ], adrift());
  assert.ok(entries.length);
  assert.ok(entries.every((e) => e.project === ''), 'rather than being guessed at');
});

test('the next turn can be about somewhere else', () => {
  const session = new EventEmitter();
  ledger.attachLedger(session, adrift());
  const emit = (...events) => { for (const e of events) session.emit('event', e); };

  emit({ kind: 'submitted', text: 'first' },
       { kind: 'tool-start', id: 'a', name: 'Edit', input: { file_path: inside(project, 'x.js') } },
       { kind: 'tool-end', id: 'a', isError: false },
       { kind: 'result', text: 'done' });
  emit({ kind: 'submitted', text: 'second' },
       { kind: 'tool-start', id: 'b', name: 'Edit', input: { file_path: inside(other, 'y.js') } },
       { kind: 'tool-end', id: 'b', isError: false },
       { kind: 'result', text: 'done' });

  const asks = ledger.readEntries({ days: 1 }).filter((e) => e.kind === 'ask');
  assert.deepEqual(asks.map((e) => [e.text, e.project]), [['first', 'alpha'], ['second', 'beta']]);
});

test('a turn that touches nothing stays with the last one that did', () => {
  const session = new EventEmitter();
  ledger.attachLedger(session, adrift());
  const emit = (...events) => { for (const e of events) session.emit('event', e); };

  emit({ kind: 'submitted', text: 'first' },
       { kind: 'tool-start', id: 'a', name: 'Edit', input: { file_path: inside(project, 'x.js') } },
       { kind: 'tool-end', id: 'a', isError: false },
       { kind: 'result', text: 'done' });
  emit({ kind: 'submitted', text: 'and why is that' }, { kind: 'result', text: 'because' });

  const asks = ledger.readEntries({ days: 1 }).filter((e) => e.kind === 'ask');
  assert.deepEqual(asks.map((e) => e.project), ['alpha', 'alpha'],
    'a follow-up is about whatever the turn before it was about');
});

test('nothing is written until the turn says what it was about', () => {
  const session = new EventEmitter();
  ledger.attachLedger(session, adrift());
  session.emit('event', { kind: 'submitted', text: 'fix the alpha tests' });
  assert.deepEqual(ledger.readEntries({ days: 1 }), [],
    'writing it immediately would mean writing it untagged');
  session.emit('event', { kind: 'result', text: 'done' });
  assert.ok(ledger.readEntries({ days: 1 }).length, 'and then it lands');
});

test('an unfinished turn is still written when the session closes', () => {
  const entries = run([
    { kind: 'submitted', text: 'start something long' },
    { kind: 'tool-start', id: 't1', name: 'Bash', input: { command: 'sleep 60' } },
    { kind: 'closed' },
  ], adrift());
  assert.ok(entries.some((e) => e.kind === 'ask'), 'an interrupted turn is not a lost one');
});

test('a working directory inside a project still settles it outright', () => {
  const entries = run([
    { kind: 'submitted', text: 'look at the other one' },
    // Touching beta from inside alpha does not move the work to beta.
    { kind: 'tool-start', id: 't1', name: 'Read', input: { file_path: inside(other, 'main.js') } },
    { kind: 'tool-end', id: 't1', isError: false },
  ], config());
  assert.ok(entries.every((e) => e.project === 'alpha'), 'cwd was chosen deliberately and cannot be wrong');
  assert.ok(entries.length, 'and is written as it happens, not held back');
});

test('reads and writes are beneath notice', () => {
  const entries = run([
    { kind: 'tool-start', id: 't1', name: 'Read', input: { file_path: path.join(project, 'a.js') } },
    { kind: 'tool-end', id: 't1', isError: false },
    { kind: 'tool-start', id: 't2', name: 'Grep', input: { pattern: 'x' } },
    { kind: 'tool-end', id: 't2', isError: false },
  ]);
  assert.deepEqual(entries, [], 'a Read is not work, it is how work gets done');
});

test('the turn framing is not mistaken for the question', () => {
  // framePrompt prepends [spoken]/[autopilot] guidance to the message.
  const [ask] = run([
    { kind: 'submitted', text: '[spoken] Write it to be heard once.\n\nwhat is on my screen' },
  ]);
  assert.equal(ask.text, 'what is on my screen');
});

test('a command is redacted on its way in, not on its way out', () => {
  const [entry] = run([
    { kind: 'tool-start', id: 't1', name: 'Bash', input: { command: 'deploy --token ghp_abcdefghijklmnopqrstuvwxyz0123' } },
    { kind: 'tool-end', id: 't1', isError: false },
  ]);
  const raw = fs.readFileSync(ledger.ledgerPath(), 'utf8');
  assert.ok(!raw.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'), 'the secret never touches the disk');
  assert.match(entry.command, /^deploy --token <redacted>$/);
});

test('switched off, it writes nothing at all', () => {
  const entries = run([
    { kind: 'init', sessionId: 's1' },
    { kind: 'submitted', text: 'anything' },
  ], config({ enabled: false }));
  assert.deepEqual(entries, []);
  assert.ok(!fs.existsSync(ledger.ledgerPath()), 'not even a file');
});

test('detaching stops the recording', () => {
  const session = new EventEmitter();
  const detach = ledger.attachLedger(session, config());
  session.emit('event', { kind: 'submitted', text: 'before' });
  detach();
  session.emit('event', { kind: 'submitted', text: 'after' });
  const asks = ledger.readEntries({ days: 1 }).filter((e) => e.kind === 'ask');
  assert.deepEqual(asks.map((e) => e.text), ['before']);
});

test('long entries are cut to their budget', () => {
  const [ask] = run([{ kind: 'submitted', text: 'x'.repeat(500) }], config({ maxEntryChars: 50 }));
  assert.equal(ask.text.length, 50);
});

test('what a stretch of work adds up to', () => {
  const d = ledger.digest([
    { kind: 'ask', text: 'first question' },
    { kind: 'edit', file: 'a.js' },
    { kind: 'edit', file: 'b.js' },
    { kind: 'edit', file: 'a.js' },
    { kind: 'run', command: 'npm test' },
    { kind: 'run', command: 'npm test', failed: true },
    { kind: 'ask', text: 'second question' },
  ]);
  assert.equal(d.edits, 3);
  assert.equal(d.commands, 2);
  assert.equal(d.failed, 1);
  assert.equal(d.lastAsk, 'second question', 'the last one asked, not the first');
  assert.deepEqual(d.files, ['a.js', 'b.js'], 'each file once, most recently touched first');
});

test('a digest of nothing is empty rather than broken', () => {
  const d = ledger.digest([]);
  assert.equal(d.edits, 0);
  assert.equal(d.lastAsk, '');
  assert.deepEqual(d.files, []);
});

test('entries come back oldest first, filtered by project', () => {
  ledger.append({ kind: 'ask', text: 'one', project: 'alpha' });
  ledger.append({ kind: 'ask', text: 'two', project: 'beta' });
  ledger.append({ kind: 'ask', text: 'three', project: 'alpha' });
  const mine = ledger.readEntries({ days: 1, project: 'alpha' });
  assert.deepEqual(mine.map((e) => e.text), ['one', 'three'], 'in the order they happened');
  assert.equal(ledger.readEntries({ days: 1 }).length, 3, 'and unfiltered means all of them');
});

test('a half-written line does not take the rest down with it', () => {
  ledger.append({ kind: 'ask', text: 'good' });
  fs.appendFileSync(ledger.ledgerPath(), '{"kind":"ask","text":"trunc\n');
  ledger.append({ kind: 'ask', text: 'also good' });
  const texts = ledger.readEntries({ days: 1 }).map((e) => e.text);
  assert.deepEqual(texts, ['good', 'also good']);
});

test('forgetting reaches every day still kept', () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  fs.mkdirSync(ledger.LEDGER_DIR, { recursive: true });
  fs.writeFileSync(ledger.ledgerPath(yesterday),
    '{"kind":"run","command":"deploy to acme staging"}\n{"kind":"run","command":"npm test"}\n');
  ledger.append({ kind: 'ask', text: 'how does acme deploy' });
  ledger.append({ kind: 'ask', text: 'unrelated question' });

  assert.equal(ledger.forgetEntries('acme'), 2, 'today and yesterday both');
  const left = ledger.readEntries({ days: 2 }).map((e) => e.command ?? e.text);
  assert.deepEqual(left, ['npm test', 'unrelated question']);
});

test('a day with nothing left is not left behind', () => {
  ledger.append({ kind: 'ask', text: 'the only thing here' });
  assert.equal(ledger.forgetEntries('only thing'), 1);
  assert.ok(!fs.existsSync(ledger.ledgerPath()), 'an empty day file is not a day');
});

test('forgetting nothing in particular forgets nothing', () => {
  ledger.append({ kind: 'ask', text: 'keep me' });
  assert.equal(ledger.forgetEntries(''), 0, 'an empty match must not empty the store');
  assert.equal(ledger.forgetEntries('  '), 0);
  assert.equal(ledger.forgetEntries('no such text'), 0);
  assert.equal(ledger.readEntries({ days: 1 }).length, 1);
});

test('old days are deleted and recent ones are not', () => {
  const dayFile = (back) => {
    const date = new Date(Date.now() - back * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    fs.mkdirSync(ledger.LEDGER_DIR, { recursive: true });
    fs.writeFileSync(ledger.ledgerPath(date), '{"kind":"ask","text":"x"}\n');
    return ledger.ledgerPath(date);
  };
  const old = dayFile(40);
  const recent = dayFile(2);
  assert.equal(ledger.prune(30), 1);
  assert.ok(!fs.existsSync(old), 'past the horizon, gone');
  assert.ok(fs.existsSync(recent), 'inside it, kept');
});

test('pruning an empty store is not an error', () => {
  assert.equal(ledger.prune(30), 0);
});
