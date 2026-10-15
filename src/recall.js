// Finding the thing that was already known.
//
// Memory puts a fixed block at the top of every session: the pinned notes,
// the recent projects, the newest handful of everything else. That block
// cannot grow — it is paid for on every turn — so most of what Jarvis knows
// is necessarily outside it. This is how the rest is reached.
//
// Lexical, not vector. The corpus here is a few hundred notes and a few
// thousand ledger lines, and at that size BM25 over the words actually
// written beats an embedding of them: it is exact about identifiers and
// filenames, which is most of what gets looked up, it needs no model, no
// network and no index to rebuild, and it answers in about a millisecond.
// The case for embeddings starts when the corpus is code rather than
// memory; see the note at the end of the README section.
import { parseNotes, loadIndex, projectAt } from './memory.js';
import { readEntries } from './ledger.js';

const K1 = 1.2;      // term-frequency saturation, the BM25 default
const B = 0.75;      // length normalisation, likewise
// Every gate below is scale-free, and deliberately so. BM25 scores depend
// on how big the corpus is — the same good hit scores 0.7 against four
// documents and 8 against a few thousand — so an absolute score threshold
// is a number that silently stops working as the store fills up. What a
// hit is judged on instead is its share of the best hit, how much of the
// question it accounts for, and whether what it matched was distinctive.
const RELATIVE = 0.3;        // below this share of the best hit it is noise
// How much of what was asked a document has to actually account for. BM25
// scores are not comparable between queries, so a bare score threshold is
// guesswork; the honest question is what share of the question's meaning —
// its terms, weighted by how rare they are — this document matched. A
// document that matched only the common word in a three-word query has
// matched nothing, however high it scores.
const COVERAGE = 0.35;
// And at least one of the terms it matched has to be a distinctive one: a
// term in a quarter of the corpus barely narrows anything down, while a
// term in one or two documents points straight at them. Without this, a
// query whose only findable word is a common one matches everything that
// happens to contain it.
//
// Both halves of the rule are needed. The proportion is what scales as the
// store grows; the flat count is what keeps it sane while the store is
// small, where two documents out of six is 33% and still obviously the
// thing being asked about.
const COMMON = 0.25;
const FEW = 2;
// How much of a question has to be findable before the ordinary bar
// applies. Below it the bar goes up: the less of what was asked can be
// looked up at all, the more specific the one thing that did match has to
// be before it is worth offering. "deployment to vercel" and "kubernetes
// ingress service" are the same shape — three terms, one of them findable
// — and the only thing separating them is that vercel names one document
// and service is just a word that several happen to contain.
const FINDABLE = 0.5;

// Words that match everything and therefore distinguish nothing. Short on
// purpose: an aggressive stop list throws away the "test" in "test runner".
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'then', 'than',
  'was', 'were', 'has', 'have', 'had', 'are', 'you', 'your', 'our', 'its',
  'what', 'when', 'where', 'which', 'who', 'how', 'why', 'did', 'does', 'do',
  'can', 'will', 'would', 'should', 'could', 'about', 'there', 'here', 'they',
  'them', 'not', 'but', 'all', 'any', 'out', 'get', 'got', 'now', 'just',
  // Two-letter words carry no meaning and match half the corpus. "go" is
  // the arguable one — it is a language — but coverage below sees to the
  // case where it is the only thing a document matched.
  'is', 'it', 'as', 'at', 'be', 'by', 'in', 'of', 'on', 'or', 'to', 'up',
  'we', 'me', 'my', 'if', 'so', 'no', 'an', 'am', 'us', 'he', 'do',
]);

