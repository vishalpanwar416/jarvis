// Non-interactive mode: `jarvis "do the thing"`.
//
// No Ink, no React — just the same session streamed to stdout with the theme's
// colours, so it stays usable from cron and pipes.
import { JarvisSession, isPreApproved } from './agent.js';
import { buildAutomationServer } from './automations.js';
import { loadTheme } from './config.js';
import { Voice } from './voice.js';
import { summarize } from './summarize.js';
import { autopilotDecision, describeAnswers } from './autopilot.js';

function ansi(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!match) return '';
  const value = parseInt(match[1], 16);
  return `\x1b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`;
}

export async function runOnce(prompt, { config, resume, yes = false, quiet = false }) {
  const theme = loadTheme(config.ui.theme);
  const paint = (tone, text) => (process.stdout.isTTY ? `${ansi(theme.colors[tone])}${text}\x1b[0m` : text);
  const write = (text) => process.stdout.write(text);
  const log = (text) => {
    if (!quiet) process.stderr.write(`${text}\n`);
  };

  const automationServer = buildAutomationServer(config);
  const voice = config.voice.output ? new Voice(config) : null;
  let denied = 0;
  let streamed = false;

  const session = new JarvisSession({
    // Autopilot approves through the callback below, not bypassPermissions —
    // the SDK skips the callback entirely under bypass, and we need it to
    // answer questions.
    config: { ...config, permissionMode: yes && !config.autopilot ? 'bypassPermissions' : config.permissionMode },
    mcpServers: automationServer ? { automations: automationServer } : {},
    // Nobody is watching to answer a prompt here, so anything not pre-approved
    // is refused with a reason the model can work around — unless --yes.
    // Autopilot goes further and answers the model's questions too, with the
    // recommended option, so a run never stalls on AskUserQuestion.
    canUseTool: config.autopilot
      ? async (toolName, input) => {
          const decision = autopilotDecision(toolName, input);
          if (toolName === 'AskUserQuestion') log(paint('warn', `  ${describeAnswers(decision.updatedInput?.answers)}`));
          return decision;
        }
      : yes
      ? undefined
      : async (toolName) => {
          if (isPreApproved(config, toolName)) return { behavior: 'allow' };
          denied += 1;
          log(paint('warn', `  denied ${toolName} (re-run with --yes to allow)`));
          return { behavior: 'deny', message: `${toolName} is not permitted in non-interactive mode.` };
        },
    resume,
  });

  return new Promise((resolve) => {
    session.on('event', (event) => {
      switch (event.kind) {
        case 'tool-start':
          log(paint('tool', `  ${theme.glyphs.tool} ${event.name} ${summarize(event.input)}`));
          break;

        case 'delta':
          streamed = true;
          write(paint('assistant', event.text));
          break;

        case 'assistant':
          // If the CLI produced no token deltas, print the finished text instead.
          if (!streamed) write(paint('assistant', `${event.text}\n`));
          else write('\n');
          streamed = false;
          break;

        case 'error':
          process.stderr.write(`${paint('err', `${theme.glyphs.err} ${event.text}`)}\n`);
          break;

        case 'result': {
          const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = event.totals;
          const totalIn = inputTokens + cacheReadTokens + cacheWriteTokens;
          log(
            paint(
              'dim',
              `  ${(event.durationMs / 1000).toFixed(1)}s · ${totalIn} in / ${outputTokens} out` +
                (denied ? ` · ${denied} tool call(s) denied` : ''),
            ),
          );
          if (voice) voice.speak(event.text || '');
          session.close();
          resolve(event.isError ? 1 : 0);
          break;
        }

        default:
          break;
      }
    });

    session.start();
    session.send(prompt);
  });
}
