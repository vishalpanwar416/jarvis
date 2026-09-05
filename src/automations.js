// Automations: shell tasks declared in jarvis.config.json.
//
// Each one becomes both a tool the model may call ("post to Sanero") and a
// `/run <name>` command you can fire directly. Arguments are substituted into
// the command as {{name}} and are shell-quoted, so a value containing spaces
// or quotes stays a single argument.
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function renderCommand(automation, args = {}) {
  return automation.command.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) =>
    key in args && args[key] !== undefined && args[key] !== '' ? shellQuote(args[key]) : '',
  );
}

export function execute(automation, args = {}, { cwd, timeoutMs = 10 * 60_000 } = {}) {
  const command = renderCommand(automation, args);
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', command],
      { cwd: automation.cwd ?? cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          command,
          code: error?.code ?? 0,
          ok: !error,
          stdout: String(stdout ?? '').trim(),
          stderr: String(stderr ?? '').trim(),
        });
      },
    );
  });
}

function schemaFor(automation) {
  const shape = {};
  for (const arg of automation.args ?? []) {
    const field = z.string().describe(arg.description ?? arg.name);
    shape[arg.name] = arg.required === false ? field.optional() : field;
  }
  return shape;
}

// Wraps every configured automation in one in-process MCP server. Tools show up
// to the model as mcp__automations__<name>.
export function buildAutomationServer(config) {
  const automations = config.automations ?? [];
  if (automations.length === 0) return null;

  const tools = automations.map((automation) =>
    tool(
      automation.name,
      automation.description ?? `Run the "${automation.name}" automation`,
      schemaFor(automation),
      async (args) => {
        const result = await execute(automation, args, { cwd: config.cwd });
        const body = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 20_000);
        return {
          content: [
            {
              type: 'text',
              text: result.ok
                ? body || `${automation.name} finished with no output.`
                : `${automation.name} exited ${result.code}\n${body}`,
            },
          ],
          isError: !result.ok,
        };
      },
      { annotations: { readOnlyHint: automation.readOnly === true } },
    ),
  );

  return createSdkMcpServer({
    name: 'automations',
    version: '1.0.0',
    instructions:
      'Personal automations for this machine. Call one when the user asks for that task by name or by intent.',
    tools,
  });
}

export function findAutomation(config, name) {
  return (config.automations ?? []).find((automation) => automation.name === name);
}
