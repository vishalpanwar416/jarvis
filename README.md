# jarvis

A terminal assistant built on the Claude Agent SDK — the same engine as Claude Code,
with a front-end that is yours to rewrite.

```
jarvis                    # interactive
jarvis "fix the tests"    # one task, then exit
jarvis --help
```

Install it on your PATH once:

```bash
cd ~/Development/Aarambh/jarvis && npm link
```

## The three files you'll actually edit

| Want to change | Edit |
| --- | --- |
| Colours, glyphs, borders, banner, layout | `themes/*.json` |
| Chat layout, panels, key handling | `src/ui/*.jsx` |
| Persona, model, automations, voice, awareness | `jarvis.config.json` |

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
  persona.js          builds the system prompt from config.persona
  automations.js      shell tasks → tools the model can call
  awareness.js        the ambient data collectors
  voice.js            speech in/out, all via external binaries
  commands.js         slash commands
  models.js           the models /model offers, and name resolution
  oneshot.js          the non-interactive renderer
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
themes/               midnight · amber · mono
```

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

`/help` `/autopilot` `/voice` `/listen` `/awareness` `/automations` `/run`
`/model` `/permissions` `/theme` `/usage` `/session` `/clear` `/quit`

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

## Permissions

Read-only tools are pre-approved in `allowedTools`. Anything else pauses with a
prompt: `y` once, `a` always (for the rest of the session), `n` deny. Change the
posture with `/permissions acceptEdits` or `bypassPermissions`, or set
`permissionMode` in the config.

One-shot mode has nobody to ask, so it **denies** anything not pre-approved and
tells the model why. Pass `-y` to let it act.

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
  `whisper` → `voice.stt.command`.

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

## Themes

`themes/*.json` can `extends` another theme and override only what differs —
`amber` and `mono` are both twenty lines on top of `midnight`. Switch live with
`/theme amber`, or per-run with `--theme`. Drop personal themes in
`~/.jarvis/themes/` and personal config in `~/.jarvis/config.json`; both win over
the files in this repo.
