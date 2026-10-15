// Slash commands, against a stand-in for the `api` the UI provides.
//
//   node --test test/commands.test.mjs
//
// Commands are the part of this a person types by hand, so the cases worth
// covering are the ones where a typo or a missing word used to do something
// quietly wrong rather than saying so.
import { test } from 'node:test';
import assert from 'node:assert';

import { COMMANDS, runCommand } from '../src/commands.js';

// Records everything a command did, and can be told what the machine can do.
function api({ canSee = true, blocker = null, ...state } = {}) {
  const calls = { notes: [], errors: [], asked: [], picked: [] };
  return {
    calls,
    config: { model: 'claude-opus-5', permissionMode: 'default', automations: [], cwd: '/tmp' },
    session: { totals: {}, sessionId: 'sess-1' },
    voice: {
      speakBlocker: () => null,
      listenBlocker: () => null,
      backends: { recorder: 'arecord', stream: 'jarvis-stt-stream', stt: null },
      vadSettings: () => ({ enabled: true, silenceMs: 850 }),
      canHandsFree: true,
    },
    screen: { canSee, blocker: () => blocker },
    state: { voiceOut: false, awareness: false, autopilot: false, handsFree: false, ...state },
    note: (text) => calls.notes.push(text),
    error: (text) => calls.errors.push(text),
    ask: (text) => calls.asked.push(text),
    pick: (request) => calls.picked.push(request),
    setVoiceOut: () => {},
    setHandsFree: () => {},
    setAwareness: () => {},
    setAutopilot: () => {},
  };
}

// ── /look ───────────────────────────────────────────────────────────────────

test('a bare /look asks what is on the screen', async () => {
  const a = api();
  await runCommand('/look', a);
  assert.strictEqual(a.calls.asked.length, 1);
  const asked = a.calls.asked[0];
  assert.match(asked, /look tool/, 'the model is pointed at the tool');
  assert.match(asked, /my screen/);
  assert.match(asked, /tell me what is on it/, 'with a question to answer about it');
  assert.strictEqual(a.calls.errors.length, 0);
});

test('/look window looks at the window in front', async () => {
  const a = api();
  await runCommand('/look window', a);
  assert.match(a.calls.asked[0], /the window in front/);
  assert.match(a.calls.asked[0], /target "window"/, 'and says so in terms the tool takes');
});

test('words after /look become the question about the screen', async () => {
  const a = api();
  await runCommand('/look what does this error say', a);
  assert.match(a.calls.asked[0], /what does this error say\.$/);
  assert.ok(!/tell me what is on it/.test(a.calls.asked[0]), 'the default question steps aside');
});

test('/look window still takes a question after the target', async () => {
  const a = api();
  await runCommand('/look window is this the right branch', a);
  assert.match(a.calls.asked[0], /the window in front/);
  assert.match(a.calls.asked[0], /is this the right branch\.$/);
});

test('with no way to capture, /look says so instead of asking', async () => {
  const a = api({ canSee: false, blocker: 'nothing on this desktop can capture the screen' });
  await runCommand('/look', a);
  assert.strictEqual(a.calls.asked.length, 0, 'no turn is spent on a question that cannot be answered');
  assert.match(a.calls.errors[0], /cannot see the screen: nothing on this desktop/);
});

// ── the bare-toggle commands ────────────────────────────────────────────────

test('a toggle with a word that is neither on nor off is refused', async () => {
  // Reading anything that is not "on" as off would switch a feature off while
  // looking for all the world like it obeyed you.
  for (const line of ['/voice yes', '/awareness enable', '/autopilot 1', '/listen please']) {
    const a = api();
    await runCommand(line, a);
    assert.strictEqual(a.calls.errors.length, 1, `${line} is an error`);
    assert.match(a.calls.errors[0], /usage/, `${line} says what it wanted`);
  }
});

test('on and off mean what they say', async () => {
  const seen = [];
  const a = api();
  a.setAwareness = (next) => seen.push(next);
  await runCommand('/awareness on', a);
  await runCommand('/awareness off', a);
  assert.deepStrictEqual(seen, [true, false]);
  assert.strictEqual(a.calls.errors.length, 0);
});

test('a bare toggle flips whatever it is now', async () => {
  const seen = [];
  const a = api({ awareness: true });
  a.setAwareness = (next) => seen.push(next);
  await runCommand('/awareness', a);
  assert.deepStrictEqual(seen, [false]);
});

// ── the rest ────────────────────────────────────────────────────────────────

test('an unknown command points at /help rather than failing silently', async () => {
  const a = api();
  await runCommand('/looks', a);
  assert.match(a.calls.errors[0], /unknown command \/looks/);
});

test('/help lists every command, and every command says what it is for', () => {
  const a = api();
  COMMANDS.help.run([], a);
  for (const name of Object.keys(COMMANDS)) {
    assert.ok(a.calls.notes[0].includes(`/${name}`), `/${name} is in the list`);
    assert.ok(COMMANDS[name].help?.length > 0, `/${name} has help text`);
  }
});

test('a command that throws is reported, not left to take the UI down', async () => {
  const a = api();
  a.note = () => {
    throw new Error('the screen is on fire');
  };
  await runCommand('/session', a);
  assert.match(a.calls.errors[0], /the screen is on fire/);
});
