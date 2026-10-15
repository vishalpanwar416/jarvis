// The serve protocol: lines in, lines out.
//
//   node --test test/serve.test.mjs
//
// This is what the Bezelrig bubble talks to, so a mistake here is a desktop
// that stops answering rather than a stack trace anyone sees. None of it
// needs a model: every decision in serve.js is about routing, framing and
// who is allowed to do what, and serve() takes its session, its two streams
// and its exit so all of that can be driven from here.
//
// HOME is moved before the imports, because the memory store reads it when
// it is loaded and the real one is not this test's to touch.
import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-serve-'));
process.env.HOME = home;
after(() => {
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const { serve } = await import('../src/serve.js');
const { DEFAULTS, merge } = await import('../src/config.js');

// A session that does nothing but remember what it was asked and let the
// test play the SDK's part.
class FakeSession extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.sent = [];
    this.sessionId = null;
    this.closed = false;
    this.interrupted = 0;
    FakeSession.made.push(this);
  }
  static made = [];
  start() {
    return this;
  }
  send(text) {
    this.sent.push(text);
  }
  close() {
    this.closed = true;
  }
  interrupt() {
    this.interrupted += 1;
  }
  // The shapes serve.js listens for.
  init(sessionId) {
    this.sessionId = sessionId;
    this.emit('event', { kind: 'init', sessionId });
  }
  reply(text) {
    this.emit('event', { kind: 'delta', text });
  }
  done(patch = {}) {
    this.emit('event', { kind: 'result', isError: false, text: '', durationMs: 10, totals: null, ...patch });
  }
}

// Every harness holds a readline interface on its input, which keeps the
// event loop alive on its own. Closed at the end of the run, or `node --test`
// sits there with all its tests passed and nothing left to do.
const open = [];
after(() => {
  for (const input of open) input.end();
});

// Brings a server up and hands back the levers: what it has written, what to
// write to it, and the sessions it has opened.
function harness({ config = {}, ...options } = {}) {
  FakeSession.made = [];
  const input = new PassThrough();
  open.push(input);
  const lines = [];
  const output = { write: (line) => lines.push(JSON.parse(line)) };
  const exits = [];

  serve({
    config: merge(DEFAULTS, { automations: [], ...config }),
    idleSeconds: 0, // no idle timer: a test should not keep the loop alive
    // Short enough that a request a test leaves unanswered does not hold the
    // run open, long enough that every answered one is answered in time.
    permissionSeconds: 2,
    createSession: (made) => new FakeSession(made),
    input,
    output,
    exit: (code) => exits.push(code),
    ...options,
  });

  const settle = async (turns = 4) => {
    for (let i = 0; i < turns; i += 1) await Promise.resolve();
  };
  return {
    lines,
    exits,
    settle,
    session: () => FakeSession.made.at(-1),
    sessions: () => FakeSession.made,
    say: async (object) => {
      input.write(`${typeof object === 'string' ? object : JSON.stringify(object)}\n`);
      await settle();
    },
    of: (type) => lines.filter((line) => line.type === type),
    last: (type) => lines.filter((line) => line.type === type).at(-1),
    end: () => input.end(),
  };
}

// ── coming up ───────────────────────────────────────────────────────────────

test('it announces itself and opens a session before being asked', async () => {
  const h = harness();
  await h.settle();
  assert.strictEqual(h.lines[0].type, 'ready', 'ready is the first line out');
  assert.strictEqual(h.sessions().length, 1, 'the slow part is paid before the first question');
  assert.strictEqual(h.session().options.config.askFirst, true, 'and it knows it must ask before changing anything');
});

// ── a question and its answer ───────────────────────────────────────────────

test('a typed question reaches the model exactly as asked', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'what time is it' });
  assert.deepStrictEqual(h.session().sent, ['what time is it']);
});

test('the reply streams out under the ask it belongs to', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'q' });
  const session = h.session();
  session.init('sess-1');
  session.reply('half ');
  session.reply('past four');
  session.done();
  await h.settle();

  assert.strictEqual(h.last('init').sessionId, 'sess-1');
  assert.deepStrictEqual(h.of('delta').map((line) => line.text), ['half ', 'past four']);
  assert.ok(h.of('delta').every((line) => line.id === 'a1'), 'every line carries the ask id');
  assert.strictEqual(h.last('result').text, 'half past four', 'the deltas are kept as the answer');
  assert.strictEqual(h.last('result').sessionId, 'sess-1');
});