// Lowercased words, with camelCase split as well as kept. A question about
// memoryBlock should find a note that says "the memory block", and asking
// about src/voice.js should find one that says voice — the punctuation
// split below does the second, the case split does the first.
export function tokenize(text) {
  const out = [];
  const take = (word) => {
    const lower = word.toLowerCase();
    if (lower.length < 2 || STOP.has(lower)) return;
    out.push(lower);
    // "tests" should find "test", and "deploys" should find "deploy". Both
    // forms are kept rather than one replaced, so an exact match still
    // outscores a folded one. Only a trailing s, and only on a word long
    // enough that dropping it leaves a word: anything cleverer than this
    // starts turning "status" into "statu".
    if (lower.length > 3 && lower.endsWith('s') && !lower.endsWith('ss')) {
      out.push(lower.slice(0, -1));
    }
  };
  for (const chunk of String(text ?? '').split(/[^A-Za-z0-9]+/)) {
    if (!chunk) continue;
    take(chunk);
    const parts = chunk.split(/(?<=[a-z0-9])(?=[A-Z])/);
    if (parts.length > 1) for (const part of parts) take(part);
  }
  return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Recent things are likelier to be what was meant. Half weight at a month,
// and never below half of the text score — what was written three years ago
// and matches exactly still beats this morning's near-miss.
function recency(when) {
  const at = Date.parse(when ?? '');
  if (!at) return 0.75;
  const days = Math.max(0, (Date.now() - at) / DAY_MS);
  return 0.5 + 0.5 / (1 + days / 30);
}

// Everything searchable, as flat documents. `text` is what gets indexed and
// `line` is what gets shown; they differ because "edited src/voice.js" reads
// better than the raw entry and indexes better than the bare filename.
export function corpus(config = {}) {
  const docs = [];
  const add = (doc) => {
    if (doc.text.trim()) docs.push(doc);
  };

  // Pinned notes are in the prompt already — retrieving one spends the
  // budget to say something that is three lines further up.
  for (const note of parseNotes()) {
    if (note.pinned) continue;
    add({
      source: 'note',
      project: note.project,
      when: note.date,
      text: `${note.kind} ${note.project} ${note.text}`,
      line: note.raw,
    });
  }

  if (config.ledger?.enabled !== false) {
    const days = config.recall?.days ?? config.ledger?.keepDays ?? 30;
    for (const entry of readEntries({ days })) {
      const said = {
        ask: () => ['asked', entry.text],
        answer: () => ['answered', entry.text],
        edit: () => ['edited', entry.file],
        run: () => ['ran', entry.command],
      }[entry.kind]?.();
      if (!said?.[1]) continue;
      const [verb, what] = said;
      add({
        source: 'ledger',
        project: entry.project ?? '',
        when: entry.at,
        text: `${entry.project ?? ''} ${what}`,
        line: `[${String(entry.at).slice(0, 10)}]${entry.project ? ` (${entry.project})` : ''} ` +
          `${verb} ${entry.kind === 'ask' || entry.kind === 'answer' ? `"${what}"` : what}` +
          `${entry.failed ? ' — failed' : ''}`,
      });
    }
  }

  for (const project of loadIndex().projects) {
    add({
      source: 'project',
      project: project.name,
      when: project.touched,
      text: `${project.name} ${project.what ?? ''}`,
      line: `${project.name} — ${project.path}${project.what ? ` — ${project.what.slice(0, 70)}` : ''}`,
    });
  }

  return docs;
}

// Textbook BM25, scored against the whole corpus each time. Rebuilding the
// statistics per query is wasteful in principle and free in practice at a
// few thousand short documents — and it means there is no index to keep in
// step with the files, which is the part that actually goes wrong.
export function rank(query, docs, { here = '' } = {}) {
  const wanted = tokenize(query);
  if (!wanted.length || !docs.length) return [];

  const counted = docs.map((doc) => {
    const tokens = tokenize(doc.text);
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return { doc, counts, length: tokens.length };
  });
  const avg = counted.reduce((sum, d) => sum + d.length, 0) / counted.length || 1;

  const df = new Map();
  for (const term of new Set(wanted)) {
    df.set(term, counted.filter((d) => d.counts.has(term)).length);
  }

  const idfOf = (term) => {
    const n = df.get(term);
    return Math.log(1 + (counted.length - n + 0.5) / (n + 0.5));
  };
  // Only the terms that exist somewhere. A word in none of the documents is
  // not something any of them failed to match — counting it would mean one
  // unfamiliar word in a question disqualified every answer to the rest.
  const all = [...new Set(wanted)];
  const terms = all.filter((term) => df.get(term) > 0);
  if (!terms.length) return [];
  const asked = terms.reduce((sum, term) => sum + idfOf(term), 0) || 1;
  const strict = terms.length / all.length < FINDABLE;
  const rare = (term) => (strict
    ? df.get(term) <= 1
    : df.get(term) <= FEW || df.get(term) / counted.length <= COMMON);

  const hits = [];
  for (const { doc, counts, length } of counted) {
    let score = 0;
    let met = 0;
    let distinctive = false;
    for (const term of terms) {
      const tf = counts.get(term) ?? 0;
      if (!tf) continue;
      const idf = idfOf(term);
      met += idf;
      if (rare(term)) distinctive = true;
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / avg)));
    }
    if (!score || !distinctive) continue;
    // Where you are standing is a strong hint about what you mean.
    if (here && doc.project === here) score *= 1.5;
    hits.push({ ...doc, score: score * recency(doc.when), coverage: met / asked });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits;
}

