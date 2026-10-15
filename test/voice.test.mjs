// The voice layer, as far as it can be exercised without a microphone.
//
//   node --test test/voice.test.mjs
//
// Three things here are logic rather than plumbing, and all three decide
// something a user hears:
//
//   speakable()      what of an answer is read out, and where it stops
//   createDetector() where an utterance begins and ends
//   framePrompt()    what the model is told about how it will be heard
//
// The spawning parts are left alone on purpose: a test that asserts which
// flags arecord was given tests the table it was copied from. What is tested
// is every decision made before anything is spawned — which backend, or none,
// and why — because that is where a missing install turns into a message.
import { test } from 'node:test';
import assert from 'node:assert';

import {
  speakable,
  createDetector,
  detectBackends,
  Voice,
  isNoise,
  TTS_ENGINES,
  STT_ENGINES,
  RECORDERS,
} from '../src/voice.js';
import { framePrompt, voicePrefix, voicePersona, buildPersona } from '../src/persona.js';
import { autopilotPrefix } from '../src/autopilot.js';
import { DEFAULTS, merge } from '../src/config.js';

const config = (patch = {}) => merge(DEFAULTS, patch);

// 16 kHz mono s16le: 32 bytes a millisecond, 16 samples.
function frame(ms, amplitude) {
  const buffer = Buffer.alloc(ms * 32);
  for (let i = 0; i < buffer.length / 2; i += 1) {
    // Alternating sign so the frame has energy rather than a DC offset.
    buffer.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2);
  }
  return buffer;
}
const LOUD = (ms = 20) => frame(ms, 8000);
const QUIET = (ms = 20) => frame(ms, 0);

// ── what gets read aloud ────────────────────────────────────────────────────

test('markdown is stripped down to something a synthesizer can say', () => {
  const said = speakable(
    '## Heading\n\n- **bold** item\n- a `symbol`\n\nSee [the docs](https://example.com/a/b).',
  );
  assert.ok(!said.includes('#'), 'no headings');
  assert.ok(!said.includes('*'), 'no emphasis marks');
  assert.ok(!said.includes('`'), 'no backticks');
  assert.ok(!said.includes('https://'), 'the link target is not read out');
  assert.ok(said.includes('the docs'), 'but the link text survives');
  assert.ok(said.includes('bold item'), 'list markers go, their contents stay');
});

test('a code block is named rather than read character by character', () => {
  const said = speakable('Try this:\n\n```js\nconst x = () => 1;\n```\n\nThat is all.');
  assert.ok(said.includes('code omitted'), 'the block is summarised');
  assert.ok(!said.includes('const'), 'and its contents are gone');
  assert.ok(said.endsWith('That is all.'), 'the prose on either side is kept');
});

test('by default the whole answer is read', () => {
  const long = `${'A sentence that goes on. '.repeat(100)}`;
  assert.ok(speakable(long).length > 2000, 'no cap unless one is asked for');
});

test('a capped answer stops at the end of a sentence, not mid-word', () => {
  const text = `${'Ten chars. '.repeat(40)}`;
  const said = speakable(text, 100);
  assert.ok(said.length <= 100, 'inside the cap');
  assert.ok(said.endsWith('.'), `stops on a sentence end, got "${said.slice(-20)}"`);
});

test('a cap with no sentence end near it falls back to the hard limit', () => {
  // One sentence end, right at the start — too early to cut there, because
  // cutting at character 11 of 100 would throw away nearly all of it.
  const said = speakable(`Short. ${'word '.repeat(100)}`, 100);
  assert.strictEqual(said.length, 100, 'the hard limit is used instead');
  assert.ok(!said.startsWith('Short. w'.slice(0, 7) + '.'), 'and not the early sentence end');
});

test('a short answer is untouched by a cap it never reaches', () => {
  assert.strictEqual(speakable('All done, sir.', 700), 'All done, sir.');
});

test('nothing to say is empty, not a crash', () => {
  assert.strictEqual(speakable(''), '');
  assert.strictEqual(speakable(null), '');
  assert.strictEqual(speakable(undefined), '');
  assert.strictEqual(speakable('   \n\n  '), '');
});

// ── where an utterance begins and ends ──────────────────────────────────────

const vad = { threshold: 0, startMs: 140, silenceMs: 850, maxMs: 30000, preRollMs: 320 };

test('a quiet room never starts a phrase', () => {
  const detector = createDetector(vad);
  for (let i = 0; i < 200; i += 1) assert.strictEqual(detector.feed(QUIET()), null);
  assert.strictEqual(detector.speaking, false);
});

