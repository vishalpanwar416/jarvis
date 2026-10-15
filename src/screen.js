// Looking at the screen.
//
// "What's on my screen?" is a question Jarvis could not answer, because
// nothing here could see. This takes one frame, hands it to the model, and
// deletes it — the file exists for about as long as it takes to read.
//
// Nothing is bundled. Like voice, every backend is an external program
// detected at run time, so the capability degrades honestly: if there is no
// way to capture on this desktop, the tool says which programs would give it
// one rather than failing with something cryptic.
//
//   capture: gnome-shell (D-Bus) → grim → gnome-screenshot → spectacle
//            → maim → scrot → import
//   shrink:  magick → convert → gm → ffmpeg
//
// The shrink step is not cosmetic. A 4K screenshot is eight megabytes of PNG
// and the model resizes it anyway; sending the long edge at 1568 costs the
// same number of tokens and a great deal less waiting.
//
// Pin a backend in jarvis.config.json under `screen`, or give a `command`
// template ({{file}}) and skip detection entirely.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function has(binary) {
  try {
    execFileSync('command', ['-v', binary], { shell: '/bin/sh', stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Exhaustive, not merely preferred: the command lines below are written one
// per name, so a backend outside this list can never be driven. A pinned name
// we don't know is refused here and remembered, so the blocker can blame the
// config rather than an empty PATH.
export const CAPTURERS = ['gnome-shell', 'grim', 'gnome-screenshot', 'spectacle', 'maim', 'scrot', 'import'];
export const SHRINKERS = ['magick', 'convert', 'gm', 'ffmpeg'];

// gnome-shell is the odd one out: it is not a program on PATH but a method on
// the session bus, and on Wayland it is usually the only thing allowed to
// read the screen at all. It counts as available when gdbus can reach it.
function hasShell() {
  if (!has('gdbus')) return false;
  try {
    execFileSync(
      'gdbus',
      ['call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/org/gnome/Shell/Screenshot',
        '--method', 'org.freedesktop.DBus.Peer.Ping'],
      { stdio: 'ignore', timeout: 3000 },
    );
    return true;
  } catch {
    return false;
  }
}

// Probing costs real time — reaching the session bus to ask whether the shell
// will answer takes a round trip, and the answer is the same every time inside
// one process. Neither PATH nor the shell's presence changes under us, so each
// name is looked up once. Without this, every Screen built re-ran the lot.
const probed = new Map();
const available = (name) => {
  if (!probed.has(name)) probed.set(name, name === 'gnome-shell' ? hasShell() : has(name));
  return probed.get(name);
};

// For tests, and for anyone who installs a capturer while this is running.
export function forgetBackends() {
  probed.clear();
}

export function detectBackends(config = {}) {
  const screen = config.screen ?? {};
  const unsupported = {};
  const pick = (preferred, chain, key) => {
    if (preferred && preferred !== 'auto') {
      if (chain.includes(preferred)) return preferred;
      unsupported[key] = preferred;
      return null;
    }
    return chain.find(available) ?? null;
  };
  return {
    capture: screen.command ? 'command' : pick(screen.engine, CAPTURERS, 'capture'),
    shrink: pick(screen.shrinker, SHRINKERS, 'shrink'),
    unsupported,
  };
}

// Why there is no way to see the screen, in a sentence fit to show someone.
export function captureBlocker(backends) {
  if (backends.capture) return null;
  const bad = backends.unsupported.capture;
  if (bad) return `screen.engine "${bad}" is not one of ${CAPTURERS.join(', ')}`;
  return 'nothing on this desktop can capture the screen (install grim on Wayland, or maim on X11)';
}

function template(string, vars) {
  return string.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? '');
}

// PNG says how big it is in its first chunk: an 8-byte signature, then IHDR
// with width and height as big-endian 32-bit. Cheaper than decoding the image
// to find out whether it is worth shrinking, and with no dependency.
export function pngSize(file) {
  let handle = null;
  try {
    handle = fs.openSync(file, 'r');
    const header = Buffer.alloc(24);
    if (fs.readSync(handle, header, 0, 24, 0) < 24) return null;
    if (header.toString('latin1', 1, 4) !== 'PNG') return null;
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } catch {
    return null;
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
}

function run(binary, args, timeoutMs) {
  return new Promise((resolve) => {
    // Its own process group, so a capture that hangs can be ended whole.
    // Several of these backends are a shell wrapping something else, and
    // killing only the shell leaves the something else running — still
    // holding the stdout it inherited, which means this call does not come
    // back until the stray process does. Signalling the group takes both.
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let err = '';
    let out = '';
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL'); // no group (it exited already, or spawn failed)
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, err: error.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, out, err: err.trim().split('\n').filter(Boolean).pop() ?? '' });
    });
  });
}

