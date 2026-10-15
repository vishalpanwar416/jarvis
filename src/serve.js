// `jarvis --serve`: a resident jarvis for another program to talk to.
//
// One-shot mode pays for everything on every question: Node starts, the
// SDK loads, the Claude Code CLI is spawned, the session is initialised, and
// only then does the model see the prompt. That is most of the wait for a
// short answer. Serve mode pays once. The process stays up, keeps one
// session warm across turns (so the prompt cache stays warm too), streams
// the reply token by token, and goes away by itself after a quiet spell.
//
// The protocol is JSON, one object per line. On stdin:
//
//   {"type":"ask","id":"<any>","prompt":"…","resume":"<session id>"|null,
//    "voice":true}   the question was spoken and the answer will be read
//                    out loud, so it is written to be heard rather than read
//   {"type":"interrupt"}
//   {"type":"quit"}
//
// On stdout, in reply (every line carries the ask's id where it has one):
//
//   {"type":"ready"}                              once, at start
//   {"type":"init","id":…,"sessionId":…}          the session behind this ask
//   {"type":"delta","id":…,"text":…}              a piece of the reply
//   {"type":"activity","id":…,"text":…,"done":…}  a tool being used, in words,
//                                                 or ("thinking":true) a line
//                                                 of what it is working out
//   {"type":"result","id":…,"text":…,"sessionId":…,"durationMs":…,"isError":…,
//    "totals":{"inputTokens":…,"outputTokens":…,"cacheReadTokens":…,…}|null,
//    "voice":true,         this answer was written to be spoken
//    "resumeFailed":true}   the conversation asked for is gone; ask afresh
//   {"type":"error","id":…,"text":…}
//   {"type":"closed","id":…}                      the session's stream ended
//   {"type":"bye","reason":"idle"|"quit"}         about to exit
//
// `resume` picks the session: the same id as the one already open reuses
// it; a different one closes it and opens that conversation; none means a
// new conversation, which reuses the open session only if it has never
// been spoken to. One question at a time — a second `ask` while one is in
// flight is answered with an error.
//
// A tool that is not pre-approved is put to whoever is on the other end:
//
//   out  {"type":"permission","id":<ask>,"permitId":…,"tool":…,"summary":…}
//   in   {"type":"permit","permitId":…,"allow":true|false,"always":true}
//
// `id` is the ask, as on every other line, so a caller routing by it does
// not have to make an exception; `permitId` identifies the request itself.
//
// If they do not answer, it is refused — the same refusal this used to give
// unconditionally, because there was no way to ask. "always" lasts as long
// as the process does and no longer; nothing here is written to disk.
// Nothing but protocol goes to stdout; notes go to stderr.
import readline from 'node:readline';
import { JarvisSession, isPreApproved } from './agent.js';
import { framePrompt } from './persona.js';
import { buildAutomationServer } from './automations.js';
import { summarize } from './summarize.js';
import { buildMemoryServer, MEMORY_TOOLS } from './memory-tools.js';
import { buildScreenServer, screenToolsAllowedUnasked } from './screen-tools.js';