test('speech starts a phrase once there is enough of it', () => {
  const detector = createDetector(vad);
  // 140ms is the threshold: six 20ms frames is 120ms, still not enough.
  for (let i = 0; i < 6; i += 1) assert.strictEqual(detector.feed(LOUD()), null, `frame ${i}`);
  assert.strictEqual(detector.feed(LOUD()), 'start', 'the seventh frame crosses 140ms');
});

test('a single loud click is not a phrase', () => {
  const detector = createDetector(vad);
  assert.strictEqual(detector.feed(LOUD()), null);
  assert.strictEqual(detector.feed(QUIET()), null);
  assert.strictEqual(detector.feed(LOUD()), null, 'the run of voiced audio restarted');
});

test('silence ends the phrase, and only after long enough', () => {
  const detector = createDetector(vad);
  for (let i = 0; i < 7; i += 1) detector.feed(LOUD());
  assert.ok(detector.speaking, 'speaking');
  // 850ms of quiet: 42 frames of 20ms is 840, still inside the pause.
  for (let i = 0; i < 42; i += 1) assert.strictEqual(detector.feed(QUIET()), null, `pause frame ${i}`);
  assert.strictEqual(detector.feed(QUIET()), 'stop', 'and the next one ends it');
  assert.strictEqual(detector.speaking, false, 'the detector is ready for the next phrase');
});

test('a pause shorter than the gap does not end the phrase', () => {
  const detector = createDetector(vad);
  for (let i = 0; i < 7; i += 1) detector.feed(LOUD());
  for (let i = 0; i < 20; i += 1) detector.feed(QUIET()); // 400ms: drawing breath
  assert.strictEqual(detector.feed(LOUD()), null, 'still the same sentence');
  for (let i = 0; i < 42; i += 1) detector.feed(QUIET());
  assert.strictEqual(detector.feed(QUIET()), 'stop', 'the quiet gap restarted after the breath');
});

test('a mic left open is cut loose rather than buffered forever', () => {
  const detector = createDetector({ ...vad, maxMs: 400 });
  for (let i = 0; i < 7; i += 1) detector.feed(LOUD()); // starts at 140ms
  let stopped = false;
  for (let i = 0; i < 40 && !stopped; i += 1) stopped = detector.feed(LOUD()) === 'stop';
  assert.ok(stopped, 'the take ended itself at maxMs even though nobody stopped talking');
});

test('the floor comes down in a quiet room, so a soft voice still registers', () => {
  const quiet = createDetector(vad);
  // A room quieter than the floor the detector starts with.
  for (let i = 0; i < 300; i += 1) quiet.feed(frame(20, 30));
  assert.ok(quiet.noise < 0.005, `the floor dropped to the room (${quiet.noise.toFixed(5)})`);

  // Someone speaking softly — above the room, well under a normal voice.
  const soft = () => frame(20, 400);
  for (let i = 0; i < 6; i += 1) assert.strictEqual(quiet.feed(soft()), null);
  assert.strictEqual(quiet.feed(soft()), 'start', 'and the soft voice is heard');

  // The same voice against the gate the detector starts with is below it.
  const cold = createDetector(vad);
  for (let i = 0; i < 20; i += 1) cold.feed(soft());
  assert.strictEqual(cold.speaking, false, 'which is the whole point of learning the floor');
});

test('a steady sound above the gate is heard as speech — the known limit', () => {
  // The floor is learned from the quiet frames, so a hum that is already
  // above the gate when it arrives keeps it from ever rising to meet it.
  // This is documented behaviour, not an oversight: loudness cannot tell
  // speech from sound. isNoise() is the guard, one layer up.
  const detector = createDetector(vad);
  let phrases = 0;
  for (let i = 0; i < 400; i += 1) if (detector.feed(frame(20, 1200)) === 'start') phrases += 1;
  assert.ok(phrases > 0, 'a hum does open a take; if this ever stops being true, the VAD improved');
});

// ── what the room says, as opposed to what you say ──────────────────────────

test('whisper filler is not a question', () => {
  for (const said of [
    '', '   ', '.', '...', 'you', 'You.', 'Thank you for watching!', 'Thanks for watching.',
    'Subtitles by the Amara.org community', '[BLANK_AUDIO]', '(music playing)', '♪♪♪',
    'uh', 'Um...', 'mmm', 'okay', 'Bye.', 'yeah',
  ]) {
    assert.strictEqual(isNoise(said), true, `"${said}" is the room, not a question`);
  }
});

test('a real question that contains one of those words is still a question', () => {
  for (const said of [
    'thank you for the patch, did it land?',
    'you were saying?',
    'is it okay to deploy',
    'and then what happened',
    'what does uh mean in this log',
    'bye week — when is it',
  ]) {
    assert.strictEqual(isNoise(said), false, `"${said}" must get through`);
  }
});