// The command line per backend. `target` is 'screen' or 'window'; a backend
// that cannot single out a window captures everything instead, which is a
// better answer than refusing.
export function captureCommand(backend, { file, target, cursor, command }) {
  const window = target === 'window';
  switch (backend) {
    case 'command':
      return ['/bin/sh', ['-c', template(command, { file, target })]];
    case 'gnome-shell':
      return [
        'gdbus',
        ['call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/org/gnome/Shell/Screenshot',
          '--method', `org.gnome.Shell.Screenshot.Screenshot${window ? 'Window' : ''}`,
          // ScreenshotWindow takes include_frame first; both then take
          // include_cursor, flash, filename. Flash is always false: a white
          // flash across the desktop every time Jarvis glances at it would
          // be a cost with no benefit to anyone.
          ...(window ? ['true'] : []), String(Boolean(cursor)), 'false', file],
      ];
    case 'grim':
      return ['grim', [...(cursor ? ['-c'] : []), file]];
    case 'gnome-screenshot':
      return ['gnome-screenshot', [...(window ? ['-w'] : []), ...(cursor ? ['-p'] : []), '-f', file]];
    case 'spectacle':
      return ['spectacle', ['-b', '-n', ...(window ? ['-a'] : ['-f']), '-o', file]];
    // maim and import name a window by id, which means asking xdotool for the
    // active one — a substitution, so these two go through a shell. The X11
    // backends generally; on Wayland none of them can see anything anyway.
    case 'maim':
      return window
        ? ['/bin/sh', ['-c', `maim ${cursor ? '-u ' : ''}-i "$(xdotool getactivewindow)" ${JSON.stringify(file)}`]]
        : ['maim', [...(cursor ? ['-u'] : []), file]];
    case 'scrot':
      return ['scrot', [...(cursor ? ['-p'] : []), ...(window ? ['-u'] : []), '-o', file]];
    case 'import':
      return window
        ? ['/bin/sh', ['-c', `import -window "$(xdotool getactivewindow)" ${JSON.stringify(file)}`]]
        : ['import', ['-window', 'root', file]];
    default:
      return null;
  }
}

// gdbus reports a failed screenshot in its return value rather than its exit
// code: `(false, '')` is a refusal, not a crash, and would otherwise look
// like success right up until the file turned out not to be there.
function shellRefused(backend, result) {
  return backend === 'gnome-shell' && /^\(false/.test(result.out ?? '');
}

export function shrinkCommand(backend, { file, out, max }) {
  switch (backend) {
    // The trailing '>' is ImageMagick for "only if it is bigger".
    case 'magick':
      return ['magick', [file, '-resize', `${max}x${max}>`, out]];
    case 'convert':
      return ['convert', [file, '-resize', `${max}x${max}>`, out]];
    case 'gm':
      return ['gm', ['convert', file, '-resize', `${max}x${max}>`, out]];
    case 'ffmpeg':
      return [
        'ffmpeg',
        ['-y', '-loglevel', 'error', '-i', file,
          '-vf', `scale=w=${max}:h=${max}:force_original_aspect_ratio=decrease:flags=lanczos`, out],
      ];
    default:
      return null;
  }
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class Screen {
  constructor(config = {}) {
    this.config = config;
    this.settings = config.screen ?? {};
    this.backends = detectBackends(config);
  }

  get canSee() {
    return Boolean(this.backends.capture);
  }

  blocker() {
    return captureBlocker(this.backends);
  }

  // One frame, as base64 PNG, and then gone.
  //
  // Everything happens inside a directory of our own, created on the spot
  // with owner-only permissions and removed in a finally — so a capture that
  // fails halfway, or a model that never reads the result, still leaves
  // nothing behind. A picture of someone's screen is not a temp file to be
  // casual about.
  async capture({ target = 'screen', cursor = false } = {}) {
    const blocker = this.blocker();
    if (blocker) throw new Error(blocker);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-screen-'));
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, 'screen.png');
    try {
      const [binary, args] = captureCommand(this.backends.capture, {
        file,
        target,
        cursor,
        command: this.settings.command,
      });
      const result = await run(binary, args, num(this.settings.timeoutMs, 15000));
      if (!result.ok || shellRefused(this.backends.capture, result)) {
        throw new Error(result.err || `${binary} could not capture the screen`);
      }
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
        throw new Error(`${binary} reported success but left no image`);
      }

      const full = pngSize(file);
      const max = num(this.settings.maxPixels, 1568);
      const shown = await this.#shrink(file, dir, full, max);
      const data = fs.readFileSync(shown.file).toString('base64');
      return {
        data,
        mimeType: 'image/png',
        target,
        backend: this.backends.capture,
        width: shown.width ?? full?.width ?? null,
        height: shown.height ?? full?.height ?? null,
        // What it was before shrinking, so an answer can talk about the
        // screen's real size rather than the size of the copy it saw.
        fullWidth: full?.width ?? null,
        fullHeight: full?.height ?? null,
        bytes: data.length,
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Shrinking is best-effort by design: a desktop with no image tool at all
  // should still be able to answer "what's on my screen", just with a bigger
  // picture. A failure here is never the reason the question goes unanswered.
  async #shrink(file, dir, full, max) {
    const tooBig = !full || full.width > max || full.height > max;
    if (!tooBig || !this.backends.shrink) return { file, ...(full ?? {}) };

    const out = path.join(dir, 'small.png');
    const [binary, args] = shrinkCommand(this.backends.shrink, { file, out, max });
    const result = await run(binary, args, num(this.settings.timeoutMs, 15000));
    if (!result.ok || !fs.existsSync(out) || fs.statSync(out).size === 0) {
      return { file, ...(full ?? {}) };
    }
    return { file: out, ...(pngSize(out) ?? full ?? {}) };
  }
}
