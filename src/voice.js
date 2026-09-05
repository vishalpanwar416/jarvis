// Voice I/O.
//
// Nothing here is bundled — every backend is an external binary detected on
// PATH, so voice degrades honestly: if a backend is missing, the UI says which
// one and stays text-only rather than silently doing nothing.
//
//   speech out (TTS): piper → espeak-ng → say → spd-say
//   speech in  (STT): whisper-cpp → whisper → custom command
//   recording:        arecord → pw-record → rec (sox)
//
// Pin any of them in jarvis.config.json, or set a `command` template to use a
// backend that isn't listed. Templates understand {{file}}, {{text}}, {{model}}.
//
// Speech in comes in two shapes. The file backend above transcribes a take once
// it's over. A *streaming* backend (voice.stt.streamCommand, `jarvis-stt-stream`
// by default) stays resident and transcribes while you talk, so the text lands
// in the composer as you speak. Streaming is used when it's available and the
// file backend is the fallback — see startStreaming below for the protocol.
//
// On top of streaming sits a voice-activity detector, so a take can end itself
// on silence (ctrl+t once, not twice) and, in hands-free, begin itself too.
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

function pick(preferred, chain) {
  if (preferred && preferred !== 'auto') return preferred;
  return chain.find(has) ?? null;
}

export function detectBackends(config) {
  const voice = config.voice;
  const streamCommand = voice.stt.streamCommand ?? '';
  return {
    tts: voice.tts.command ? 'command' : pick(voice.tts.engine, ['piper', 'espeak-ng', 'say', 'spd-say']),
    stt: voice.stt.command ? 'command' : pick(voice.stt.engine, ['whisper-cpp', 'whisper']),
    // A configured stream command is trusted as-is; the default is only used if
    // it's actually on PATH, so nothing claims live dictation it can't do.
    stream: streamCommand
      ? streamCommand
      : voice.stt.streaming === false || !has('jarvis-stt-stream')
        ? null
        : 'jarvis-stt-stream',
    recorder: pick(voice.recorder.engine, ['arecord', 'pw-record', 'rec']),
  };
}

function template(string, vars) {
  return string.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? '');
}