test('a result with its own text is preferred to the pieces', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'q' });
  h.session().reply('partial');
  h.session().done({ text: 'the whole answer' });
  await h.settle();
  assert.strictEqual(h.last('result').text, 'the whole answer');
});

// ── spoken questions ────────────────────────────────────────────────────────

test('a spoken question is framed as one before it reaches the model', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'how are the tests', voice: true });
  const sent = h.session().sent[0];
  assert.ok(sent.startsWith('[spoken]'), 'the turn is marked as one to be heard');
  assert.ok(sent.endsWith('how are the tests'), 'and the question is carried through intact');
});

test('the answer to a spoken question says it was written to be spoken', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'q', voice: true });
  h.session().done({ text: 'All green, sir.' });
  await h.settle();
  assert.strictEqual(h.last('result').voice, true);
});

test('a typed question carries no voice flag either way', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'q' });
  h.session().done({ text: 'done' });
  await h.settle();
  assert.ok(!('voice' in h.last('result')), 'absent, not false — the caller tests for truth');
});

test('voice is decided per question, not per conversation', async () => {
  const h = harness();
  await h.settle();
  h.session().init('sess-1');
  await h.say({ type: 'ask', id: 'a1', prompt: 'spoken one', voice: true });
  h.session().done({ text: 'x' });
  await h.settle();
  // Carried on, the way the bubble carries a conversation on.
  await h.say({ type: 'ask', id: 'a2', prompt: 'typed one', resume: 'sess-1' });

  assert.strictEqual(h.sessions().length, 1, 'one conversation throughout');
  const [spoken, typed] = h.session().sent;
  assert.ok(spoken.includes('[spoken]'));
  assert.strictEqual(typed, 'typed one', 'the same session, told nothing about speech this time');
});

// ── one at a time ───────────────────────────────────────────────────────────

test('a second question while one is in flight is refused, not queued', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'first' });
  await h.say({ type: 'ask', id: 'a2', prompt: 'second' });
  assert.match(h.last('error').text, /busy/);
  assert.strictEqual(h.last('error').id, 'a2', 'and the refusal names the question it refused');
  assert.deepStrictEqual(h.session().sent, ['first'], 'the second never reached the model');
});

test('the next question is taken once the last one has answered', async () => {
  const h = harness();
  await h.settle();
  h.session().init('sess-1');
  await h.say({ type: 'ask', id: 'a1', prompt: 'first' });
  h.session().done({ text: 'x' });
  await h.settle();
  await h.say({ type: 'ask', id: 'a2', prompt: 'second', resume: 'sess-1' });
  assert.deepStrictEqual(h.session().sent, ['first', 'second']);
  assert.strictEqual(h.of('error').length, 0, 'and not refused as busy');
});

// ── bad input ───────────────────────────────────────────────────────────────

test('an empty prompt is an error rather than a turn', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: '   ' });
  assert.strictEqual(h.last('error').text, 'empty prompt');
  assert.deepStrictEqual(h.session().sent, []);
});

test('a line that is not JSON is ignored, not fatal', async () => {
  const h = harness();
  await h.say('this is not json {');
  await h.say({ type: 'ask', id: 'a1', prompt: 'still here' });
  assert.deepStrictEqual(h.session().sent, ['still here']);
});

test('a message type nobody knows is answered, not dropped', async () => {
  const h = harness();
  await h.say({ type: 'sing', id: 'a1' });
  assert.match(h.last('error').text, /unknown message type sing/);
});

// ── which conversation ──────────────────────────────────────────────────────

test('resuming the open conversation reuses the session it is already in', async () => {
  const h = harness();
  await h.settle();
  h.session().init('sess-1');
  await h.say({ type: 'ask', id: 'a1', prompt: 'q', resume: 'sess-1' });
  assert.strictEqual(h.sessions().length, 1, 'no second session, and no second start-up to pay for');
});

