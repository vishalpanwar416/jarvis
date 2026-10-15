// Looking at the screen.
//
//   node --test test/screen.test.mjs
//
// No real desktop is involved: a `screen.command` template stands in for the
// capturer, so the tests can make it succeed, fail, or lie about succeeding,
// and then check what was left behind. That last part is the point of the
// file — a picture of someone's screen is the one temp file here that must
// never outlive the answer, including when the capture goes wrong.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  Screen,
  detectBackends,
  captureBlocker,
  captureCommand,
  shrinkCommand,
  pngSize,
  forgetBackends,
  CAPTURERS,
  SHRINKERS,
} from '../src/screen.js';
import { DEFAULTS, merge } from '../src/config.js';

const config = (patch = {}) => merge(DEFAULTS, patch);

// A real PNG, built here rather than committed: the size tests have to read
// an actual IHDR, and a fixture nobody can see the inside of would teach less.
function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  // One filter byte plus three bytes a pixel, per row.
  const raw = Buffer.alloc(height * (1 + width * 3));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A scratch directory per test, with a PNG in it for a fake capturer to copy.
// Deliberately not named `jarvis-screen-*`: that is the prefix leftovers()
// counts, and a fixture of our own in the list would mask a real leak.
function fixture(width = 2000, height = 1200) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-shot-fixture-'));
  const source = path.join(dir, 'source.png');
  fs.writeFileSync(source, png(width, height));
  return { dir, source, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const leftovers = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('jarvis-screen-'));

// ── which backend, or none, and why ─────────────────────────────────────────

test('auto picks only from the chains it knows how to drive', () => {
  const backends = detectBackends(config());
  assert.ok(backends.capture === null || CAPTURERS.includes(backends.capture));
  assert.ok(backends.shrink === null || SHRINKERS.includes(backends.shrink));
  assert.deepStrictEqual(backends.unsupported, {});
});

test('each backend is probed once, not once per Screen', () => {
  // Asking the session bus whether the shell will answer is a round trip, and
  // the answer cannot change under us. Before this was cached, every Screen
  // built re-ran the lot — which cost the test suite thirty seconds and the
  // app a visible pause at startup.
  const started = Date.now();
  for (let i = 0; i < 40; i += 1) detectBackends(config());
  const cached = Date.now() - started;
  assert.ok(cached < 1000, `forty detections cost ${cached}ms`);

  forgetBackends();
  const first = detectBackends(config());
  assert.deepStrictEqual(first, detectBackends(config()), 'and the answer is the same either way');
});

test('a capturer no chain knows is refused, and blamed on the setting', () => {
  const backends = detectBackends(config({ screen: { engine: 'flameshot' } }));
  assert.strictEqual(backends.capture, null);
  assert.strictEqual(backends.unsupported.capture, 'flameshot');
  assert.match(captureBlocker(backends), /screen\.engine "flameshot"/);
  assert.match(captureBlocker(backends), /gnome-shell/, 'and says what it could have been');
});

test('with nothing at all, the blocker names something worth installing', () => {
  const blocker = captureBlocker({ capture: null, unsupported: {} });
  assert.match(blocker, /grim|maim/);
});

test('a command template is taken as given, whatever is on PATH', () => {
  const backends = detectBackends(config({ screen: { command: 'my-shot {{file}}' } }));
  assert.strictEqual(backends.capture, 'command');
});

// ── the command lines ───────────────────────────────────────────────────────

test('the shell is asked for the screen with flash off', () => {
  const [binary, args] = captureCommand('gnome-shell', { file: '/tmp/a.png', target: 'screen', cursor: false });
  assert.strictEqual(binary, 'gdbus');
  assert.ok(args.includes('org.gnome.Shell.Screenshot.Screenshot'));
  // include_cursor, flash, filename — in that order, and flash is never true.
  assert.deepStrictEqual(args.slice(-3), ['false', 'false', '/tmp/a.png']);
});

test('a window capture puts include_frame in front of the rest', () => {
  const [, args] = captureCommand('gnome-shell', { file: '/tmp/a.png', target: 'window', cursor: true });
  assert.ok(args.includes('org.gnome.Shell.Screenshot.ScreenshotWindow'));
  // include_frame, include_cursor, flash, filename — the window method takes
  // one argument more than the screen one, and in this order.
  assert.deepStrictEqual(args.slice(-4), ['true', 'true', 'false', '/tmp/a.png']);
});

test('the pointer is left out unless it is asked for', () => {
  assert.ok(!captureCommand('grim', { file: '/tmp/a.png', target: 'screen', cursor: false })[1].includes('-c'));
  assert.ok(captureCommand('grim', { file: '/tmp/a.png', target: 'screen', cursor: true })[1].includes('-c'));
});

test('naming a window needs a substitution, so those two go through a shell', () => {
  const [binary, args] = captureCommand('maim', { file: '/tmp/a.png', target: 'window', cursor: false });
  assert.strictEqual(binary, '/bin/sh');
  assert.ok(args[1].includes('xdotool getactivewindow'));
  assert.ok(args[1].includes('"/tmp/a.png"'), 'and the path is quoted');
  // Without a window to name there is nothing to substitute, so no shell.
  assert.strictEqual(captureCommand('maim', { file: '/tmp/a.png', target: 'screen' })[0], 'maim');
});

test('a backend outside the chain has no command at all', () => {
  assert.strictEqual(captureCommand('flameshot', { file: '/tmp/a.png', target: 'screen' }), null);
});

