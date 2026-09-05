// The models /model offers. Prices are per million tokens, input/output.
//
// This list is a convenience, not a whitelist: resolve() accepts any id that
// looks like one, so a model released after this file was written still works
// with `/model <its-id>`. Override the list entirely with "models" in
// jarvis.config.json.
export const MODELS = [
  {
    id: 'claude-fable-5-1',
    label: 'Fable 5.1',
    aliases: ['fable'],
    note: '1M ctx · $10/$50 · most capable, slowest',
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    aliases: ['opus'],
    note: '1M ctx · $5/$25 · deep reasoning',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    aliases: ['sonnet'],
    note: '1M ctx · $2/$10 · balanced',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    aliases: ['haiku'],
    note: '200K ctx · $1/$5 · quickest, cheapest',
  },
];

function normalize(entry) {
  const model = typeof entry === 'string' ? { id: entry } : entry;
  return {
    aliases: [],
    note: '',
    ...model,
    label: model.label ?? model.id,
  };
}

export function listModels(config) {
  const list = config?.models?.length ? config.models : MODELS;
  return list.map(normalize);
}

// Anything with a dash is taken at face value so a brand-new id still works.
function looksLikeAModelId(name) {
  return /^[a-z0-9]+(-[a-z0-9.]+)+$/i.test(name);
}

export function resolveModel(models, name) {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;

  const match =
    models.find((model) => model.id.toLowerCase() === wanted) ??
    models.find((model) => model.aliases.some((alias) => alias.toLowerCase() === wanted)) ??
    models.find((model) => model.label.toLowerCase() === wanted) ??
    models.find((model) => model.id.toLowerCase().startsWith(wanted)) ??
    models.find(
      (model) =>
        model.label.toLowerCase().startsWith(wanted) ||
        model.aliases.some((alias) => alias.toLowerCase().startsWith(wanted)),
    );

  if (match) return match;
  return looksLikeAModelId(wanted) ? normalize({ id: name.trim(), note: 'not in the list' }) : null;
}

// "Opus 5 · claude-opus-5 · 1M ctx · $5/$25 · deep reasoning"
export function describeModel(models, id) {
  const known = models.find((model) => model.id === id);
  if (!known) return id;
  return [known.label, known.id, known.note].filter(Boolean).join(' · ');
}
