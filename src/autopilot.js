// Autopilot: the "yes to everything" mode.
//
// While armed, jarvis answers on your behalf instead of stopping:
//   - every permission prompt is allowed
//   - every question the model asks (AskUserQuestion) gets its recommended
//     option, or the first one if nothing is marked recommended
//   - every picker a command opens resolves to its recommended/current/first row
// The model is also told to stop asking and choose the recommended path itself.
// Shared by the interactive UI and one-shot mode so the two can't drift.

const RECOMMENDED = /\(recommended\)/i;

// The row a picker or question would land on if you just pressed enter with
// good judgement: explicitly recommended, else the one already in use, else first.
export function pickRecommended(items = []) {
  if (!items.length) return null;
  return (
    items.find((item) => item.recommended || RECOMMENDED.test(item.label ?? '')) ??
    items.find((item) => item.current) ??
    items[0]
  );
}

// AskUserQuestion is answered through the permission callback: allow it with
// `answers` filled in, keyed by question text. Multi-select is comma-separated.
export function answerQuestions(input = {}) {
  const answers = {};
  for (const question of input.questions ?? []) {
    const choice = pickRecommended(question.options ?? []);
    if (choice) answers[question.question] = choice.label;
  }
  return answers;
}

// What canUseTool returns for any tool while autopilot is on.
export function autopilotDecision(toolName, input) {
  if (toolName === 'AskUserQuestion') {
    return { behavior: 'allow', updatedInput: { ...input, answers: answerQuestions(input) } };
  }
  return { behavior: 'allow' };
}

// One line for the transcript describing what autopilot just decided.
export function describeAnswers(answers) {
  const entries = Object.values(answers ?? {});
  return entries.length ? `autopilot answered: ${entries.join(' · ')}` : 'autopilot allowed';
}

// Appended to the system prompt when autopilot is armed at launch, and sent
// with each message when it is switched on mid-session.
export function autopilotPersona() {
  return [
    'Autopilot is on. The user has delegated every decision to you for now.',
    'Do not ask questions or wait for confirmation; state the assumption you are making in one line and proceed.',
    'When there are options, take the one you would recommend, say which, and continue.',
    'Finish the whole task. Only stop for something destructive and irreversible outside the scope of the request.',
  ].join(' ');
}

// The bracketed prefix used when the system prompt was built without autopilot.
export function autopilotPrefix() {
  return `[autopilot] ${autopilotPersona()}`;
}
