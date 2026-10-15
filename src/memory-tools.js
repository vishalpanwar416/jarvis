// The tools Jarvis uses on its own memory.
//
// Separate from memory.js so the store can be read and tested without the
// SDK anywhere near it. These are deliberately few: a memory with a large
// API gets managed instead of used.
import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { remember, forget, loadIndex, findProjects } from './memory.js';

const text = (body, isError = false) => ({ content: [{ type: 'text', text: body }], isError });

export function buildMemoryServer() {
  const tools = [
    tool(
      'remember',
      'Keep one thing worth knowing next time: a decision, a preference, how a project is ' +
      'built or deployed, where something lives. One line. Say which project it is about if ' +
      'it is about one.',
      {
        note: z.string().describe('The thing to remember, in one line'),
        project: z.string().optional().describe('The project it concerns, if any'),
      },
      async ({ note, project }) => {
        const line = remember(note, project);
        return line ? text(`Remembered: ${line}`) : text('Nothing worth keeping in that.', true);
      },
      { annotations: { readOnlyHint: false } },
    ),

    tool(
      'forget',
      'Drop remembered notes containing some text. Use when something learned turns out to ' +
      'be wrong or has gone out of date.',
      { match: z.string().describe('Text the notes to drop contain') },
      async ({ match }) => {
        const gone = forget(match);
        return text(gone ? `Forgot ${gone} note${gone === 1 ? '' : 's'}.` : 'No note matched that.');
      },
      { annotations: { readOnlyHint: false } },
    ),

    tool(
      'projects',
      'Where the projects on this machine are. Call with a name to locate one, with no name ' +
      'for the list, or with refresh when something has been moved, renamed or newly cloned.',
      {
        name: z.string().optional().describe('A project name, or part of one'),
        refresh: z.boolean().optional().describe('Look at the disk again rather than trusting the index'),
      },
      async ({ name, refresh }) => {
        if (refresh) loadIndex({ refresh: true });
        if (name) {
          const hits = findProjects(name);
          if (!hits.length) return text(`Nothing here called "${name}". Try refresh if it is new.`, true);
          // Several can match — "sanero" is three of them. Hand back all of
          // them and let the answer ask which, rather than picking one.
          if (hits.length > 1) {
            return text([`${hits.length} projects match "${name}" — say which:`,
              ...hits.map((p) => `- ${p.name} — ${p.path}${p.what ? ` — ${p.what.slice(0, 60)}` : ''}`)].join('\n'));
          }
          const [hit] = hits;
          return text(`${hit.name} — ${hit.path}${hit.what ? `\n${hit.what}` : ''}${hit.remote ? `\n${hit.remote}` : ''}`);
        }
        const { projects, scannedAt } = loadIndex();
        return text([`${projects.length} projects, as of ${scannedAt.slice(0, 16).replace('T', ' ')}:`,
          ...projects.map((p) => `- ${p.name} — ${p.path}`)].join('\n'));
      },
      { annotations: { readOnlyHint: true } },
    ),
  ];

  return createSdkMcpServer({
    name: 'memory',
    version: '1.0.0',
    instructions:
      'What Jarvis knows between conversations: where this person\'s projects are, and what ' +
      'has been learned about them and about how they work. Remembering is cheap and quiet — ' +
      'do it when something would save a question next time, without announcing it.',
    tools,
  });
}

// Memory writes only ever touch Jarvis' own store under ~/.jarvis, never the
// user's files, so they are allowed even where nothing else may write.
export const MEMORY_TOOLS = [
  'mcp__memory__remember',
  'mcp__memory__forget',
  'mcp__memory__projects',
];