// `createSession` exists so the protocol above can be tested without the SDK
// and a live model behind it: everything in this file is a decision about
// lines in and lines out, and none of it should need a network to check.
// Production passes nothing and gets the real session.
export async function serve({
  config,
  idleSeconds = 600,
  permissionSeconds = 120,
  createSession = (options) => new JarvisSession(options),
  input = process.stdin,
  output = process.stdout,
  exit = (code) => process.exit(code),
}) {
  const out = (object) => output.write(`${JSON.stringify(object)}\n`);
  const note = (text) => process.stderr.write(`jarvis --serve: ${text}\n`);
  const automationServer = buildAutomationServer(config);
  const screenServer = buildScreenServer(config);
  const unaskedScreen = screenToolsAllowedUnasked(config);
  const mcpServers = {
    memory: buildMemoryServer(),
    ...(screenServer ? { screen: screenServer } : {}),
    ...(automationServer ? { automations: automationServer } : {}),
  };

  let session = null;     // the open JarvisSession, if any
  let current = null;     // {id, text} of the ask in flight
  let idleTimer = null;

  // Tools allowed for the life of this process, on top of the configured
  // ones: what "always" adds. Deliberately not persisted — a standing
  // permission should be a decision you make in config, not one that
  // accumulates behind you.
  const allowedHere = new Set();
  const waiting = new Map();          // permission id -> resolve
  let permitSeq = 0;

  const REFUSED = (toolName) =>
    ({ behavior: 'deny', message: `${toolName} was not permitted.` });

  const askPermission = (toolName, input) => new Promise((resolve) => {
    const permitId = `p${++permitSeq}`;
    const timer = setTimeout(() => {
      if (!waiting.delete(permitId)) return;
      note(`no answer to ${toolName}; refused`);
      resolve(REFUSED(toolName));
    }, permissionSeconds * 1000);

    waiting.set(permitId, (allow, always) => {
      clearTimeout(timer);
      if (allow && always) allowedHere.add(toolName);
      resolve(allow ? { behavior: 'allow' } : REFUSED(toolName));
    });
    out({ type: 'permission', id: current?.id ?? null, permitId, tool: toolName, summary: summarize(input) });
  });

  const shutdown = (reason) => {
    clearTimeout(idleTimer);
    out({ type: 'bye', reason });
    session?.close();
    // The SDK keeps a child process and stdin listeners alive.
    setTimeout(() => exit(0), 50);
  };

  const armIdle = () => {
    clearTimeout(idleTimer);
    if (idleSeconds > 0) idleTimer = setTimeout(() => shutdown('idle'), idleSeconds * 1000);
  };

  const openSession = (resume) => {
    session?.close();
    const s = createSession({
      // Anything beyond reading is put to the person watching the bubble,
      // and the model is told that up front rather than left to discover
      // it one refusal at a time.
      config: { ...config, askFirst: true },
      mcpServers,
      // Remembering writes only to Jarvis' own store, never to the user's
      // files, so it is allowed even here where nothing else may write.
      canUseTool: async (toolName, input) => {
        if (isPreApproved(config, toolName) || MEMORY_TOOLS.includes(toolName)
            || unaskedScreen.includes(toolName) || allowedHere.has(toolName)) {
          return { behavior: 'allow' };
        }
        return askPermission(toolName, input);
      },
      resume,
    });
    s.used = false;
    s.on('event', (event) => {
      if (session !== s) return;      // a session already replaced; its tail is noise
      switch (event.kind) {
        case 'init':
          if (current) current.inited = true;
          out({ type: 'init', id: current?.id ?? null, sessionId: event.sessionId });
          break;
        case 'delta':
          if (current) {
            current.text += event.text;
            out({ type: 'delta', id: current.id, text: event.text });
          }
          break;
        case 'result':
          if (current) {
            // A conversation the CLI no longer has comes back as an error
            // with nothing in it, and without ever having initialised —
            // which is the only way to tell it apart from a turn that went
            // wrong. Saying which it was lets the caller start afresh
            // instead of showing "jarvis reported an error".
            const lost = Boolean(event.isError) && Boolean(current.resume) && !current.inited;
            out({
              type: 'result',
              id: current.id,
              text: lost ? `that conversation is no longer available (${current.resume})` : (event.text || current.text),
              sessionId: s.sessionId,
              durationMs: event.durationMs,
              isError: Boolean(event.isError),
              // Echoed back so a caller reading the answer out knows it was
              // already written for the ear, and need not trim it as hard.
              ...(current.voice ? { voice: true } : {}),
              ...(lost ? { resumeFailed: true } : {}),
              // Running totals for the session, so a caller can show what a
              // conversation is costing without keeping count itself.
              totals: event.totals ?? null,
            });
            current = null;
            armIdle();
          }
          break;
        // The longest silence in a turn is before the first token, while it
        // is still working out what to say. The terminal UI shows the first
        // line of each thought; this sends the same thing, a completed line
        // at a time so a caller's single line does not flicker mid-word.
        // Whether there is any thinking to show at all is already the
        // user's choice, through ui.showThinking.
        case 'thinking-delta':
          if (current && config.ui.showThinking) {
            current.thinking += event.text;
            // A thought with no line break in it must not grow without
            // end; past a line's worth there is nothing more to show.
            if (current.thinking.length > 4000) current.thinking = current.thinking.slice(-1000);
            const cut = current.thinking.lastIndexOf('\n');
            if (cut > -1) {
              const line = current.thinking.slice(0, cut).split('\n').filter((l) => l.trim()).pop();
              current.thinking = current.thinking.slice(cut + 1);
              if (line) out({ type: 'activity', id: current.id, text: oneLine(line), done: false, thinking: true });
            }
          }
          break;
        // What it is doing between one piece of reply and the next. A
        // caller with somewhere to put it (the Bezelrig bubble) can say
        // "Reading agent.js" instead of nothing at all; the rest ignore it.
        case 'tool-start':
          if (current) out({ type: 'activity', id: current.id, text: describeTool(event.name, event.input), done: false });
          break;
        case 'tool-end':
          if (current) out({ type: 'activity', id: current.id, text: '', done: true, isError: Boolean(event.isError) });
          break;
        case 'error':
          out({ type: 'error', id: current?.id ?? null, text: event.text });
          // An error ends the turn. Today one is always followed by
          // `closed`, which clears this — but if that ever stopped being
          // true, `current` would stay set and every later question would
          // be told it was busy, with no idle timer left to end the day.
          current = null;
          armIdle();
          break;
        case 'closed':
          // The CLI went away (or the session was closed). Whatever was in
          // flight will get no result; the next ask starts a fresh session.
          out({ type: 'closed', id: current?.id ?? null });
          if (session === s) session = null;
          current = null;
          armIdle();
          break;
        default:
          break;
      }
    });
    s.start();
    session = s;
    return s;
  };

  const sessionFor = (resume) => {
    if (resume) return session?.sessionId === resume ? session : openSession(resume);
    return session && !session.used ? session : openSession(null);
  };

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      note(`ignored a line that is not JSON: ${line.slice(0, 80)}`);
      return;
    }
    switch (message.type) {
      case 'ask': {
        const id = message.id ?? String(Date.now());
        const prompt = String(message.prompt ?? '').trim();
        if (!prompt) {
          out({ type: 'error', id, text: 'empty prompt' });
          return;
        }
        if (current) {
          out({ type: 'error', id, text: 'busy: a question is already in flight' });
          return;
        }
        clearTimeout(idleTimer);
        const s = sessionFor(message.resume || null);
        // A spoken question wants a spoken answer. The session's system
        // prompt was written before anyone knew how this question would
        // arrive — and the same conversation can be typed into one moment
        // and talked to the next — so the guidance rides on the turn.
        const voice = Boolean(message.voice);
        current = { id, text: '', thinking: '', resume: message.resume || null, inited: false, voice };
        s.used = true;
        s.send(framePrompt(prompt, { voice }));
        break;
      }
      case 'permit': {
        const answer = waiting.get(message.permitId);
        if (!answer) return;            // already timed out, or never asked
        waiting.delete(message.permitId);
        answer(Boolean(message.allow), Boolean(message.always));
        break;
      }
      case 'interrupt':
        session?.interrupt();
        break;
      case 'quit':
        shutdown('quit');
        break;
      default:
        out({ type: 'error', id: message.id ?? null, text: `unknown message type ${message.type}` });
    }
  });
  lines.on('close', () => shutdown('quit'));   // the other end hung up

  out({ type: 'ready' });
  // A session ahead of time: the CLI's own start-up (a second or two) is
  // then paid before the first question rather than as part of it. A
  // `resume` for another conversation simply replaces it.
  openSession(null);
  armIdle();
  // Stay alive until told otherwise.
  await new Promise(() => {});
}

