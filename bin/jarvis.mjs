#!/usr/bin/env node
// jarvis — a hackable terminal assistant on the Claude Agent SDK.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, listThemes } from '../src/config.js';
import { buildUI } from '../build.mjs';

// Called jarvis everywhere it is seen. Without this the shebang's `node` is
// what shows up: in `ps`, in a system monitor, in the window list, and as
// the terminal's title — which makes several of these indistinguishable
// from every other Node program running.
//
// The title escape goes only to a terminal. In a pipe stdout is the reply
// and nothing else, and an escape sequence in it would be corruption.
process.title = 'jarvis';
if (process.stdout.isTTY) process.stdout.write('\x1b]0;jarvis\x07');

const HELP = `
jarvis — a terminal assistant you can rebuild

  jarvis                    open the interactive assistant
  jarvis "fix the tests"    run one task and exit
  jarvis --resume <id>      continue an earlier session

options
  -m, --model <name>        model to use (default from jarvis.config.json)
      --local               run against the model on this machine (no network);
                            starts the Ollama proxy if it isn't already up
      --effort <level>      low | medium | high | xhigh | max
  -C, --cwd <dir>           working directory for the agent
      --theme <name>        ${listThemes().join(' | ')}
      --voice               speak replies aloud
      --awareness           start with the ambient panel open
      --autopilot           allow every tool, answer every question with its
                            recommended option, never stop to ask (ctrl+p in-app)
      --resume <id>         resume a session id (see /session)
  -y, --yes                 one-shot mode: allow tool use without asking
  -q, --quiet               one-shot mode: reply only, no status lines
      --serve               stay resident and take questions as JSON lines on
                            stdin, answering on stdout (see src/serve.js)
      --idle <seconds>      --serve: exit after this long without a question
      --permission-seconds  --serve: how long to wait for a yes or no (default 120)
                            (default 600, 0 never)
  -h, --help                this text

environment
  JARVIS_SESSION_FILE=<path>  one-shot mode: write the session id there, so a
                            caller can continue the conversation with --resume

edit the UI      src/ui/*.jsx      (rebuilt automatically on launch)
edit the look    themes/*.json
edit behaviour   jarvis.config.json
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // A flag whose value is missing used to read as undefined and then fall
    // through every `if (flags.x)` below, so `jarvis --theme` — or a value you
    // meant to type and didn't — ran silently on the defaults. None of these
    // options take a value that begins with a dash, so that's a miss too.
    const take = () => {
      const value = argv[++index];
      if (value === undefined || value.startsWith('-')) throw new Error(`${arg} needs a value`);
      return value;
    };

    switch (arg) {
      case '-h': case '--help': flags.help = true; break;
      case '-m': case '--model': flags.model = take(); break;
      case '--local': flags.local = true; break;
      case '--effort': flags.effort = take(); break;
      case '-C': case '--cwd': flags.cwd = take(); break;
      case '--theme': flags.theme = take(); break;
      case '--resume': flags.resume = take(); break;
      case '--voice': flags.voice = true; break;
      case '--awareness': flags.awareness = true; break;
      case '--autopilot': flags.autopilot = true; break;
      case '-y': case '--yes': flags.yes = true; break;
      case '-q': case '--quiet': flags.quiet = true; break;
      case '--serve': flags.serve = true; break;
      case '--idle': flags.idle = Number(take()); break;
      case '--permission-seconds': flags.permissionSeconds = Number(take()); break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
        positional.push(arg);
    }
  }
  return { flags, prompt: positional.join(' ').trim() };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }

  const { flags, prompt } = parsed;
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }

  // Must happen before the session starts: the Agent SDK spawns Claude Code as
  // a subprocess that inherits this process's environment, and that is how the
  // local endpoint reaches it.
  if (flags.local) {
    const { enableLocalModel, LOCAL_MODEL } = await import('../src/local.js');
    try {
      const where = await enableLocalModel({ log: (line) => process.stderr.write(`${line}\n`) });
      if (!flags.quiet) process.stderr.write(`jarvis: local model — ${where}\n`);
    } catch (error) {
      process.stderr.write(`jarvis --local: ${error.message}\n`);
      process.exit(2);
    }
    if (!flags.model) flags.model = LOCAL_MODEL;
  }

  const overrides = {};
  if (flags.model) overrides.model = flags.model;
  if (flags.effort) overrides.effort = flags.effort;
  if (flags.cwd) overrides.cwd = path.resolve(flags.cwd);
  if (flags.theme) overrides.ui = { theme: flags.theme };
  if (flags.voice) overrides.voice = { output: true };
  if (flags.awareness) overrides.awareness = { enabled: true };
  if (flags.autopilot) overrides.autopilot = true;

  const config = loadConfig(overrides);

  if (flags.serve) {
    const { serve } = await import('../src/serve.js');
    await serve({
      config,
      idleSeconds: Number.isFinite(flags.idle) ? flags.idle : 600,
      permissionSeconds: Number.isFinite(flags.permissionSeconds) ? flags.permissionSeconds : 120,
    });
    return;
  }

  if (prompt) {
    const { runOnce } = await import('../src/oneshot.js');
    const code = await runOnce(prompt, {
      config,
      resume: flags.resume,
      // Autopilot implies --yes; it additionally answers the model's questions.
      yes: flags.yes || config.autopilot,
      quiet: flags.quiet,
    });
    process.exit(code);
  }

  // Interactive: compile the JSX (only when it changed), then hand over.
  const bundle = await buildUI();
  const { start } = await import(pathToFileURL(bundle).href);
  await start({ config, resume: flags.resume });
  // The SDK keeps a child process and stdin listeners alive, so unmounting the
  // UI is not enough to end the process on its own.
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
