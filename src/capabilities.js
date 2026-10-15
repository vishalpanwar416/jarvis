// What Jarvis can actually do on this machine, as distinct from in general.
//
// The model knows it has Read, Write and Bash — the Claude Code preset says
// so. What it cannot know is anything about the particular desktop it has
// been started on: whether a screenshot is possible here, whether there is
// a synthesizer to speak through, whether the question it is reading was
// typed or dictated, and what shell tasks this person has already set up.
//
// Getting that wrong has a specific failure mode, which is the reason this
// exists: offering to do something the machine cannot do. "Shall I read
// that out?" on a host with no synthesizer is worse than not offering, and
// the model has no way to find out by itself short of trying.
//
// Every line is derived from the same detection the features themselves
// use, so this cannot claim a capability that will then fail.
import { detectBackends as screenBackends, captureBlocker } from './screen.js';
import { detectBackends as voiceBackends } from './voice.js';

// The facts, before they are turned into sentences. Separate so what is
// true can be tested without matching on prose.
export function capabilities(config = {}) {
  const screen = config.screen ?? {};
  const enabled = screen.enabled !== false;
  const found = enabled ? screenBackends(config) : null;
  const sight = {
    enabled,
    how: found?.capture ?? null,
    // Switched off is not the same as impossible, and the difference
    // matters: one of them is a setting they can change.
    blocker: enabled ? captureBlocker(found) : 'the look tool is switched off in the config',
  };

  // voice.detectBackends reaches into config.voice without checking, and
  // a config without a voice section is a perfectly ordinary thing here.
  const heard = config.voice ? voiceBackends(config) : null;

  return {
    sight,
    speech: { how: heard?.tts ?? null },
    dictation: { how: heard?.recorder && (heard.stream || heard.stt) ? heard.recorder : null },
    automations: (config.automations ?? []).map((task) => task?.name).filter(Boolean),
  };
}

// The block appended to the system prompt. Short, and mostly about what is
// *not* possible: the model will assume it can do the ordinary things, and
// only needs telling where this machine differs.
export function capabilityBlock(config = {}) {
  const { sight, speech, dictation, automations } = capabilities(config);
  const lines = [];

  if (sight.how) {
    lines.push(`- You can see the screen: the look tool captures it with ${sight.how}, shows you the ` +
      'image, and deletes it. Use it when a question is about what is on screen rather than on disk.');
  } else {
    lines.push(`- You cannot see the screen here — ${sight.blocker}. Say so if asked; do not ` +
      'work around it by reading files and guessing what is displayed.');
  }

  if (speech.how) {
    lines.push(`- Replies can be read aloud, through ${speech.how}, when speech is turned on. It is ` +
      'off unless a turn says otherwise, so write for the screen by default.');
  } else {
    lines.push('- Nothing on this machine can speak: there is no synthesizer installed. Never offer ' +
      'to read something out, and never ask whether they would like to hear it.');
  }

  // Worth a line only when true. That a question may have been dictated
  // explains a misheard word better than assuming a typing slip, and is
  // the sort of thing that silently changes how a sentence should be read.
  if (dictation.how) {
    lines.push('- Questions may arrive dictated rather than typed, so an odd word may be a ' +
      'mishearing. Read for what was meant and carry on; ask only if the meaning turns on it.');
  }

  if (automations.length) {
    lines.push(`- Shell tasks already set up here, as tools and as /run: ${automations.join(', ')}. ` +
      'Prefer one of these to improvising the same job with Bash — they are how this person ' +
      'has decided it should be done.');
  }

  return ['What you can do on this machine, which is not the same as what you can do in general:',
    ...lines].join('\n');
}
