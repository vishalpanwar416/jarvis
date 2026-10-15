// Where the work already is, said once at the top of a conversation.
//
// A session used to open knowing sixty project paths and nothing about
// which one you are standing in. That is backwards: the first thing worth
// saying is the smallest — this project, this branch, what was being done
// here, what you last asked. Everything else is a tool call away.
//
// All of it is derived. Nothing here is written by the model or typed by a
// person, so none of it can be stale in the way a note can be stale: if the
// branch changed, this says the new branch.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadIndex, projectAt } from './memory.js';
import { readEntries, digest } from './ledger.js';

const FILES_NAMED = 3;      // last touched, before the line gets long
const ALSO_NAMED = 4;       // other projects worked in today

// Short, quiet, and never fatal: a working set that throws is worse than a
// working set that is missing a line.
function git(args, cwd) {
  try {
    return execFileSync('git', ['-C', cwd, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
  } catch {
    return '';
  }
}

// Branch, how much is uncommitted, how much is unpushed, and what the last
// commit was about — the four things you would look at yourself before
// answering a question about a repo.
export function gitFacts(root) {
  if (!fs.existsSync(path.join(root, '.git'))) return null;
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  if (!branch) return null;
  const status = git(['status', '--porcelain'], root);
  const ahead = git(['rev-list', '--count', '@{u}..HEAD'], root);
  return {
    branch,
    dirty: status ? status.split('\n').filter(Boolean).length : 0,
    ahead: Number(ahead) || 0,
    subject: git(['log', '-1', '--pretty=%s'], root),
  };
}

const tilde = (dir) => dir.replace(os.homedir(), '~');

function gitLine({ branch, dirty, ahead, subject }) {
  const bits = [branch];
  if (dirty) bits.push(`${dirty} uncommitted`);
  if (ahead) bits.push(`${ahead} unpushed`);
  const line = `git: ${bits.join(' · ')}`;
  return subject ? `${line} — last commit "${subject}"` : line;
}

// "12 edits, 4 commands (2 failed)" — plural-correct, and silent about the
// parts that are zero, because "0 failed" reads as a thing worth noting.
//
// Named rather than called "here", because the project in view is not
// always the one the working directory is in.
function workLine({ edits, commands, failed, files }, days, name) {
  const parts = [];
  if (edits) parts.push(`${edits} file edit${edits === 1 ? '' : 's'}`);
  if (commands) parts.push(`${commands} command${commands === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}`);
  if (!parts.length) return '';
  const span = days === 1 ? 'today' : `over the last ${days} days`;
  const named = files.slice(0, FILES_NAMED);
  return `in ${name} ${span}: ${parts.join(', ')}` + (named.length ? `; last touched ${named.join(', ')}` : '');
}

// The project the work has lately been in, for when the working directory
// does not name one — running from a home directory is the ordinary case,
// not an edge one. readEntries is oldest first, so the last tag wins.
function recentProject(days) {
  let name = '';
  for (const entry of readEntries({ days })) if (entry.project) name = entry.project;
  return name;
}

// The block that goes at the top of the system prompt. Returns '' when
// there is genuinely nothing to say — an empty heading is worse than no
// heading, and this is paid for on every turn of the conversation.
export function workingSetBlock(config, { maxChars = 1200, now = new Date() } = {}) {
  const cwd = config.cwd ?? process.cwd();
  const here = projectAt(cwd);
  const days = config.ledger?.recentDays ?? 5;
  const onLedger = config.ledger?.enabled !== false;
  const indexed = (name) => loadIndex().projects.find((project) => project.name === name) ?? null;

  // What the conversation is about. The working directory when it names a
  // project; otherwise whatever the recent work was in, which is the only
  // answer available when this is run from a home directory.
  // A project the index has not seen still has a name worth saying, even
  // though its path and description are unknown — the name is most of what
  // orientation needs.
  const recent = here || !onLedger ? '' : recentProject(days);
  const lately = recent ? indexed(recent) ?? { name: recent, path: '', what: '' } : null;
  const focus = here ?? lately;
  const root = focus?.path || cwd;
  const lines = [];

  if (here) {
    const known = indexed(here.name);
    const what = known?.what ? ` — ${known.what.slice(0, 80)}` : '';
    lines.push(`- in ${here.name} — ${tilde(here.path)}${what}`);
    if (cwd !== here.path) lines.push(`- working inside ${path.relative(here.path, cwd)}`);
  } else {
    lines.push(`- in ${tilde(cwd)}, which is not inside a project`);
    if (lately) {
      const where = lately.path ? ` — ${tilde(lately.path)}` : '';
      const what = lately.what ? ` — ${lately.what.slice(0, 80)}` : '';
      lines.push(`- the work lately has been in ${lately.name}${where}${what}`);
    }
  }

  const facts = gitFacts(root);
  if (facts) lines.push(`- ${gitLine(facts)}`);

  if (onLedger) {
    // Only when there is a project to scope it to. An unscoped read would
    // answer "what were we doing?" with work done somewhere else entirely.
    if (focus) {
      const mine = digest(readEntries({ days, project: focus.name }));
      const work = workLine(mine, days, focus.name);
      if (work) lines.push(`- ${work}`);
      if (mine.lastAsk) lines.push(`- last asked in ${focus.name}: "${mine.lastAsk}"`);
    }

    // Where else the day went. Named, not described: it is orientation, and
    // anything more is a question they can ask.
    const elsewhere = [];
    for (const entry of readEntries({ days: 1 })) {
      if (!entry.project || entry.project === focus?.name) continue;
      if (!elsewhere.includes(entry.project)) elsewhere.push(entry.project);
    }
    if (elsewhere.length) lines.push(`- also worked in today: ${elsewhere.slice(0, ALSO_NAMED).join(', ')}`);
  }

  // Naming the project is worth a heading on its own: it carries the root
  // path and the name things get called, which a bare cwd does not. A cwd
  // inside no project and nothing else to say is the one case worth
  // suppressing — the shell already said that much.
  if (!focus && lines.length < 2) return '';

  const head = `Where this conversation is happening, as of ${now.toISOString().slice(0, 16).replace('T', ' ')}:`;
  const tail = 'This is derived, not remembered, so trust it over anything older that disagrees.';
  const block = [head, ...lines, tail].join('\n');
  return block.length > maxChars ? `${block.slice(0, maxChars - 1)}…` : block;
}