// A tool call in a few words, for a caller with one line to show it in:
// "Reading agent.js", "Running git status". The argument that says what the
// call is about differs per tool and is worth more than the tool's name, so
// the common ones are named; anything else falls back to the bare name.
const TOOL_VERBS = {
  Read: 'Reading', Edit: 'Editing', Write: 'Writing', NotebookEdit: 'Editing',
  Bash: 'Running', Glob: 'Looking for', Grep: 'Searching for',
  WebFetch: 'Fetching', WebSearch: 'Searching the web for', Task: 'Delegating',
  TodoWrite: 'Keeping track',
  // Worth saying out loud in the bubble: a screenshot is being taken, and
  // someone watching ought to see that said rather than inferred.
  look: 'Looking at',
};

// A few tools read better with a noun of their own than with whichever
// argument happens to identify them.
const TOOL_SUBJECTS = {
  look: (input) => (input.target === 'window' ? 'the window in front' : 'the screen'),
};

// A line of thinking as one short phrase: the markdown the model writes for
// itself (headings, emphasis, bullets) reads as punctuation noise in a
// single-line caption.
function oneLine(text, max = 70) {
  const flat = String(text).replace(/[`*_#>]/g, '').replace(/^\s*[-–]\s*/, '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function describeTool(name, input = {}) {
  // MCP tools arrive as mcp__<server>__<tool>; the last part is the useful bit.
  const plain = name.startsWith('mcp__') ? name.split('__').pop() : name;
  const verb = TOOL_VERBS[plain];
  if (!verb) return plain;
  const subject = TOOL_SUBJECTS[plain]?.(input) ?? input.file_path ?? input.notebook_path ?? input.command ??
    input.pattern ?? input.url ?? input.query ?? input.description ?? '';
  const short = String(subject).replace(/\s+/g, ' ').trim();
  if (!short) return verb;
  // A path is recognisable by its last component alone; a command is not.
  const shown = input.file_path || input.notebook_path ? short.split('/').pop() : short;
  return `${verb} ${shown.length > 48 ? `${shown.slice(0, 47)}…` : shown}`;
}
