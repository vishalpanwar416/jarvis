# jarvis

A terminal assistant built on the Claude Agent SDK — the same engine as Claude Code,
with a front-end that is yours to rewrite.

```
jarvis                    # interactive
jarvis "fix the tests"    # one task, then exit
jarvis --help
```

## Install

Try it without installing anything:

```bash
npx jarvis-code
```

Or put it on your PATH:

```bash
npm install -g jarvis-code
```

Either way you need Node 20+ and the same Claude credentials Claude Code uses —
a subscription login or `ANTHROPIC_API_KEY`. (`--local` needs neither; see
below.)

To change it rather than just use it, clone instead — the UI recompiles on
launch, so editing a `.jsx` and re-running `jarvis` is the whole loop:

```bash
git clone https://github.com/vishalpanwar416/jarvis
cd jarvis && npm install && npm link
```

## The three files you'll actually edit

| Want to change | Edit |
| --- | --- |
| Colours, glyphs, borders, banner, layout | `themes/*.json` |
| Chat layout, panels, key handling | `src/ui/*.jsx` |
| Persona, model, automations, voice, screen, awareness | `jarvis.config.json` |

`src/ui/*.jsx` is compiled by esbuild at launch, and only when a source file
changed — so editing a component and re-running `jarvis` is the whole loop. No
build command, no watcher.

## Layout

```
bin/jarvis.mjs        argument parsing, chooses interactive vs one-shot
build.mjs             the JSX bundle step (automatic)
src/
  agent.js            drives the Agent SDK, flattens its messages into events
  config.js           config + theme loading and merge order
  persona.js          builds the system prompt, and frames each turn
  automations.js      shell tasks → tools the model can call
  awareness.js        the ambient data collectors
  voice.js            speech in/out, all via external binaries
  screen.js           one screenshot, shrunk, and then gone
  screen-tools.js     the `look` tool, as the model sees it
  commands.js         slash commands
  models.js           the models /model offers, and name resolution
  oneshot.js          the non-interactive renderer
  serve.js            the resident JSON-line protocol (--serve)
  memory.js           what it knows between conversations
  memory-tools.js     remember / forget / projects, as tools
  ledger.js           what was actually done, written down as it happens
  working-set.js      where the work is, said once at the top of a session
  recall.js           BM25 over all of it, for the rest that will not fit
  autopilot.js        the "yes to everything" mode
  local.js            the Ollama proxy behind --local
  summarize.js        a tool call in a few words
  ui/
    App.jsx           state, event wiring, key map, layout
    Composer.jsx      the prompt line and the slash-command menu
    Suggestions.jsx   that menu
    Selector.jsx      the arrow-through list any command can open
    Live.jsx          the streaming region
    TranscriptItem.jsx  how each kind of log entry is drawn
    ToolLine.jsx      one tool call
    AwarenessPanel.jsx / StatusBar.jsx / Banner.jsx / PermissionPrompt.jsx
    markdown.jsx      the small markdown renderer
    theme.js          theme context
test/                 npm test — memory, the ledger, the working set, recall,
                      the serve protocol, voice, screen, commands
themes/               midnight · amber · mono
```

`npm test` is `node --test`, nothing else: no framework, no mocks of the SDK.
`serve.js` takes its session, its two streams and its exit as arguments so the
whole protocol can be driven from a test without a model behind it, and the
voice tests feed the detector PCM frames they build themselves.

## Keys

| Key | |
| --- | --- |
| `enter` | send |
| `/` | open the command menu — keep typing to narrow it |
| `tab` | complete the highlighted command (menu open) |
| `esc` | dismiss the menu, else interrupt the turn (and stop speech) |
| `↑` / `↓` | prompt history — or the menu, when one is open |
| `ctrl+p` | autopilot — answer every prompt, question and picker yourself |
| `ctrl+a` | ambient awareness panel |
| `ctrl+o` | speak replies aloud |
| `ctrl+t` | push-to-talk — one press; the take ends itself when you stop talking |
| `ctrl+h` | hands-free — mic stays open, every sentence sends itself |
| `ctrl+l` | clear |
| `ctrl+c` | quit |

