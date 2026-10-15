// Slash commands. Each handler gets an `api` the UI provides, so adding a
// command means adding one entry here — no UI changes.
import { listThemes } from './config.js';
import { findAutomation, execute } from './automations.js';
import { listModels, resolveModel, describeModel } from './models.js';

// `on` and `off` are the only words these take; bare toggles. Anything else is
// a typo, and reading it as "off" — which `arg === 'on'` quietly does — turns a
// feature off while looking for all the world like it obeyed you.
function toggleArg(arg, current) {
  if (!arg) return !current;
  const word = arg.toLowerCase();
  if (word === 'on') return true;
  if (word === 'off') return false;
  return null;
}

export const COMMANDS = {
  help: {
    help: 'show this list',
    run: (_args, api) => {
      const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
      const lines = Object.entries(COMMANDS).map(([name, cmd]) => `/${name.padEnd(width)}  ${cmd.help}`);
      api.note(
        [
          ...lines,
          '',
          'type / to filter this list · tab completes · enter runs the highlighted one',
          '',
          'keys   enter send · esc interrupt · ctrl+p autopilot · ctrl+a awareness',
          '       ctrl+o speech · ctrl+t talk · ctrl+h hands-free · ctrl+l clear · ctrl+c quit',
        ].join('\n'),
      );
    },
  },

  voice: {
    help: 'speech out on|off (bare toggles)',
    run: ([arg], api) => {
      const blocker = api.voice.speakBlocker();
      if (blocker) return api.error(`speech out unavailable: ${blocker}`);
      const next = toggleArg(arg, api.state.voiceOut);
      if (next === null) return api.error(`usage: /voice on|off (bare toggles) — got "${arg}"`);
      api.setVoiceOut(next);
      api.note(`speech out ${next ? 'on' : 'off'}`);
    },
  },

  listen: {
    help: 'hands-free listening on|off (bare reports what speech input can do)',
    run: ([arg], api) => {
      const blocker = api.voice.listenBlocker();
      if (blocker) return api.error(`speech in unavailable: ${blocker}`);
      const { recorder, stream, stt } = api.voice.backends;

      if (arg) {
        const next = toggleArg(arg, api.state.handsFree);
        if (next === null) return api.error(`usage: /listen on|off (bare reports) — got "${arg}"`);
        if (next && !api.voice.canHandsFree) {
          return api.error('hands-free needs a streaming transcriber and voice.vad.enabled');
        }
        api.setHandsFree(next);
        if (!next) api.note('hands-free off');
        return;
      }

      const vad = api.voice.vadSettings();
      if (!stream) {
        return api.note(`speech in ready (${recorder} → ${stt}), transcribed after the take · ctrl+t to talk`);
      }
      api.note(
        [
          `live dictation ready (${recorder} → ${stream})`,
          vad.enabled
            ? `takes end themselves after ${vad.silenceMs}ms of silence · ctrl+t to talk, esc to discard`
            : 'detection off (voice.vad.enabled) · ctrl+t starts and stops a take',
          api.voice.canHandsFree
            ? `hands-free ${api.state.handsFree ? 'on' : 'off'} · ctrl+h, or /listen on — no keys per sentence`
            : 'hands-free unavailable while voice.vad.enabled is false',
        ].join('\n'),
      );
    },
  },

  look: {
    help: 'have a look at the screen: /look [what to look for] (add window for just the front one)',
    run: (args, api) => {
      const blocker = api.screen.blocker();
      if (blocker) return api.error(`cannot see the screen: ${blocker}`);
      // A bare /look is "what am I looking at"; anything after it is the
      // question to answer about the screen. Either way the model is the one
      // that calls the tool — this only says what to look at and why, so the
      // answer is a sentence about the screen rather than a raw screenshot.
      const window = args[0]?.toLowerCase() === 'window';
      const rest = (window ? args.slice(1) : args).join(' ').trim();
      api.ask(
        `Look at ${window ? 'the window in front' : 'my screen'} with the look tool` +
          `${window ? ' (target "window")' : ''}, then ${rest || 'tell me what is on it'}.`,
      );
    },
  },

  autopilot: {
    help: 'answer every prompt, question and picker yourself: on|off (bare toggles)',
    run: ([arg], api) => {
      const next = toggleArg(arg, api.state.autopilot);
      if (next === null) return api.error(`usage: /autopilot on|off (bare toggles) — got "${arg}"`);
      api.setAutopilot(next);
      api.note(next ? 'autopilot on — every prompt, question and picker answers itself · ctrl+p to disarm' : 'autopilot off');
    },
  },

  awareness: {
    help: 'ambient panel on|off (bare toggles)',
    run: ([arg], api) => {
      const next = toggleArg(arg, api.state.awareness);
      if (next === null) return api.error(`usage: /awareness on|off (bare toggles) — got "${arg}"`);
      api.setAwareness(next);
      api.note(`awareness ${next ? 'on' : 'off'}`);
    },
  },

  automations: {
    help: 'list configured automations',
    run: (_args, api) => {
      const list = api.config.automations ?? [];
      if (!list.length) return api.note('no automations configured — add some to jarvis.config.json');
      api.note(list.map((item) => `${item.name}  ${item.description ?? ''}`).join('\n'));
    },
  },

  run: {
    help: 'run an automation now: /run <name> [args…]',
    run: async ([name, ...rest], api) => {
      if (!name) return api.error('usage: /run <name>');
      const automation = findAutomation(api.config, name);
      if (!automation) return api.error(`no automation named "${name}"`);

      const args = {};
      (automation.args ?? []).forEach((arg, index) => {
        args[arg.name] = rest[index];
      });

      api.note(`running ${name}…`);
      const result = await execute(automation, args, { cwd: api.config.cwd });
      const body = [result.stdout, result.stderr].filter(Boolean).join('\n');
      if (result.ok) api.note(body || `${name} finished`);
      else api.error(`${name} exited ${result.code}\n${body}`);
    },
  },

  model: {
    help: 'show or switch the model (bare opens a picker)',
    run: async ([name], api) => {
      const models = listModels(api.config);
      const current = api.config.model;

      if (!name) {
        return api.pick({
          title: 'model',
          hint: `in use: ${describeModel(models, current)}`,
          items: models.map((model) => ({
            id: model.id,
            label: model.label,
            note: model.note,
            current: model.id === current,
          })),
          onSelect: (item) => switchModel(item.id, api),
        });
      }

      const wanted = resolveModel(models, name);
      if (!wanted) return api.error(`unknown model "${name}" — run /model for the list`);
      await switchModel(wanted.id, api);
    },
  },

  permissions: {
    help: 'set permission mode: default | acceptEdits | bypassPermissions',
    run: async ([mode], api) => {
      if (!mode) return api.note(`permission mode is ${api.config.permissionMode}`);
      await api.session.setPermissionMode(mode);
      api.setPermissionMode(mode);
      api.note(`permissions → ${mode}`);
    },
  },

  theme: {
    help: 'switch theme: /theme amber (bare lists)',
    run: ([name], api) => {
      if (!name) return api.note(`themes: ${listThemes().join(', ')}`);
      try {
        api.setTheme(name);
        api.note(`theme → ${name}`);
      } catch (error) {
        api.error(error.message);
      }
    },
  },

  usage: {
    help: 'token usage this session',
    run: (_args, api) => {
      const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, turns } = api.session.totals;
      api.note(
        `${turns} turns · ${inputTokens} in / ${outputTokens} out\n` +
          `cache ${cacheReadTokens} read / ${cacheWriteTokens} written`,
      );
    },
  },

  session: {
    help: 'show the session id (use it with --resume)',
    run: (_args, api) => api.note(api.session.sessionId ?? 'not started yet'),
  },

  clear: { help: 'clear the screen', run: (_args, api) => api.clear() },
  quit: { help: 'exit', run: (_args, api) => api.quit() },
};

// The switch has to land in three places: the live SDK query, the config the UI
// renders from, and the transcript.
async function switchModel(id, api) {
  if (id === api.config.model) return api.note(`already on ${id}`);
  await api.session.setModel(id);
  api.setModel(id);
  api.note(`model → ${id}`);
}

export async function runCommand(raw, api) {
  const [name, ...args] = raw.slice(1).trim().split(/\s+/);
  const command = COMMANDS[name];
  if (!command) return api.error(`unknown command /${name} — try /help`);
  try {
    await command.run(args, api);
  } catch (error) {
    api.error(String(error?.message ?? error));
  }
}