export function search(query, { config = {}, limit = 5 } = {}) {
  const here = projectAt(config.cwd ?? process.cwd())?.name ?? '';
  const hits = rank(query, corpus(config), { here });
  if (!hits.length) return [];

  const best = hits[0].score;
  const keep = [];
  const seen = new Set();
  const asked = String(query ?? '').trim().toLowerCase();
  for (const hit of hits) {
    if (hit.score < best * RELATIVE) break;
    // Sorted by score, not by coverage, so a thin match can sit above a
    // thorough one — skip it rather than stopping at it.
    if (hit.coverage < COVERAGE) continue;
    // The same thing said twice is one hit, and the question echoed back is
    // never one: being told you asked this yesterday answers nothing.
    const key = hit.line.toLowerCase();
    if (seen.has(key) || key.includes(`"${asked}"`)) continue;
    seen.add(key);
    keep.push(hit);
    if (keep.length >= limit) break;
  }
  return keep;
}

// A whole message that is only an acknowledgement. Not a scoring problem —
// "go ahead" and "deploy sanero" are both two-word queries in which one
// uncommon term matches, and no corpus statistic tells them apart. The
// difference is that an acknowledgement is not a question at all: what it
// refers to is in the turn before it, which the model already has. So this
// is a list, kept short and anchored to the entire message, and it governs
// only automatic recall — the tool still answers if it is asked outright.
const ACK = new RegExp('^(?:' + [
  'ok(?:ay)?', 'k', 'sure', 'thanks?', 'thank you', 'ta', 'cheers',
  'yes', 'yep', 'yeah', 'yup', 'aye', 'no', 'nope', 'nah',
  'go', 'go on', 'go ahead', 'carry on', 'continue', 'keep going', 'proceed',
  'do it', 'please do', 'please', 'again', 'more', 'next', 'and next',
  'sounds good', 'looks good', 'perfect', 'great', 'nice', 'cool', 'lovely',
  'right', 'fine', 'good', 'done', 'agreed', 'exactly', 'indeed',
  'stop', 'wait', 'hold on', 'never mind', 'nevermind',
].join('|') + ')[\\s.!,]*$', 'i');

// The block that rides along with one question. Empty far more often than
// not, which is the intent: a recall that fires on every "yes" and "go on"
// would be noise charged to every turn.
export function recallBlock(query, config = {}) {
  if (config.memory === false || config.recall?.enabled === false) return '';
  // One content word is enough — "who is aanshika" has exactly one and is
  // a perfectly good question. Asking for two would silence it to guard
  // against noise the scoring already refuses: a word that names nothing
  // matches nothing, and a message that is purely an acknowledgement is
  // not a lookup at any length.
  const asked = String(query ?? '').trim();
  if (!tokenize(asked).length || ACK.test(asked)) return '';

  const limit = config.recall?.limit ?? 5;
  const maxChars = config.recall?.maxChars ?? 600;
  const hits = search(query, { config, limit });
  if (!hits.length) return '';

  const lines = [];
  let used = 0;
  for (const hit of hits) {
    if (used + hit.line.length + 1 > maxChars) break;
    used += hit.line.length + 1;
    // A note carries its own bullet, because that is the character that
    // says whether it is pinned. Adding a second one makes "- - [date]".
    lines.push(/^[-+]\s/.test(hit.line) ? hit.line : `- ${hit.line}`);
  }
  if (!lines.length) return '';
  return ['[recalled] Possibly relevant, from what was already known. Some of it will not be —',
    'use what fits the question and ignore the rest; do not mention having been handed it.',
    ...lines].join('\n');
}