test('a pinned threshold overrides the learned floor', () => {
  const detector = createDetector({ ...vad, threshold: 0.9 });
  for (let i = 0; i < 20; i += 1) assert.strictEqual(detector.feed(LOUD()), null);
  assert.strictEqual(detector.speaking, false, 'nothing is loud enough for a gate of 0.9');
});

// ── which backend, or none, and why ─────────────────────────────────────────

test('auto picks only from the chains it knows how to drive', () => {
  const backends = detectBackends(config());
  assert.ok(backends.tts === null || TTS_ENGINES.includes(backends.tts));
  assert.ok(backends.stt === null || STT_ENGINES.includes(backends.stt));
  assert.ok(backends.recorder === null || RECORDERS.includes(backends.recorder));
  assert.deepStrictEqual(backends.unsupported, {}, 'nothing was refused');
});

test('an engine no chain knows is refused, and remembered as a config mistake', () => {
  const backends = detectBackends(
    config({ voice: { tts: { engine: 'festival' }, stt: { engine: 'vosk' }, recorder: { engine: 'parec' } } }),
  );
  assert.strictEqual(backends.tts, null);
  assert.strictEqual(backends.stt, null);
  assert.strictEqual(backends.recorder, null);
  assert.deepStrictEqual(backends.unsupported, { tts: 'festival', stt: 'vosk', recorder: 'parec' });
});

test('a refused engine is blamed on the setting, not on an empty PATH', () => {
  const voice = new Voice(config({ voice: { tts: { engine: 'festival' }, recorder: { engine: 'parec' } } }));
  try {
    assert.match(voice.speakBlocker(), /voice\.tts\.engine "festival"/);
    assert.match(voice.speakBlocker(), /espeak-ng/, 'and says what it could have been');
    assert.match(voice.listenBlocker(), /voice\.recorder\.engine "parec"/);
    assert.strictEqual(voice.speak('anything at all'), false, 'and nothing is spoken');
  } finally {
    voice.dispose();
  }
});

test('a command template is taken as given, whatever is on PATH', () => {
  const backends = detectBackends(
    config({ voice: { tts: { command: 'my-tts {{text}}' }, stt: { command: 'my-stt {{file}}' } } }),
  );
  assert.strictEqual(backends.tts, 'command');
  assert.strictEqual(backends.stt, 'command');
});

test('streaming can be switched off without losing the file backend', () => {
  const backends = detectBackends(config({ voice: { stt: { streaming: false } } }));
  assert.strictEqual(backends.stream, null);
});

test('a configured stream command is trusted without looking for it', () => {
  const backends = detectBackends(config({ voice: { stt: { streamCommand: 'my-stream --model {{model}}' } } }));
  assert.strictEqual(backends.stream, 'my-stream --model {{model}}');
});

test('hands-free needs both live dictation and a detector', () => {
  const off = new Voice(config({ voice: { stt: { streamCommand: 'x' }, vad: { enabled: false } } }));
  try {
    assert.strictEqual(off.canHandsFree, false, 'no detector, no hands-free');
  } finally {
    off.dispose();
  }
});

// ── what the model is told about being heard ────────────────────────────────

test('a typed turn carries nothing it does not need', () => {
  assert.strictEqual(framePrompt('what time is it'), 'what time is it');
  assert.strictEqual(framePrompt('what time is it', { autopilot: false, voice: false }), 'what time is it');
});

test('a spoken turn says so, and keeps the question intact', () => {
  const framed = framePrompt('what time is it', { voice: true });
  assert.ok(framed.startsWith('[spoken]'), 'the turn is marked');
  assert.ok(framed.endsWith('what time is it'), 'the question is last, and unaltered');
  assert.ok(framed.includes(voicePrefix()), 'with the whole of the guidance');
});

test('autopilot and speech ride together without eating each other', () => {
  const framed = framePrompt('go on then', { autopilot: true, voice: true });
  assert.ok(framed.includes(autopilotPrefix()), 'autopilot is still said');
  assert.ok(framed.includes(voicePrefix()), 'and so is speech');
  assert.ok(framed.endsWith('go on then'));
  assert.ok(framed.indexOf(autopilotPrefix()) < framed.indexOf(voicePrefix()), 'in a fixed order');
});

test('the spoken guidance rules out what a synthesizer cannot say', () => {
  const said = voicePersona();
  for (const word of ['read out loud', 'markdown', 'bullet', 'code block', 'URL']) {
    assert.ok(said.includes(word), `the guidance mentions ${word}`);
  }
  assert.strictEqual(speakable(said), said, 'and is itself free of markdown');
});

test('the persona is not quietly a voice persona', () => {
  // Speech is a property of a turn, not of the session: baking it into the
  // system prompt would make every typed answer three sentences long too.
  assert.ok(!buildPersona(config({ memory: false })).includes('read out loud'));
});