// Speech synthesizers choke on markdown; strip it down to prose.
export function speakable(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── voice activity detection ────────────────────────────────────────────────
// Every recorder here produces 16 kHz mono s16le, which is 32 bytes per
// millisecond — so a frame's duration is its length, and no clock is needed.
const BYTES_PER_MS = 32;

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Loudness as RMS over the frame, normalised to 0..1.
function loudness(chunk) {
  const samples = chunk.length >> 1;
  if (!samples) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const sample = chunk.readInt16LE(i * 2) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

// Speech is loudness that stands clear of the room, so the gate rides on a
// noise floor learned from the quiet frames — a fixed threshold that works at
// one desk is deaf or twitchy at the next. Set vad.threshold to pin it anyway.
//
// feed() returns 'start' when a phrase begins, 'stop' when it has been quiet
// long enough to be over, and null the rest of the time.
export function createDetector(settings) {
  return {
    noise: 0.005,
    speaking: false,
    voicedMs: 0,
    quietMs: 0,
    takeMs: 0,
    reset() {
      this.speaking = false;
      this.voicedMs = 0;
      this.quietMs = 0;
      this.takeMs = 0;
    },
    feed(chunk) {
      const ms = chunk.length / BYTES_PER_MS;
      const level = loudness(chunk);
      const gate = Math.max(settings.threshold, this.noise * 3 + 0.004);
      const voiced = level > gate;
      if (!voiced) this.noise = this.noise * 0.9 + level * 0.1;

      if (this.speaking) {
        this.takeMs += ms;
        this.quietMs = voiced ? 0 : this.quietMs + ms;
        // A phrase that runs past maxMs is cut loose rather than left to grow:
        // a mic left open by accident shouldn't buffer forever.
        if (this.quietMs >= settings.silenceMs || this.takeMs >= settings.maxMs) {
          this.reset();
          return 'stop';
        }
        return null;
      }

      this.voicedMs = voiced ? this.voicedMs + ms : 0;
      if (this.voicedMs >= settings.startMs) {
        this.reset();
        this.speaking = true;
        return 'start';
      }
      return null;
    },
  };
}

export class Voice {
  constructor(config) {
    this.config = config;
    this.backends = detectBackends(config);
    this.speaking = null;
    this.recording = null;
    this.stream = null; // the resident transcriber, once warmed
    this.take = null; // the dictation in flight
    this.mic = null; // the open microphone, in hands-free
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-voice-'));
  }

  vadSettings() {
    const vad = this.config.voice.vad ?? {};
    return {
      enabled: vad.enabled !== false,
      threshold: num(vad.threshold, 0),
      startMs: num(vad.startMs, 140),
      silenceMs: num(vad.silenceMs, 850),
      maxMs: num(vad.maxMs, 30000) || 30000,
      preRollMs: num(vad.preRollMs, 320),
    };
  }

  get canSpeak() {
    return Boolean(this.backends.tts);
  }

  get canListen() {
    return Boolean(this.backends.recorder && (this.backends.stream || this.backends.stt));
  }

  // Live dictation, as opposed to transcribe-after-the-fact.
  get canStream() {
    return Boolean(this.backends.recorder && this.backends.stream);
  }

  // Hands-free needs the detector as well as live dictation: without one,
  // nothing decides where an utterance starts.
  get canHandsFree() {
    return this.canStream && this.vadSettings().enabled;
  }

  get listening() {
    return Boolean(this.mic);
  }

  // Why listening is unavailable, in a sentence fit for the status line.
  listenBlocker() {
    if (this.canListen) return null;
    if (!this.backends.recorder) return 'no recorder on PATH (install alsa-utils for arecord)';
    return 'no speech-to-text backend (install whisper.cpp, or set voice.stt.command)';
  }

  speakBlocker() {
    return this.canSpeak ? null : 'no speech synthesizer on PATH (install piper or espeak-ng)';
  }

  // ── output ────────────────────────────────────────────────────────────────
  speak(text) {
    const clean = speakable(text);
    if (!clean || !this.canSpeak) return false;
    this.stopSpeaking();

    const { voice, rate, command } = this.config.voice.tts;
    let file = null;
    let args = [];

    switch (this.backends.tts) {
      case 'command':
        file = '/bin/sh';
        args = ['-c', template(command, { text: clean.replace(/'/g, "'\\''") })];
        break;
      case 'piper': {
        // piper writes a wav; pipe it straight into a player.
        const model = this.config.voice.tts.model ?? voice;
        file = '/bin/sh';
        args = [
          '-c',
          `printf %s ${JSON.stringify(clean)} | piper --model ${JSON.stringify(model)} --output_file - | aplay -q -`,
        ];
        break;
      }
      case 'espeak-ng':
        file = 'espeak-ng';
        args = [...(voice ? ['-v', voice] : []), ...(rate ? ['-s', String(rate)] : []), clean];
        break;
      case 'say':
        file = 'say';
        args = [...(voice ? ['-v', voice] : []), ...(rate ? ['-r', String(rate)] : []), clean];
        break;
      case 'spd-say':
      default:
        file = 'spd-say';
        args = ['-w', ...(voice ? ['-y', voice] : []), ...(rate ? ['-r', String(rate)] : []), clean];
        break;
    }

    this.speaking = spawn(file, args, { stdio: 'ignore' });
    this.speaking.on('exit', () => {
      this.speaking = null;
    });
    this.speaking.on('error', () => {
      this.speaking = null;
    });
    return true;
  }

  stopSpeaking() {
    if (!this.speaking) return;
    this.speaking.kill('SIGTERM');
    this.speaking = null;
  }

  // ── input ─────────────────────────────────────────────────────────────────
  // Every backend records the same thing — 16 kHz mono 16-bit — either into a
  // wav for the file backend, or as headerless PCM on stdout for the streaming
  // one, which wants frames rather than a finished file.
  recorderCommand(destination) {
    const device = this.config.voice.recorder.device;
    const raw = destination === '-';
    const table = {
      arecord: [
        'arecord',
        [
          '-q',
          ...(raw ? ['-t', 'raw'] : []),
          '-f', 'S16_LE', '-r', '16000', '-c', '1',
          ...(device ? ['-D', device] : []),
          destination,
        ],
      ],
      'pw-record': [
        'pw-record',
        [
          '--rate', '16000', '--channels', '1',
          ...(raw ? ['--format', 's16'] : []),
          ...(device ? ['--target', device] : []),
          destination,
        ],
      ],
      rec: [
        'rec',
        [
          '-q',
          ...(raw ? ['-t', 'raw', '-e', 'signed', '-b', '16'] : []),
          '-r', '16000', '-c', '1',
          destination,
        ],
      ],
    };
    return table[this.backends.recorder];
  }

  startRecording() {
    if (this.recording || !this.backends.recorder) return false;
    const file = path.join(this.tmpDir, `take-${Date.now()}.wav`);
    const [binary, args] = this.recorderCommand(file);

    const child = spawn(binary, args, { stdio: 'ignore' });
    child.on('error', () => {
      this.recording = null;
    });
    this.recording = { child, file };
    return true;
  }

  // Stops the recorder and returns the transcript, or throws with a reason.
  async stopRecording() {
    if (!this.recording) return null;
    const { child, file } = this.recording;
    this.recording = null;
    child.kill('SIGINT');
    await new Promise((resolve) => child.on('exit', resolve));

    if (!fs.existsSync(file) || fs.statSync(file).size < 4096) {
      throw new Error('nothing recorded');
    }
    const text = await this.transcribe(file);
    fs.rmSync(file, { force: true });
    return text;
  }

  #model() {
    return this.config.voice.stt.model ?? '';
  }

  // A backend whose command line has no {{model}} in it — `jarvis-stt-stream`,
  // say — would otherwise never hear about voice.stt.model, so it goes into the
  // environment as well. Both jarvis-stt scripts read JARVIS_STT_MODEL.
  #env() {
    const model = this.#model();
    return model ? { ...process.env, JARVIS_STT_MODEL: model } : process.env;
  }

  transcribe(file) {
    const { model, command } = this.config.voice.stt;
    let binary = '/bin/sh';
    let args;

    switch (this.backends.stt) {
      case 'command':
        args = ['-c', template(command, { file, model })];
        break;
      case 'whisper-cpp':
        args = ['-c', `whisper-cpp ${model ? `-m ${JSON.stringify(model)}` : ''} -nt -f ${JSON.stringify(file)}`];
        break;
      case 'whisper':
        args = [
          '-c',
          `whisper ${JSON.stringify(file)} --model ${JSON.stringify(model || 'base.en')} --output_format txt --output_dir ${JSON.stringify(this.tmpDir)} --fp16 False 2>/dev/null && cat ${JSON.stringify(file.replace(/\.wav$/, '.txt'))}`,
        ];
        break;
      default:
        return Promise.reject(new Error(this.listenBlocker() ?? 'no speech-to-text backend'));
    }

    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.#env() });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (err += chunk));
      child.on('error', reject);
      child.on('exit', (code) => {
        const text = out.replace(/\[[\d:.\s\->]+\]/g, '').trim();
        if (code === 0 && text) resolve(text);
        else reject(new Error(err.trim().split('\n').pop() || 'transcription failed'));
      });
    });
  }

  // ── live dictation ────────────────────────────────────────────────────────
  // The transcriber is resident: it loads its model once and then serves every
  // take, because a per-take model load is the very thing that makes live text
  // impossible. It speaks JSON lines on stdout —
  //
  //   ready                  model up
  //   partial {text}         the phrase in progress; replaces the last partial
  //   segment {text}         a finished phrase; append it and keep going
  //   final   {text}         everything since the last flush, after `flush`
  //   error   {text}
  //
  // — takes raw PCM on stdin and control words on fd 3 (`flush`, `reset`).

  // Start the transcriber warming now so the first ctrl+t isn't spent loading a
  // model. Safe to call more than once; a second call is a no-op.
  warm() {
    if (!this.canStream || this.stream) return false;

    const child = spawn('/bin/sh', ['-c', template(this.backends.stream, { model: this.#model() })], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: this.#env(),
    });
    const stream = { child, ready: false, lastError: null };
    this.stream = stream;

    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // a backend that chatters in prose is not fatal
        }
        if (event.type === 'ready') stream.ready = true;
        this.#deliver(event);
      }
    });
    // Only the last stderr line is kept, as the reason a take failed.
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim().split('\n').pop();
      if (text) stream.lastError = text;
    });
    child.on('error', (error) => {
      stream.lastError = error.message;
      this.#deliver({ type: 'error', text: error.message });
      if (this.stream === stream) this.stream = null;
    });
    child.on('exit', () => {
      if (this.stream === stream) this.stream = null;
      this.#deliver({ type: 'error', text: stream.lastError ?? 'the transcriber exited' });
    });
    return true;
  }

  #deliver(event) {
    const take = this.take;
    if (!take) return;
    switch (event.type) {
      case 'partial':
        take.handlers.onPartial?.(event.text);
        break;
      case 'segment':
        take.text = take.text ? `${take.text} ${event.text}` : event.text;
        take.handlers.onSegment?.(event.text, take.text);
        break;
      case 'final':
        take.resolveFinal?.(event.text || take.text);
        break;
      case 'error':
        take.handlers.onError?.(event.text);
        break;
      default:
        break;
    }
  }

  // `owned` says whether ending the take also ends the recorder: push-to-talk
  // opens a mic per take, hands-free keeps one open across many.
  #beginTake(handlers, recorder, owned) {
    this.take = { recorder, handlers, text: '', resolveFinal: null, owned };
  }

  // Ends the take and resolves with the whole transcript. Never rejects: a take
  // that produced nothing resolves empty, so a stuck backend can't wedge the UI.
  // `settleMs` buys time for the last frames to land — zero when the detector
  // ended the take, since a take that ends on silence has already sent its tail.
  #finishTake(settleMs) {
    const take = this.take;
    if (!take) return Promise.resolve('');
    if (take.owned) take.recorder.kill('SIGINT');

    const stream = this.stream;
    if (!stream) {
      this.take = null;
      return Promise.resolve(take.text.trim());
    }

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let settleTimer = null;
      const finish = (text) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(settleTimer);
        if (this.take === take) this.take = null;
        resolve((text ?? '').trim());
      };
      take.resolveFinal = finish;
      const flush = () => {
        if (stream.child.stdin.writable) stream.child.stdio[3].write('flush\n');
        else finish(take.text);
      };
      // The tail of a take still has to be transcribed, so the answer lags the
      // key by a moment. Past this, take what we already have.
      timer = setTimeout(() => finish(take.text), num(this.config.voice.stt.finalTimeoutMs, 5000));
      if (settleMs > 0) settleTimer = setTimeout(flush, settleMs);
      else flush();
    });
  }

  // Begins a take. Text arrives through the handlers until stopStreaming(), or
  // until the detector hears the end of it and calls onSilence.
  startStreaming(handlers = {}) {
    if (this.take || this.mic || !this.canStream) return false;
    if (!this.stream) this.warm();
    const stream = this.stream;
    if (!stream) return false;

    const [binary, args] = this.recorderCommand('-');
    const recorder = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const vad = this.vadSettings();
    const detector = vad.enabled ? createDetector(vad) : null;

    // Written frame by frame rather than piped, because .pipe() would close the
    // transcriber's stdin when the recorder stops and end the resident process.
    recorder.stdout.on('data', (chunk) => {
      if (stream.child.stdin.writable) stream.child.stdin.write(chunk);
      // The take is already open, so a phrase beginning is nothing to act on —
      // only its end is. Silence before you've said anything holds the mic.
      if (detector && this.take && detector.feed(chunk) === 'stop') handlers.onSilence?.();
    });
    recorder.on('error', (error) => {
      handlers.onError?.(`recorder failed: ${error.message}`);
      this.take = null;
    });

    this.#beginTake(handlers, recorder, true);
    if (!stream.ready) handlers.onWarming?.();
    return true;
  }

  stopStreaming() {
    return this.#finishTake(num(this.config.voice.stt.settleMs, 120));
  }

  // ── hands-free ────────────────────────────────────────────────────────────
  // The mic stays open across utterances and the detector decides where each
  // one begins and ends, so a conversation costs no keystrokes. Frames only
  // reach the transcriber while an utterance is in flight — silence costs
  // nothing — and the few hundred milliseconds from before the detector was
  // sure are replayed out of a ring buffer, so the first syllable survives.
  startHandsFree(handlers = {}) {
    if (this.mic || this.take || !this.canHandsFree) return false;
    if (!this.stream) this.warm();
    const stream = this.stream;
    if (!stream) return false;

    const vad = this.vadSettings();
    const [binary, args] = this.recorderCommand('-');
    const recorder = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const mic = {
      recorder,
      handlers,
      detector: createDetector(vad),
      preRoll: [],
      preRollBytes: 0,
      preRollLimit: Math.round(vad.preRollMs * BYTES_PER_MS),
      muted: false,
      closing: false,
    };
    this.mic = mic;

    recorder.stdout.on('data', (chunk) => this.#hear(mic, chunk));
    recorder.on('error', (error) => {
      if (this.mic === mic) this.mic = null;
      handlers.onError?.(`recorder failed: ${error.message}`);
    });
    recorder.on('exit', () => {
      if (this.mic !== mic || mic.closing) return;
      this.mic = null;
      handlers.onError?.('the recorder stopped');
    });
    if (!stream.ready) handlers.onWarming?.();
    return true;
  }

  #hear(mic, chunk) {
    if (mic.muted) return;
    const speaking = Boolean(this.take);
    if (speaking && this.stream?.child.stdin.writable) this.stream.child.stdin.write(chunk);

    const edge = mic.detector.feed(chunk);
    if (speaking) {
      if (edge === 'stop') this.#endUtterance(mic);
      return;
    }

    // Not talking yet: hold the last moments of room tone as pre-roll.
    mic.preRoll.push(chunk);
    mic.preRollBytes += chunk.length;
    while (mic.preRoll.length > 1 && mic.preRollBytes - mic.preRoll[0].length >= mic.preRollLimit) {
      mic.preRollBytes -= mic.preRoll.shift().length;
    }
    if (edge === 'start') this.#beginUtterance(mic);
  }

  #beginUtterance(mic) {
    // Your voice outranks his: talking over a reply cuts it off.
    this.stopSpeaking();
    this.#beginTake(mic.handlers, mic.recorder, false);
    const stream = this.stream;
    if (stream?.child.stdin.writable) for (const frame of mic.preRoll) stream.child.stdin.write(frame);
    this.#clearPreRoll(mic);
    mic.handlers.onSpeech?.();
  }

  async #endUtterance(mic) {
    this.#clearPreRoll(mic);
    const text = await this.#finishTake(0);
    if (this.mic !== mic) return; // hands-free was switched off mid-flush
    mic.handlers.onUtterance?.(text);
  }

  #clearPreRoll(mic) {
    mic.preRoll = [];
    mic.preRollBytes = 0;
  }

  // Throws the utterance in flight away instead of delivering it. The
  // transcriber is told to forget what it has heard so far, or the abandoned
  // half-sentence would arrive on the front of the next take.
  abortTake() {
    const take = this.take;
    if (!take) return;
    this.take = null;
    if (take.owned) take.recorder.kill('SIGINT');
    if (this.stream?.child.stdin.writable) this.stream.child.stdio[3].write('reset\n');
    if (this.mic) {
      this.mic.detector.reset();
      this.#clearPreRoll(this.mic);
    }
  }

  // Deafen the mic without closing it — while he is speaking, or while a turn
  // is running — so the loop can't hear itself and answer its own reply.
  setMuted(muted) {
    const mic = this.mic;
    if (!mic || mic.muted === muted) return;
    mic.muted = muted;
    if (!muted) return;
    this.#clearPreRoll(mic);
    mic.detector.reset();
    if (this.take) this.#endUtterance(mic);
  }

  // Closes the mic and resolves with whatever the utterance in flight had.
  stopHandsFree() {
    const mic = this.mic;
    if (!mic) return Promise.resolve('');
    mic.closing = true;
    this.mic = null;
    const pending = this.take ? this.#finishTake(0) : Promise.resolve('');
    mic.recorder.kill('SIGINT');
    return pending;
  }

  dispose() {
    this.stopSpeaking();
    this.recording?.child.kill('SIGKILL');
    this.mic?.recorder.kill('SIGKILL');
    this.mic = null;
    this.take?.recorder.kill('SIGKILL');
    this.take = null;
    this.stream?.child.kill('SIGTERM');
    this.stream = null;
    fs.rmSync(this.tmpDir, { recursive: true, force: true });
  }
}