test('resuming a different conversation opens it and lets the old one go', async () => {
  const h = harness();
  await h.settle();
  const first = h.session();
  first.init('sess-1');
  await h.say({ type: 'ask', id: 'a1', prompt: 'q', resume: 'sess-2' });
  assert.strictEqual(h.sessions().length, 2);
  assert.strictEqual(first.closed, true, 'the one it replaced is closed rather than left running');
  assert.strictEqual(h.session().options.resume, 'sess-2');
});

test('a fresh question reuses a session nobody has spoken to', async () => {
  const h = harness();
  await h.settle();
  await h.say({ type: 'ask', id: 'a1', prompt: 'q' });
  assert.strictEqual(h.sessions().length, 1, 'the one opened at start-up had never been used');
});

test('a fresh question after a used one starts a new conversation', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'first' });
  h.session().done({ text: 'x' });
  await h.settle();
  await h.say({ type: 'ask', id: 'a2', prompt: 'second', resume: null });
  assert.strictEqual(h.sessions().length, 2, 'a new question with no thread means a new thread');
});

test('a conversation the CLI has forgotten says so, rather than reporting an error', async () => {
  const h = harness();
  await h.settle();
  // An error result, for a resume, that never initialised: the only shape a
  // lost conversation has.
  await h.say({ type: 'ask', id: 'a1', prompt: 'q', resume: 'gone-1' });
  h.session().done({ isError: true, text: '' });
  await h.settle();
  assert.strictEqual(h.last('result').resumeFailed, true);
  assert.match(h.last('result').text, /no longer available \(gone-1\)/);
});

test('a turn that genuinely fails is not mistaken for a lost conversation', async () => {
  const h = harness();
  await h.settle();
  await h.say({ type: 'ask', id: 'a1', prompt: 'q', resume: 'sess-1' });
  h.session().init('sess-1'); // it did start, so the thread was there
  h.session().done({ isError: true, text: 'the model fell over' });
  await h.settle();
  assert.ok(!h.last('result').resumeFailed, 'the thread was fine; the turn was not');
  assert.strictEqual(h.last('result').text, 'the model fell over');
});

// ── permission ──────────────────────────────────────────────────────────────

const askFor = async (h, tool, input = {}) => {
  const decision = h.session().options.canUseTool(tool, input);
  await h.settle();
  return decision;
};

test('a tool that changes something is put to the other end', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'q' });
  const decision = askFor(h, 'Write', { file_path: '/tmp/x', content: 'hi' });
  await h.settle();

  const request = h.last('permission');
  assert.strictEqual(request.tool, 'Write');
  assert.strictEqual(request.id, 'a1', 'carried on the ask it belongs to');
  assert.ok(request.permitId, 'with an id of its own to answer');

  await h.say({ type: 'permit', permitId: request.permitId, allow: true });
  assert.deepStrictEqual(await decision, { behavior: 'allow' });
});

test('a refusal is a refusal, with a reason the model can read', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'q' });
  const decision = askFor(h, 'Bash', { command: 'rm -rf /' });
  await h.settle();
  await h.say({ type: 'permit', permitId: h.last('permission').permitId, allow: false });
  const answer = await decision;
  assert.strictEqual(answer.behavior, 'deny');
  assert.match(answer.message, /Bash was not permitted/);
});

test('"always" is not asked twice, and is not remembered past this process', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'q' });
  const first = askFor(h, 'Edit', { file_path: '/tmp/x' });
  await h.settle();
  await h.say({ type: 'permit', permitId: h.last('permission').permitId, allow: true, always: true });
  await first;

  const asked = h.of('permission').length;
  assert.deepStrictEqual(await askFor(h, 'Edit', { file_path: '/tmp/y' }), { behavior: 'allow' });
  assert.strictEqual(h.of('permission').length, asked, 'the second edit went through unasked');

  // A second process starts over: nothing here is written down.
  const fresh = harness();
  await fresh.say({ type: 'ask', id: 'b1', prompt: 'q' });
  askFor(fresh, 'Edit', { file_path: '/tmp/z' });
  await fresh.settle();
  assert.strictEqual(fresh.of('permission').length, 1, 'a standing permission belongs in the config');
});