## Slash commands

`/help` `/look` `/autopilot` `/voice` `/listen` `/awareness` `/automations`
`/run` `/model` `/permissions` `/theme` `/usage` `/session` `/clear` `/quit`

Typing `/` opens a filtered menu of them under the prompt: `↑`/`↓` to move,
`tab` to complete the name so you can add arguments, `enter` to run the
highlighted one, `esc` to dismiss.

## Models

`/model` on its own shows what you're on and opens a picker — arrows or `1`-`9`,
`enter` to switch, `esc` to leave it alone. The switch is live: it goes straight
to the running session, so the conversation continues on the new model.

`/model sonnet` skips the picker. Ids, aliases (`opus`, `sonnet`, `haiku`,
`fable`), labels and prefixes all resolve, and an id that isn't on the list is
accepted as-is so a model released tomorrow still works. Edit the list in
`src/models.js`, or pin your own with `"models"` in `jarvis.config.json`:

```json
"models": [
  { "id": "claude-opus-5", "label": "Opus 5", "aliases": ["opus"], "note": "the default" },
  { "id": "claude-haiku-4-5", "label": "Haiku 4.5", "aliases": ["haiku"], "note": "cheap" }
]
```

Any command can open the same picker with `api.pick({ title, hint, items, onSelect })`.

## Offline — `jarvis --local`

`jarvis --local` runs the whole agent against a model on this machine, with the
network unplugged. Nothing about the harness changes: same tools, same
permissions, same UI.

