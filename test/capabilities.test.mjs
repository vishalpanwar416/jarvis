// What Jarvis says it can do on the machine it is running on.
//
//   node --test test/capabilities.test.mjs
//
// Every case names its engines explicitly. Both detectBackends return a
// named engine without probing PATH — only 'auto' goes looking — so these
// assertions are about the logic rather than about this particular host.
import { test } from 'node:test';
import assert from 'node:assert';
import { capabilities, capabilityBlock } from '../src/capabilities.js';
import { DEFAULTS, merge } from '../src/config.js';
import { buildPersona } from '../src/persona.js';

// A machine that can do everything, as the baseline to take things away from.
const able = {
  screen: { enabled: true, engine: 'grim', shrinker: 'magick' },
  voice: {
    tts: { engine: 'piper' },
    stt: { engine: 'whisper', streaming: false },
    recorder: { engine: 'arecord' },
  },
};
const cfg = (patch = {}) => merge(merge(DEFAULTS, able), patch);

test('it reports the backend it would actually use', () => {
  const { sight, speech, dictation } = capabilities(cfg());
  assert.equal(sight.how, 'grim');
  assert.equal(sight.blocker, null);
  assert.equal(speech.how, 'piper');
  assert.equal(dictation.how, 'arecord');
});

test('switched off is not the same as impossible', () => {
  // One of the two is a setting they can change, and saying which is the
  // difference between a dead end and a one-line fix.
  const off = capabilities(cfg({ screen: { enabled: false } }));
  assert.equal(off.sight.how, null);
  assert.match(off.sight.blocker, /switched off/);

  const broken = capabilities(cfg({ screen: { engine: 'nonesuch' } }));
  assert.equal(broken.sight.how, null);
  assert.match(broken.sight.blocker, /nonesuch/, 'names the setting that is wrong');
  assert.ok(!broken.sight.blocker.includes('switched off'));
});

test('what it cannot do, it is told plainly not to offer', () => {
  const block = capabilityBlock(cfg({ voice: { tts: { engine: 'nonesuch' } } }));
  assert.match(block, /[Nn]othing on this machine can speak/);
  assert.match(block, /[Nn]ever offer/, 'the failure this exists to prevent is the offer, not the attempt');
  assert.ok(!block.includes('read aloud'));
});

test('and what it can do, it is told it has', () => {
  const block = capabilityBlock(cfg());
  assert.match(block, /see the screen: the look tool captures it with grim/);
  assert.match(block, /read aloud, through piper/);
});

test('blind, it is told not to guess instead', () => {
  const block = capabilityBlock(cfg({ screen: { engine: 'nonesuch' } }));
  assert.match(block, /cannot see the screen/);
  assert.match(block, /do not\s+work around it/, 'reading files and inferring the screen is the wrong repair');
});

test('dictation is mentioned only when something can hear', () => {
  assert.match(capabilityBlock(cfg()), /may arrive dictated/);
  // A recorder with nothing to transcribe with hears nothing.
  const deaf = cfg({ voice: { stt: { engine: 'nonesuch', command: '', streamCommand: '', streaming: false } } });
  assert.equal(capabilities(deaf).dictation.how, null);
  assert.ok(!capabilityBlock(deaf).includes('dictated'));
});

test('live dictation counts as hearing even with no transcriber', () => {
  const streaming = cfg({
    voice: { stt: { engine: 'nonesuch', streamCommand: 'my-stream', streaming: true } },
  });
  assert.equal(capabilities(streaming).dictation.how, 'arecord');
});

test('a task someone set up is named, so it is used instead of improvised', () => {
  const block = capabilityBlock(cfg({
    automations: [{ name: 'deploy', command: 'make deploy' }, { name: 'backup', command: 'make backup' }],
  }));
  assert.match(block, /deploy, backup/);
  assert.match(block, /Prefer one of these/);
});

test('with no tasks set up, nothing is said about tasks', () => {
  const block = capabilityBlock(cfg({ automations: [] }));
  assert.ok(!block.includes('/run'), 'an empty list is not worth a line in every prompt');
});

test('a half-written config does not bring the prompt down', () => {
  // These run while building the system prompt, so throwing here would
  // mean no session at all rather than one missing paragraph.
  for (const config of [{}, { screen: {} }, { voice: undefined }, { automations: null }]) {
    assert.doesNotThrow(() => capabilityBlock(config));
  }
  assert.deepEqual(capabilities({}).automations, []);
});

test('a command of their own counts as a backend', () => {
  const custom = capabilities(cfg({
    screen: { command: 'my-shot {{file}}' },
    voice: { tts: { command: 'my-voice' } },
  }));
  assert.equal(custom.sight.how, 'command');
  assert.equal(custom.speech.how, 'command');
});

test('the persona carries it, above anything that moves', () => {
  const persona = buildPersona(cfg({ memory: false }));
  assert.match(persona, /What you can do on this machine/);
  // Ahead of the working set and the notes, being the thing least likely
  // to change between one turn and the next.
  const capabilities_at = persona.indexOf('What you can do on this machine');
  const terminal_at = persona.indexOf('compact terminal panel');
  assert.ok(terminal_at !== -1 && terminal_at < capabilities_at, 'after who it is, before where it is');
});