test('reading is allowed without asking anyone', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'q' });
  for (const tool of ['Read', 'Glob', 'Grep']) {
    assert.deepStrictEqual(await askFor(h, tool, {}), { behavior: 'allow' }, tool);
  }
  assert.strictEqual(h.of('permission').length, 0);
});

test('looking at the screen does not stop to ask', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'what is on my screen' });
  assert.deepStrictEqual(await askFor(h, 'mcp__screen__look', { target: 'screen' }), { behavior: 'allow' });
  assert.strictEqual(h.of('permission').length, 0, 'they are already looking at it');
});

test('screen.ask puts the screenshot back behind a prompt', async () => {
  // A screenshot takes in whatever is on screen, so this has to be reversible.
  const h = harness({ config: { screen: { ask: true } } });
  await h.say({ type: 'ask', id: 'a1', prompt: 'what is on my screen' });
  const decision = askFor(h, 'mcp__screen__look', { target: 'screen' });
  await h.settle();
  assert.strictEqual(h.last('permission')?.tool, 'mcp__screen__look', 'asked for');
  await h.say({ type: 'permit', permitId: h.last('permission').permitId, allow: false });
  assert.strictEqual((await decision).behavior, 'deny', 'and refusable');
});

test('the screen tool is gone entirely when it is switched off', async () => {
  const h = harness({ config: { screen: { enabled: false } } });
  await h.settle();
  assert.ok(!('screen' in h.session().options.mcpServers), 'no server, so no tool to call');
});

test('remembering is allowed too: it writes only to its own store', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'q' });
  assert.deepStrictEqual(await askFor(h, 'mcp__memory__remember', { note: 'a thing' }), { behavior: 'allow' });
  assert.strictEqual(h.of('permission').length, 0, 'nobody is asked about Jarvis’ own memory');
});

test('an answer to a request that has already gone is ignored', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'q' });
  await h.say({ type: 'permit', permitId: 'p99', allow: true });
  assert.strictEqual(h.of('error').length, 0, 'a late yes is not an error, it is just too late');
});

// ── what it is doing between words ──────────────────────────────────────────

test('a tool in use is described in words, and its end is marked', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'q' });
  h.session().emit('event', { kind: 'tool-start', name: 'Read', input: { file_path: '/home/me/src/voice.js' } });
  h.session().emit('event', { kind: 'tool-end', isError: false });
  await h.settle();

  const [started, ended] = h.of('activity');
  assert.strictEqual(started.text, 'Reading voice.js', 'the file, not the path, and not the tool name');
  assert.strictEqual(started.done, false);
  assert.strictEqual(ended.done, true);
});

test('a line of thinking goes out once it is a whole line', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'q' });
  h.session().emit('event', { kind: 'thinking-delta', text: 'Checking the ' });
  await h.settle();
  assert.strictEqual(h.of('activity').length, 0, 'half a thought is not shown');

  h.session().emit('event', { kind: 'thinking-delta', text: 'config first\nthen the' });
  await h.settle();
  const line = h.last('activity');
  assert.strictEqual(line.text, 'Checking the config first');
  assert.strictEqual(line.thinking, true, 'marked as a thought, not a tool');
});

test('a thought that never ends is not allowed to grow without limit', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'q' });
  for (let i = 0; i < 10; i += 1) {
    h.session().emit('event', { kind: 'thinking-delta', text: 'x'.repeat(1000) });
  }
  await h.settle();
  assert.strictEqual(h.of('activity').length, 0, 'still nothing to show, and nothing kept either');
});

// ── ending ──────────────────────────────────────────────────────────────────

test('interrupt reaches the session in flight', async () => {
  const h = harness();
  await h.say({ type: 'ask', id: 'a1', prompt: 'q' });
  await h.say({ type: 'interrupt' });
  assert.strictEqual(h.session().interrupted, 1);
});

test('quit says goodbye and then goes', async () => {
  const h = harness();
  await h.say({ type: 'quit' });
  assert.strictEqual(h.last('bye').reason, 'quit');
  assert.strictEqual(h.session().closed, true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepStrictEqual(h.exits, [0]);
});

test('the stream ending counts as hanging up', async () => {
  const h = harness();
  await h.settle();
  h.end();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.strictEqual(h.last('bye').reason, 'quit', 'the other end went away, so so does this one');
});