It works because we never pass an `env` option to `query()`, so the Claude Code
subprocess inherits this process's environment — and it honours
`ANTHROPIC_BASE_URL`. `src/local.js` sets that (plus the model aliases, so the
agent's internal "small fast model" calls stay local too) before the session
starts. At that URL sits a LiteLLM proxy translating Anthropic's `/v1/messages`
into what Ollama speaks; `local-llm.config.yaml` is its config. The proxy is
started on demand and left running, so the next `--local` reuses it.

One-time install, **while you still have network**:

```bash
python3 -m venv ~/.local/share/jarvis-local/venv
~/.local/share/jarvis-local/venv/bin/pip install "litellm[proxy]"
ollama pull qwen3.5:9b
```

Expect it to be slow, and slow in a lopsided way. The first turn pays for the
harness's ~17k-token system prompt at about 50 tokens/sec, so it takes five to
six minutes. After that Ollama reuses its KV cache and only reads what you
appended, so later turns cost roughly 15-25s plus generation at ~5 tokens/sec.
Keep tasks short and specific; this is for a train, not for refactoring.

Swap the model by editing `model:` in `local-llm.config.yaml` — or, if you
installed from npm and would rather not edit a file inside `node_modules`, copy
it to `~/.jarvis/local-llm.config.yaml`, which wins whenever it exists. The next
`--local` notices the file changed and restarts the proxy, because a running
one would go on serving the old model without saying so (the name it
advertises, `local`, does not change). A proxy you started by hand is left
alone. Two settings in that file are load-bearing: `num_ctx` (Ollama defaults to 4096 and *silently
truncates*, which throws away the system prompt and makes the agent answer a
question nobody asked) and `think: false` (a reasoning pass costs minutes at
this speed, and on small internal calls it ate the entire token budget and
returned no answer).

## Driving it from another program

Two ways, one slow and simple, one fast.

**One-shot.** `jarvis -q "question"` prints the reply on stdout and nothing
else, and exits non-zero with the reason on stderr when it could not answer.
To carry a conversation across calls, set `JARVIS_SESSION_FILE` to a path and
jarvis writes the session id there as soon as the session starts; pass it
back as `--resume <id>` on the next call. Quiet mode stays quiet — the id
goes to the file, not to the terminal. Every call pays the full start-up:
Node, the SDK, the Claude Code process, the session.

**Resident.** `jarvis --serve` stays up and takes questions as JSON lines on
stdin, one object per line, answering on stdout the same way — `ready`, then
per question `init` (the session id), `delta` for each piece of the reply as
it streams, and `result` with the whole of it. `resume` on a question picks
the conversation; the session already open is reused when it matches, so
follow-ups skip everything but the model. It exits on its own after
`--idle` seconds without a question (600 by default). Only protocol goes to
stdout. A question marked `"voice": true` was spoken and will be read back, so
its answer is written to be heard — see Voice below. The full shape is at the
top of `src/serve.js`. The Bezelrig GNOME extension's floating Jarvis bubble
uses this, falling back to one-shot when it cannot.

## Permissions

Read-only tools are pre-approved in `allowedTools`. Anything else pauses with a
prompt: `y` once, `a` always (for the rest of the session), `n` deny. Change the
posture with `/permissions acceptEdits` or `bypassPermissions`, or set
`permissionMode` in the config.

One-shot mode has nobody to ask, so it **denies** anything not pre-approved and
tells the model why. Pass `-y` to let it act.

Two things are allowed everywhere, including where nothing else may act:
remembering, which writes only to Jarvis' own store under `~/.jarvis` and never
to your files, and `look`, because someone asking what is on their screen is
already looking at it. Both are reversible in config — see
`screen.ask` under Seeing the screen.

**Your existing Claude Code settings still apply.** `settingSources` defaults to
`["user", "project", "local"]`, so jarvis loads your `CLAUDE.md`, skills *and*
the `permissions.allow` rules in `~/.claude/settings.json` and
`.claude/settings.local.json`. An allow-rule there approves a tool before jarvis
is consulted — so a `Bash(...)` rule you added months ago will run without a
prompt here too, including in one-shot mode without `-y`. To isolate jarvis from
all of that, set `"settingSources": []` in `jarvis.config.json`.

## Autopilot

`ctrl+p` or `/autopilot` hands every decision to jarvis until you press it
again. While armed, the status bar says `autopilot` and:

- every permission prompt is allowed, as if you pressed `y`;
- every question the model asks is answered with its recommended option (or the
  first one), and the transcript notes what was chosen;
- every picker a command opens resolves to its recommended, else current, else
  first row — so `/model` on its own stays on the model you're using;
- the model is told to stop asking, state its assumption in one line, take the
  option it would recommend, and finish the job.

Anything already waiting when you arm it is answered on the spot. Start armed
with `--autopilot` or `"autopilot": true` in the config. In one-shot mode
`--autopilot` implies `-y` and additionally answers questions, so a cron job
never stalls on one. The logic is `src/autopilot.js`; a picker row can carry
`recommended: true` to steer it.

Autopilot skips the SDK's `bypassPermissions` posture on purpose: it approves
through the same callback your prompts use, so `/permissions` and
`allowedTools` still describe what happens the moment you disarm it.

## Automations

Each entry in `automations` becomes two things: a tool the model can call when
you ask for that task by intent, and a `/run <name>` command.

```json
{
  "name": "post_sanero",
  "description": "Publish today's Sanero Instagram post.",
  "command": "cd '/home/you/Table-Tap media' && BRAND_DIR=brands/sanero node post.js",
  "args": []
}
```

Arguments are declared and substituted as `{{name}}`, shell-quoted, so values
with spaces stay one argument:

```json
{
  "name": "deploy",
  "description": "Deploy a service to an environment.",
  "command": "./deploy.sh {{service}} {{env}}",
  "args": [
    { "name": "service", "description": "Service name" },
    { "name": "env", "description": "staging or prod", "required": false }
  ]
}
```

## What it remembers

Four things, kept apart because they go stale differently.

**Notes** — `~/.jarvis/memory/notes.md`. One line each, written by the model
through its `remember` tool when something would save a question next time: a
decision, a preference, how a project deploys. The newest fill a budget at the
top of every session; `forget` drops any that mention a given word.

A note can be filed under a kind — `preference`, `decision`, `location`,
`howto` — and pinned. Pinning means *keep this in view whatever the
conversation turns out to be about*: pinned notes get their own section ahead
of the rest, take their space before the budget is spent, and are never
dropped for age. The file is plain text and the pin is one character, so you
can pin something yourself by changing `-` to `+`:

```
+ [2026-10-15] (jarvis) preference: tests are written with node --test
- [2026-09-20] (sanero) Production deploys go out through Vercel
```

Notes written before kinds and pins existed parse as unpinned and unfiled, so
nothing on disk had to change. A line this parser cannot read is left exactly
where it is rather than dropped — `notes.md` is a file you are meant to edit.

**A project index** — `~/.jarvis/memory/projects.json`, rebuilt by looking
rather than by being told. Walks `~/Development` for project markers, so naming
a project resolves to a path without anyone having written that path down. The
handful touched most recently are named up front; the rest are a `projects`
tool call away.

**A ledger** — `~/.jarvis/memory/ledger/YYYY-MM-DD.jsonl`. The record of what
was actually done: a line per question asked, answer given, file changed and
command run, tagged with the project it happened in. It is folded out of the
events the session already emits, so it costs no model call and no prompt
space. This is the part that makes a conversation able to open knowing what
the last one was about.

**A working set** — not stored at all. Computed when a session opens, from the
working directory, the repo, and the last few days of ledger:

```
Where this conversation is happening, as of 2026-10-15 07:14:
- in jarvis — ~/Development/Aarambh/jarvis — A hackable terminal assistant…
- git: main · 8 uncommitted — last commit "Memory, screen sight, a resident mode…"
- here over the last 5 days: 12 file edits, 4 commands (1 failed); last touched
  src/serve.js, src/voice.js, README.md
- last asked here: "commit and push it"
- also worked in today: bezelrig
```

Everything in it is derived, so none of it can be stale the way a note can be:
if the branch changed, it says the new branch. It costs about 20ms and 350
characters.

```json
"ledger": {
  "enabled": true,
  "keepDays": 30,
  "recentDays": 5,
  "maxEntryChars": 240
}
```

An automatic recorder is worth being careful with, so: `keepDays` is a horizon
and anything past it is deleted when a session opens; commands are stripped of
tokens, keys and passwords *before* they are written, not when they are read;
`forget` reaches the ledger as well as the notes; and `enabled: false` turns
the whole thing off, with nothing else in Jarvis depending on it. The files are
newline-delimited JSON — `cat ~/.jarvis/memory/ledger/*.jsonl` is the whole
story of what is kept.

### Reaching the rest of it

The block at the top of a session is capped — it is paid for on every turn —
so most of what Jarvis knows is necessarily outside it. Recall is how a
question gets at the rest. It searches the notes, the ledger and the project
index with BM25, which is lexical: no model, no network, no embeddings and no
index to rebuild, about three milliseconds.

It runs two ways. The model can call `recall` as a tool when it thinks
something was decided or done before. And every question you type is looked up
automatically, with anything found riding along with that message:

```
[recalled] Possibly relevant, from what was already known. Some of it will not be —
use what fits the question and ignore the rest; do not mention having been handed it.
- [2026-09-20] (sanero-website) Production deploys go out through Vercel; live domain is sanero.in
- sanero-next — ~/Development/Aarambh/sanero-next — Sanero Media — website (Next.js)
```

It rides with the message rather than going into the system prompt on purpose.
What is worth retrieving changes with every question; the system prompt is
fixed when the session opens and is the part that gets cached. Rewriting it
each turn to inject context would cost more than the context is worth.

Most turns it finds nothing and says nothing, which is the intent. Three gates
decide that, and all three are free of any absolute score threshold — BM25
scores depend on how big the store is, so a fixed cutoff is a number that
quietly stops working as it fills up. A hit has to be worth a third of the
best hit, account for at least a third of the question by weight, and have
matched something distinctive rather than a word half the store contains. The
less of your question is findable at all, the higher that last bar goes.

Messages that are purely acknowledgements — "go ahead", "ok thanks", "carry
on" — are skipped outright. That is a list, not a score: "go ahead" and "deploy
sanero" are the same shape to any scoring function, and the difference is that
an acknowledgement refers to the turn before it, which the model already has.

```json
"recall": { "enabled": true, "limit": 5, "maxChars": 600, "days": 30 }
```

**On embeddings.** There are none here, deliberately. A few hundred notes and a
few thousand ledger lines is not a corpus where vector search wins: BM25 is
exact about filenames and identifiers, which is most of what gets looked up,
and it costs nothing to keep current. The case for embeddings starts when the
thing being searched is project source rather than memory — a different
feature, and `Grep` already covers much of it.

## Awareness

`ctrl+a` opens a live panel above the chat. Built-ins are `clock`, `cwd`, `git`
and `system`; add your own as one-line shell probes:

```json
"awareness": {
  "enabled": true,
  "intervalMs": 5000,
  "builtins": ["clock", "git"],
  "probes": [
    { "label": "crons", "command": "hermes jobs --count" },
    { "label": "api", "command": "curl -s -o /dev/null -w %{http_code} localhost:3000/health" }
  ]
}
```

## Voice

Everything is an external binary, detected on PATH, so nothing is silently
faked — if a backend is missing the status line says which one.

- **Speaking** (`ctrl+o`): `piper` → `espeak-ng` → `say` → `spd-say`.
- **Listening** (`ctrl+t`): a recorder (`arecord` → `pw-record` → `rec`) plus a
  transcriber — `jarvis-stt-stream` if it's on PATH, else `whisper-cpp` →
  `whisper`. Setting `voice.stt.command` skips that detection entirely, and
  `voice.tts.command` does the same for speaking.

### Dictation

`ctrl+t` starts listening; the status line turns red and the prompt grows a `●`.
Words appear in the composer **while you speak**: each finished phrase is written
into the draft, and the phrase still in the air trails behind it in grey until
the transcriber settles on it. The take ends when you stop talking — a second
`ctrl+t` ends it early — and the text is left in the composer to edit
(`voice.autoSend: true` sends it instead). `esc` while listening throws the take
away and puts back whatever you had typed.

### Hands-free

`ctrl+h` (or `/listen on`) arms the mic for the whole conversation: no key per
sentence. A detector finds where each utterance begins and ends, sends it, and
goes back to waiting. It goes deaf while a turn is running and while a reply is
being read aloud, so it can't answer its own voice; `esc` discards the sentence
in flight and stays armed. The few hundred milliseconds before the detector was
sure are replayed from a buffer, so the first syllable isn't clipped.

```json
"voice": {
  "handsFree": { "enabled": false, "pauseWhileBusy": true },
  "vad": { "enabled": true, "threshold": 0, "startMs": 140, "silenceMs": 850, "preRollMs": 320 }
}
```

`threshold: 0` learns the room's noise floor instead of trusting a fixed number
— set it (RMS, 0..1) to pin the gate. `silenceMs` is how long a pause has to
last before your sentence counts as finished; `vad.enabled: false` puts ctrl+t
back to two presses and turns hands-free off entirely.

The detector gates on loudness, and loudness is not speech: a fan, music or the
next room can open a take. What that transcribes to is a transcriber's filler —
"you", "Thank you for watching!", the subtitle credit off the end of a video —
so hands-free drops those rather than asking Jarvis about them. A real question
containing one of those words is matched whole and gets through.

### Answers written to be heard

A spoken answer is a sentence somebody says to you; a written one is a page you
skim. They are not the same piece of writing, so when the reply is going to be
read out — `ctrl+o`, `--voice`, or a question that arrived by voice through
`--serve` — the turn carries that fact to the model, and it writes for the ear:
the answer first, two or three sentences, no markdown, no paths spelled out
character by character, and a word at the end if it left anything out.

It is said per turn rather than baked into the persona, because the same
conversation is typed at one moment and talked to the next. Asked the same
question both ways:

```
typed   Three, sir — all in `test/`: `memory.test.mjs`, `serve.test.mjs`, …
spoken  Three, sir — covering memory, the serve module, and voice. They're all
        untracked in git so far, written for node's built-in test runner.
```

Whatever still comes back long is cut at the last sentence that fits inside
`voice.tts.maxChars` (700 by default, `0` reads the lot) — the whole answer is
on screen either way.

That needs a *streaming* backend: one that reads 16 kHz mono PCM on stdin and
prints JSON lines — `{"type":"partial"|"segment"|"final","text":…}` — as it goes,
plus `ready` once its model is up. It's held resident and warmed at startup,
because loading a speech model per take is exactly what makes live text
impossible. Control words arrive on fd 3 (`flush` ends a take, `reset` drops it).

```json
"voice": { "stt": { "streamCommand": "my-streamer", "prewarm": true } }
```

Without one, `ctrl+t` still works the old way — record, then transcribe the whole
take when you stop. Anything that prints a transcript for a wav file will do,
and `"streaming": false` pins that behaviour even when a streamer is installed:

```json
"voice": { "stt": { "command": "my-transcriber --file {{file}}", "streaming": false } }
```

`spd-say` is robotic; `sudo apt install espeak-ng` or piper is a real upgrade.

## Seeing the screen

"What's on my screen?" used to be the one question Jarvis couldn't answer.
Now it has a single tool — `look` — that takes one frame, shows it to the
model, and deletes it. Ask in words, or `/look`:

```
/look                              what's on the screen
/look window                       just the window in front
/look what does this error say     a question about what's there
```

Nothing is typed at the tool directly; it is called because the question needs
it — "read this page", "is this the right branch", "what is this dialog asking
me" — and the answer comes back as a sentence about the screen rather than as
an image.

The capture is an external backend, detected like the voice ones: the GNOME
Shell D-Bus method, then `grim`, `gnome-screenshot`, `spectacle`, `maim`,
`scrot`, `import`. On Wayland the shell's own method is usually the only one
permitted, and it is tried first for that reason. Whatever comes back is
shrunk to a long edge of `maxPixels` before it is sent — the model resizes a
4K screenshot anyway, so sending it whole costs only waiting.

```json
"screen": { "enabled": true, "ask": false, "engine": "auto", "maxPixels": 1568 }
```

**The file does not outlive the answer.** Each capture happens in a directory
of its own, made on the spot with owner-only permissions and removed in a
`finally` — so a capture that fails halfway, or a model that never reads the
result, still leaves nothing behind. There is a test for exactly that, because
a picture of someone's screen is not a temp file to be casual about.

For the same reason, `ask` is there: looking does not prompt by default, since
being asked to approve a screenshot right after saying "what's on my screen"
is friction for no gain — but a screenshot takes in whatever happens to be
there, including a password manager left open, and the model may reach for it
mid-task when nobody is thinking about what is on screen. `"ask": true` puts
it behind a prompt; `"enabled": false` takes the tool away entirely.

In the Bezelrig bubble this needs nothing extra: it asks through `--serve`, so
"Jarvis, what am I looking at?" works, and the bubble's activity line says
*Looking at the screen* while it does.

## Themes

`themes/*.json` can `extends` another theme and override only what differs —
`amber` and `mono` are both twenty lines on top of `midnight`. Switch live with
`/theme amber`, or per-run with `--theme`. Drop personal themes in
`~/.jarvis/themes/` and personal config in `~/.jarvis/config.json`; both win over
the files in this repo.
