// `jarvis --local`: run the whole agent against a model on this machine.
//
// The Agent SDK spawns Claude Code as a subprocess and, because we never pass
// an `env` option to query(), that subprocess inherits process.env. So pointing
// jarvis at a local model is just a matter of setting the same variables Claude
// Code itself honours — ANTHROPIC_BASE_URL and friends — before the session
// starts. No SDK option, no fork.
//
// What sits at that base URL is a LiteLLM proxy: the SDK speaks Anthropic's
// /v1/messages, Ollama speaks OpenAI's /v1/chat/completions, and LiteLLM
// translates between them. See local-llm.config.yaml.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const LOCAL_MODEL = 'local';           // the model_name in the yaml
const HOME = process.env.HOME ?? '';
const STATE_DIR = process.env.JARVIS_LOCAL_DIR || path.join(HOME, '.local/share/jarvis-local');
const LITELLM = path.join(STATE_DIR, 'venv/bin/litellm');
const CONFIG = path.join(REPO_ROOT, 'local-llm.config.yaml');
const LOG = path.join(STATE_DIR, 'proxy.log');
const STAMP = path.join(STATE_DIR, 'proxy.json');   // {pid, configHash} of the proxy we started
const PORT = Number(process.env.JARVIS_LOCAL_PORT || 4000);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OLLAMA_URL = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const KEY = 'sk-jarvis-local';                // matches master_key in the yaml

// Loading several GB of weights off disk on the first request is slow, and the
// proxy itself takes a few seconds to bind.
const PROXY_READY_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reachable(url, ms = 1500) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function ollamaModels() {
  try {
    // Same abort as reachable(): a host that drops packets rather than
    // refusing (suspended box, stale VPN route) would otherwise hang here
    // instead of reaching the "Ollama is not answering" message below.
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const body = await response.json();
    return (body.models ?? []).map((m) => m.name);
  } catch {
    return null;
  }
}

/** The model behind `local` in the yaml, so errors can name it. */
function configuredModel() {
  try {
    const text = fs.readFileSync(CONFIG, 'utf8');
    return text.match(/^\s*model:\s*ollama(?:_chat)?\/(\S+)/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

function configHash() {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(CONFIG)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

function readStamp() {
  try {
    return JSON.parse(fs.readFileSync(STAMP, 'utf8'));
  } catch {
    return null;
  }
}

function startProxy() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const out = fs.openSync(LOG, 'a');
  // Detached so the proxy outlives this jarvis run — the next one reuses it
  // instead of paying the startup cost again.
  const child = spawn(LITELLM, ['--config', CONFIG, '--port', String(PORT), '--host', '127.0.0.1'], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  fs.closeSync(out);      // the child holds its own copy of the descriptor
  try {
    fs.writeFileSync(STAMP, JSON.stringify({ pid: child.pid, configHash: configHash() }));
  } catch {
    // not fatal; it only costs us the staleness check next time
  }
  return child;
}

// The stamp outlives reboots, by which time its pid belongs to something else
// entirely — so never signal a pid without checking it is still a litellm.
function isProxyPid(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('litellm');
  } catch {
    return false;                 // gone, or not ours to read
  }
}

// A proxy started before the config was edited keeps serving the old model,
// and nothing downstream can tell: the name it advertises ("local") does not
// change. Stop it so the caller starts a fresh one. Only ever touches a proxy
// this code started — one launched by hand has no stamp and is left alone.
function stopIfStale() {
  const stamp = readStamp();
  if (!stamp?.pid || stamp.configHash === configHash()) return false;
  if (!isProxyPid(stamp.pid)) {
    try {
      fs.unlinkSync(STAMP);       // stale stamp for a pid that is now someone else
    } catch {
      // ignore
    }
    return false;
  }
  try {
    process.kill(stamp.pid, 'SIGTERM');
  } catch {
    return false;                 // already gone
  }
  try {
    fs.unlinkSync(STAMP);
  } catch {
    // ignore
  }
  return true;
}

async function waitForProxy(deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (await reachable(`${BASE_URL}/health/liveliness`)) return true;
    await sleep(500);
  }
  return false;
}

/**
 * Make this process (and therefore the Claude Code subprocess it spawns) talk
 * to the local model. Returns a short line describing what was set up.
 * Throws with an actionable message when a prerequisite is missing.
 */
export async function enableLocalModel({ log = () => {} } = {}) {
  const model = configuredModel();

  const installed = await ollamaModels();
  if (installed === null)
    throw new Error(`Ollama is not answering at ${OLLAMA_URL}. Start it with: systemctl start ollama`);
  if (model && !installed.includes(model) && !installed.includes(`${model}:latest`))
    throw new Error(`Ollama does not have ${model}. Pull it with: ollama pull ${model}`);

  if (!fs.existsSync(LITELLM))
    throw new Error(
      `The local proxy is not installed. While you still have network, run:\n` +
      `  python3 -m venv ${path.join(STATE_DIR, 'venv')}\n` +
      `  ${path.join(STATE_DIR, 'venv/bin/pip')} install "litellm[proxy]"`,
    );

  // Edited the yaml since the running proxy started? It would keep serving the
  // old model without saying so.
  const stale = stopIfStale();
  if (stale) {
    log('local-llm.config.yaml changed — restarting the proxy …');
    const until = Date.now() + 15_000;
    while (Date.now() < until && (await reachable(`${BASE_URL}/health/liveliness`)))
      await sleep(300);           // wait for it to let go of the port
    // Starting a second one now would fail to bind and die, and waitForProxy
    // cannot tell the survivor apart from a fresh process — it would report
    // success while the old model kept answering. Refuse instead.
    if (await reachable(`${BASE_URL}/health/liveliness`))
      throw new Error(`The previous proxy is still holding port ${PORT}. Stop it and run again (check ${LOG}).`);
  }

  let started = false;
  if (stale || !(await reachable(`${BASE_URL}/health/liveliness`))) {
    if (!stale) log(`starting local model proxy on ${BASE_URL} …`);
    startProxy();
    started = true;
    if (!(await waitForProxy(PROXY_READY_TIMEOUT_MS)))
      throw new Error(`The proxy did not come up within 60s. Check ${LOG}`);
  }

  // Everything the harness might reach for. The aliases matter because the
  // agent loop picks a "small fast" model for some internal work; without
  // these it would try to reach Anthropic for those calls and hang offline.
  const env = {
    ANTHROPIC_BASE_URL: BASE_URL,
    ANTHROPIC_AUTH_TOKEN: KEY,
    ANTHROPIC_API_KEY: KEY,
    ANTHROPIC_MODEL: LOCAL_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: LOCAL_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: LOCAL_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: LOCAL_MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: LOCAL_MODEL,
    // Nothing should try to phone home while the point is to be offline.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  Object.assign(process.env, env);

  const how = stale ? 'proxy restarted for the new config' : started ? 'proxy started' : 'proxy already running';
  return `${model ?? LOCAL_MODEL} via ${BASE_URL} (${how})`;
}

export const localPaths = { STATE_DIR, LITELLM, CONFIG, LOG, BASE_URL, PORT };
