// The tool Jarvis uses to look at the screen.
//
// Separate from screen.js for the same reason memory-tools is separate from
// memory: the capture can then be tested without the SDK anywhere near it.
//
// One tool, deliberately. "Take a screenshot and tell me what you see" is a
// single thing someone wants, and splitting it into capture / describe /
// discard would only invite the model to leave a picture of someone's desktop
// lying around between two of them.
import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Screen } from './screen.js';

export function buildScreenServer(config) {
  if (config.screen?.enabled === false) return null;
  const screen = new Screen(config);

  const tools = [
    tool(
      'look',
      'Look at what is on this machine\'s screen right now. Use it whenever the question is ' +
      'about what they are looking at — "what\'s on my screen", "what does this error say", ' +
      '"read this page", "is this the right branch", "what is this dialog asking me" — or ' +
      'when they point at something you cannot otherwise see. The screenshot is shown to you ' +
      'and deleted immediately; nothing is kept. Prefer target "window" when the question is ' +
      'about the thing they are working in, and "screen" when it is about the desktop as a ' +
      'whole or when you are not sure which window they mean.',
      {
        target: z
          .enum(['screen', 'window'])
          .optional()
          .describe('The whole screen (default), or just the window in front'),
        cursor: z
          .boolean()
          .optional()
          .describe('Include the mouse pointer — useful only when they are pointing at something'),
      },
      async ({ target = 'screen', cursor = false }) => {
        try {
          const shot = await screen.capture({ target, cursor });
          const size = shot.fullWidth ? `${shot.fullWidth}×${shot.fullHeight}` : 'unknown size';
          const shrunk = shot.width && shot.width !== shot.fullWidth ? `, shown to you at ${shot.width}px wide` : '';
          return {
            content: [
              { type: 'image', data: shot.data, mimeType: shot.mimeType },
              {
                type: 'text',
                text: `The ${target === 'window' ? 'window in front' : 'screen'} as it is now (${size}${shrunk}). ` +
                  'The image has been deleted. Answer from what you can actually see in it, and say so plainly ' +
                  'if it is too small to read or the thing they asked about is not in frame.',
              },
            ],
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Could not see the screen: ${error.message}` }],
            isError: true,
          };
        }
      },
      { annotations: { readOnlyHint: true, openWorldHint: false } },
    ),
  ];

  return createSdkMcpServer({
    name: 'screen',
    version: '1.0.0',
    instructions:
      'Jarvis can see this machine\'s screen. Look when the answer depends on what is actually ' +
      'there rather than on what you can read from disk — an error in a window, a page they are ' +
      'on, a dialog, a chart. Each look is one frame, deleted as soon as you have seen it, so ' +
      'look again rather than reasoning from a stale one.',
    tools,
  });
}

export const SCREEN_TOOLS = ['mcp__screen__look'];

// Looking is a read, and the screen is the one thing the person asking is
// already looking at — so by default it does not prompt: being asked
// "allow look?" after saying "what's on my screen" is friction for no gain.
//
// But a screenshot is not like reading a file the model named. It takes in
// whatever happens to be there — a password manager left open, someone's
// messages, a bank page — and the model may reach for it in the middle of
// some other task, when nobody is thinking about what is on screen. So this
// is a decision worth being able to reverse:
//
//   "screen": { "ask": true }      prompt before every look
//   "screen": { "enabled": false } no looking at all
export function screenToolsAllowedUnasked(config) {
  return config?.screen?.ask === true ? [] : SCREEN_TOOLS;
}
