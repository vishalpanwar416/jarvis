// Ambient awareness: the small live panel of context that sits above the chat.
//
// Built-ins are below; anything else you want is a one-line shell probe in
// jarvis.config.json:
//   { "label": "crons", "command": "hermes jobs --count" }
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function sh(command, cwd, timeout = 2500) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { cwd, timeout, maxBuffer: 1024 * 256 }, (error, stdout) => {
      resolve(error ? '' : String(stdout).trim());
    });
  });
}

const BUILTINS = {
  clock: async () => ({
    label: 'time',
    value: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  }),

  cwd: async (config) => ({
    label: 'cwd',
    value: config.cwd.replace(os.homedir(), '~'),
  }),

  git: async (config) => {
    if (!fs.existsSync(path.join(config.cwd, '.git'))) return null;
    const branch = await sh('git rev-parse --abbrev-ref HEAD', config.cwd);
    if (!branch) return null;
    const status = await sh('git status --porcelain', config.cwd);
    const dirty = status ? status.split('\n').length : 0;
    const ahead = await sh('git rev-list --count @{u}..HEAD 2>/dev/null', config.cwd);
    const bits = [branch];
    if (dirty) bits.push(`${dirty} changed`);
    if (ahead && ahead !== '0') bits.push(`${ahead} ahead`);
    return { label: 'git', value: bits.join(' · '), tone: dirty ? 'warn' : 'ok' };
  },

  system: async () => {
    const [load] = os.loadavg();
    const usedGb = (os.totalmem() - os.freemem()) / 1024 ** 3;
    const totalGb = os.totalmem() / 1024 ** 3;
    const pressure = load / Math.max(os.cpus().length, 1);
    return {
      label: 'host',
      value: `load ${load.toFixed(2)} · mem ${usedGb.toFixed(1)}/${totalGb.toFixed(0)}G`,
      tone: pressure > 0.9 ? 'warn' : 'dim',
    };
  },
};

export function createAwareness(config) {
  return {
    async collect() {
      const jobs = [];
      for (const name of config.awareness.builtins ?? []) {
        if (BUILTINS[name]) jobs.push(BUILTINS[name](config));
      }
      for (const probe of config.awareness.probes ?? []) {
        jobs.push(
          sh(probe.command, probe.cwd ?? config.cwd).then((value) =>
            value ? { label: probe.label, value: value.split('\n')[0].slice(0, 120), tone: probe.tone } : null,
          ),
        );
      }
      const rows = await Promise.all(jobs);
      return rows.filter(Boolean);
    },
  };
}