test('the shrinkers are told to shrink only, never to enlarge', () => {
  for (const name of ['magick', 'convert', 'gm']) {
    const [, args] = shrinkCommand(name, { file: 'a.png', out: 'b.png', max: 1568 });
    assert.ok(args.includes('1568x1568>'), `${name} uses the "only if bigger" form`);
  }
  const [, ffmpeg] = shrinkCommand('ffmpeg', { file: 'a.png', out: 'b.png', max: 1568 });
  assert.ok(ffmpeg.join(' ').includes('force_original_aspect_ratio=decrease'));
});

// ── reading a PNG's size without decoding it ────────────────────────────────

test('a PNG says how big it is in its first chunk', () => {
  const f = fixture(1234, 567);
  try {
    assert.deepStrictEqual(pngSize(f.source), { width: 1234, height: 567 });
  } finally {
    f.clean();
  }
});

test('anything that is not a PNG is simply unknown, not an error', () => {
  const f = fixture();
  try {
    const notPng = path.join(f.dir, 'x.png');
    fs.writeFileSync(notPng, 'this is not an image at all');
    assert.strictEqual(pngSize(notPng), null);
    fs.writeFileSync(notPng, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // truncated
    assert.strictEqual(pngSize(notPng), null);
    assert.strictEqual(pngSize(path.join(f.dir, 'nothing-here.png')), null);
  } finally {
    f.clean();
  }
});

// ── taking one ──────────────────────────────────────────────────────────────

test('a capture comes back as base64 with the size it was', async () => {
  const f = fixture(800, 600);
  const before = leftovers().length;
  try {
    const screen = new Screen(config({ screen: { command: `cp ${f.source} {{file}}` } }));
    const shot = await screen.capture();
    assert.strictEqual(shot.mimeType, 'image/png');
    assert.strictEqual(shot.fullWidth, 800);
    assert.strictEqual(shot.fullHeight, 600);
    assert.ok(shot.data.length > 0);
    assert.deepStrictEqual(
      Buffer.from(shot.data, 'base64').subarray(0, 8),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      'and it really is a PNG',
    );
    assert.strictEqual(leftovers().length, before, 'with nothing left behind');
  } finally {
    f.clean();
  }
});

test('the target reaches the command that captures it', async () => {
  const f = fixture(10, 10);
  try {
    const screen = new Screen(config({ screen: { command: `echo {{target}} > ${f.dir}/said; cp ${f.source} {{file}}` } }));
    await screen.capture({ target: 'window' });
    assert.strictEqual(fs.readFileSync(path.join(f.dir, 'said'), 'utf8').trim(), 'window');
  } finally {
    f.clean();
  }
});

test('a capture that fails leaves nothing behind either', async () => {
  const before = leftovers().length;
  const screen = new Screen(config({ screen: { command: 'exit 3' } }));
  await assert.rejects(() => screen.capture(), /could not capture|exit/i);
  assert.strictEqual(leftovers().length, before, 'the directory goes even when the capture does not');
});

test('a capturer that claims success and writes nothing is caught', async () => {
  const before = leftovers().length;
  const screen = new Screen(config({ screen: { command: 'true' } }));
  await assert.rejects(() => screen.capture(), /left no image/);
  assert.strictEqual(leftovers().length, before);
});

test('an empty file is no better than a missing one', async () => {
  const before = leftovers().length;
  const screen = new Screen(config({ screen: { command: ': > {{file}}' } }));
  await assert.rejects(() => screen.capture(), /left no image/);
  assert.strictEqual(leftovers().length, before);
});

test('a capture that hangs is given up on rather than waited for', async () => {
  const before = leftovers().length;
  const started = Date.now();
  const screen = new Screen(config({ screen: { command: 'sleep 30', timeoutMs: 300 } }));
  await assert.rejects(() => screen.capture());
  // Not just that it rejects — that it rejects *now*. The command here is a
  // shell around a sleep, and killing only the shell leaves the sleep holding
  // the stdout it inherited; nothing then settles until it finishes on its
  // own. That cost thirty seconds a run before the group kill, and it would
  // have cost a real caller thirty seconds of silence.
  assert.ok(Date.now() - started < 5000, `gave up promptly (${Date.now() - started}ms)`);
  assert.strictEqual(leftovers().length, before);
});

test('with no way to see, the tool says so before it starts', async () => {
  const screen = new Screen(config({ screen: { engine: 'flameshot' } }));
  assert.strictEqual(screen.canSee, false);
  await assert.rejects(() => screen.capture(), /screen\.engine "flameshot"/);
});

// ── shrinking ───────────────────────────────────────────────────────────────

test('an image already inside the cap is not touched', async () => {
  const f = fixture(640, 480);
  try {
    // A shrinker that would fail if it ran at all: proof that it did not.
    const screen = new Screen(config({
      screen: { command: `cp ${f.source} {{file}}`, shrinker: 'magick', maxPixels: 1568 },
    }));
    const shot = await screen.capture();
    assert.strictEqual(shot.width, 640, 'the size it came in at');
    assert.strictEqual(shot.fullWidth, 640);
  } finally {
    f.clean();
  }
});

test('a shrinker that cannot run is not the end of the answer', async () => {
  const f = fixture(4000, 2000);
  try {
    // Pinned to something that is almost certainly not installed — a pinned
    // name is trusted without looking, which is what makes this stageable.
    const screen = new Screen(config({
      screen: { command: `cp ${f.source} {{file}}`, shrinker: 'gm', maxPixels: 1568, timeoutMs: 4000 },
    }));
    const shot = await screen.capture();
    assert.ok(shot.data.length > 0, 'the full image is sent rather than nothing');
    assert.strictEqual(shot.fullWidth, 4000);
    assert.strictEqual(leftovers().length, 0, 'and the scratch directory still goes');
  } finally {
    f.clean();
  }
});
