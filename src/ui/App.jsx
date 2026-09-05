// The app shell: owns state, wires the agent session to the components, and
// holds the global key map. Layout lives in the JSX at the bottom.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';

import TranscriptItem from './TranscriptItem.jsx';
import Live from './Live.jsx';
import AwarenessPanel from './AwarenessPanel.jsx';
import StatusBar from './StatusBar.jsx';
import Composer from './Composer.jsx';
import PermissionPrompt from './PermissionPrompt.jsx';
import Selector from './Selector.jsx';
import { ThemeContext } from './theme.js';

import { JarvisSession, emptyTotals } from '../agent.js';
import { createAwareness } from '../awareness.js';
import { buildAutomationServer } from '../automations.js';
import { Voice } from '../voice.js';
import { runCommand } from '../commands.js';
import { loadTheme } from '../config.js';
import { autopilotDecision, autopilotPrefix, describeAnswers, pickRecommended } from '../autopilot.js';

const KEY_HINT = 'ctrl+p autopilot · ctrl+a aware · ctrl+o speech · ctrl+t talk · ctrl+h hands-free · esc stop';

export default function App({ config: initialConfig, resume }) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [config, setConfig] = useState(initialConfig);
  const [theme, setTheme] = useState(() => loadTheme(initialConfig.ui.theme));
  const [items, setItems] = useState(() => [
    {
      id: -1,
      kind: 'banner',
      persona: initialConfig.persona,
      model: initialConfig.model,
      cwd: initialConfig.cwd,
      hint: `/help for commands · ${KEY_HINT}`,
    },
  ]);
  const [live, setLive] = useState({ text: '', thinking: '' });
  const [running, setRunning] = useState([]);
  const [busy, setBusy] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [picker, setPicker] = useState(null);
  const [autopilot, setAutopilot] = useState(Boolean(initialConfig.autopilot));
  const [awarenessOn, setAwarenessOn] = useState(initialConfig.awareness.enabled);
  const [awarenessRows, setAwarenessRows] = useState([]);
  const [voiceOut, setVoiceOut] = useState(initialConfig.voice.output);
  const [listening, setListening] = useState(false);
  // Armed, as opposed to hearing something: hands-free holds the mic open
  // between utterances, so it stays on while `listening` blinks per phrase.
  const [handsFree, setHandsFree] = useState(Boolean(initialConfig.voice.handsFree?.enabled));
  // The phrase being spoken right now — not part of the draft until the
  // transcriber commits it, so a revised guess never has to be un-typed.
  const [partial, setPartial] = useState('');
  const [totals, setTotals] = useState(emptyTotals);

  const nextId = useRef(0);
  const turnStart = useRef(0);
  const lastReply = useRef('');
  // Read inside the session effect, which must not re-run (re-running it would
  // tear down and restart the conversation) — so these are refs, not deps.
  const voiceOutRef = useRef(voiceOut);
  const showThinkingRef = useRef(config.ui.showThinking);
  const autopilotRef = useRef(autopilot);
  voiceOutRef.current = voiceOut;
  showThinkingRef.current = config.ui.showThinking;
  autopilotRef.current = autopilot;
  const voice = useMemo(() => new Voice(initialConfig), [initialConfig]);
  const awareness = useMemo(() => createAwareness(config), [config]);

  const push = useCallback((item) => {
    setItems((current) => [...current, { id: nextId.current++, ...item }]);
  }, []);

  // Permission requests arrive from the SDK; the UI answers them by resolving
  // the promise stored alongside the request.
  // Autopilot short-circuits this: everything is allowed, and a question from
  // the model is answered with its recommended option instead of shown.
  const approvedRef = useRef(new Set(initialConfig.allowedTools ?? []));
  const canUseTool = useCallback(
    (toolName, input, { suggestions }) => {
      if (autopilotRef.current) {
        const decision = autopilotDecision(toolName, input);
        if (toolName === 'AskUserQuestion') {
          push({ kind: 'note', text: describeAnswers(decision.updatedInput?.answers) });
        }
        return Promise.resolve(decision);
      }
      if (approvedRef.current.has(toolName)) return Promise.resolve({ behavior: 'allow' });
      return new Promise((resolve) => {
        setPermissions((queue) => [...queue, { toolName, input, suggestions, resolve }]);
      });
    },
    [push],
  );

  // Switching autopilot on mid-prompt answers whatever is already waiting.
  useEffect(() => {
    if (!autopilot || !permissions.length) return;
    for (const request of permissions) request.resolve(autopilotDecision(request.toolName, request.input));
    push({ kind: 'note', text: `autopilot allowed ${permissions.map((request) => request.toolName).join(', ')}` });
    setPermissions([]);
  }, [autopilot, permissions, push]);

  // ── the session ───────────────────────────────────────────────────────────
  const session = useMemo(() => {
    const automationServer = buildAutomationServer(initialConfig);
    return new JarvisSession({
      config: initialConfig,
      mcpServers: automationServer ? { automations: automationServer } : {},
      canUseTool,
      resume,
    });
  }, [initialConfig, canUseTool, resume]);

  useEffect(() => {
    const onEvent = (event) => {
      switch (event.kind) {
        case 'init':
          push({ kind: 'note', text: `session ${event.sessionId.slice(0, 8)} · ${event.tools.length} tools` });
          break;

        case 'submitted':
          turnStart.current = Date.now();
          setBusy(true);
          setLive({ text: '', thinking: '' });
          break;

        case 'delta':
          setLive((current) => ({ ...current, text: current.text + event.text }));
          break;

        case 'thinking-delta':
          setLive((current) => ({ ...current, thinking: current.thinking + event.text }));
          break;

        case 'thinking':
          if (showThinkingRef.current) push({ kind: 'thinking', text: event.text.split('\n')[0] });
          break;

        case 'assistant':
          lastReply.current = event.text;
          push({ kind: 'assistant', text: event.text });
          setLive({ text: '', thinking: '' });
          break;

        case 'tool-start':
          setRunning((current) => [...current, { id: event.id, name: event.name, input: event.input }]);
          break;

        case 'tool-end':
          setRunning((current) => {
            const tool = current.find((entry) => entry.id === event.id);
            if (tool) {
              push({
                kind: 'tool',
                name: tool.name,
                input: tool.input,
                isError: event.isError,
                preview: event.preview,
              });
            }
            return current.filter((entry) => entry.id !== event.id);
          });
          break;

        case 'result':
          setBusy(false);
          setLive({ text: '', thinking: '' });
          setTotals(event.totals);
          if (event.isError && event.text) push({ kind: 'error', text: event.text });
          if (voiceOutRef.current && lastReply.current) voice.speak(lastReply.current);
          break;

        case 'note':
          push({ kind: 'note', text: event.text });
          break;

        case 'error':
          setBusy(false);
          push({ kind: 'error', text: event.text });
          break;

        default:
          break;
      }
    };

    session.on('event', onEvent);
    session.start();
    return () => {
      session.off('event', onEvent);
      session.close();
      voice.dispose();
    };
  }, [session, push, voice]);

  // Elapsed-time ticker for the live area.
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => setElapsedMs(Date.now() - turnStart.current), 500);
    return () => clearInterval(timer);
  }, [busy]);

  // Ambient polling.
  useEffect(() => {
    if (!awarenessOn) {
      setAwarenessRows([]);
      return undefined;
    }
    let alive = true;
    const tick = async () => {
      const rows = await awareness.collect();
      if (alive) setAwarenessRows(rows);
    };
    tick();
    const timer = setInterval(tick, config.awareness.intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [awarenessOn, awareness, config.awareness.intervalMs]);

  // ── actions ───────────────────────────────────────────────────────────────
  const api = useMemo(
    () => ({
      config,
      session,
      voice,
      state: { voiceOut, awareness: awarenessOn, autopilot, handsFree },
      note: (text) => push({ kind: 'note', text }),
      error: (text) => push({ kind: 'error', text }),
      pick: (request) => setPicker(request),
      setAutopilot,
      clear: () => {
        stdout.write('\x1B[2J\x1B[3J\x1B[H');
        setItems([]);
      },
      quit: () => exit(),
      setVoiceOut,
      setHandsFree,
      setAwareness: setAwarenessOn,
      setTheme: (name) => setTheme(loadTheme(name)),
      setModel: (model) => setConfig((current) => ({ ...current, model })),
      setPermissionMode: (mode) => setConfig((current) => ({ ...current, permissionMode: mode })),
    }),
    [config, session, voice, voiceOut, awarenessOn, autopilot, handsFree, push, stdout, exit],
  );

  // The system prompt is fixed once the session starts, so autopilot switched
  // on afterwards rides along with each message instead. The transcript shows
  // only what you typed.
  const submit = useCallback(
    (text) => {
      setHistory((current) => [...current, text]);
      if (text.startsWith('/')) {
        push({ kind: 'user', text });
        runCommand(text, api);
        return;
      }
      push({ kind: 'user', text });
      const armedLate = autopilot && !initialConfig.autopilot;
      session.send(armedLate ? `${autopilotPrefix()}\n\n${text}` : text);
    },
    [api, push, session, autopilot, initialConfig.autopilot],
  );

  // What was already in the composer when dictation started, kept so the
  // transcript can be rewritten in place without eating anything you typed.
  const dictation = useRef({ base: '', text: '' });
  const join = (base, text) => (base && text ? `${base.replace(/\s+$/, '')} ${text}` : base || text);

  // Read by callbacks the voice layer holds for the life of a take, which is
  // longer than any one render: a stale closure there would talk to the wrong
  // turn. Same for `listening`, which the detector ends without a keystroke.
  const submitRef = useRef(submit);
  const listeningRef = useRef(false);
  submitRef.current = submit;

  const arm = (on) => {
    listeningRef.current = on;
    setListening(on);
  };

  const stopTalk = useCallback(async () => {
    if (!listeningRef.current) return;
    arm(false);
    setPartial('');

    if (voice.canStream) {
      const text = await voice.stopStreaming();
      const full = join(dictation.current.base, text || dictation.current.text).trim();
      dictation.current = { base: '', text: '' };
      if (!full) return setDraft('');
      if (config.voice.autoSend) {
        setDraft('');
        submitRef.current(full);
      } else {
        setDraft(full);
      }
      return;
    }

    // ── fallback: one transcription once the take is over ──────────────────
    try {
      const text = await voice.stopRecording();
      if (!text) return;
      if (config.voice.autoSend) submitRef.current(text);
      else setDraft((current) => (current ? `${current} ${text}` : text));
    } catch (error) {
      push({ kind: 'error', text: `transcription failed: ${error.message}` });
    }
  }, [voice, config.voice.autoSend, push]);

  const startTalk = useCallback(() => {
    const blocker = voice.listenBlocker();
    if (blocker) return push({ kind: 'error', text: `speech in unavailable: ${blocker}` });
    dictation.current = { base: draft, text: '' };
    setPartial('');

    // ── live: text lands in the composer while you speak ───────────────────
    if (voice.canStream) {
      const started = voice.startStreaming({
        onWarming: () => push({ kind: 'note', text: 'loading the speech model — the first words may lag' }),
        onPartial: (text) => setPartial(text),
        onSegment: (_phrase, all) => {
          setPartial('');
          setDraft(join(dictation.current.base, all));
        },
        // The detector heard the end of the sentence, so the second ctrl+t
        // isn't needed. Turn it off with voice.vad.enabled = false.
        onSilence: () => stopTalk(),
        onError: (text) => push({ kind: 'error', text: `dictation: ${text}` }),
      });
      if (started) arm(true);
      else push({ kind: 'error', text: 'could not start the recorder' });
      return;
    }

    if (voice.startRecording()) arm(true);
    else push({ kind: 'error', text: 'could not start the recorder' });
  }, [voice, draft, push, stopTalk]);

  const toggleTalk = useCallback(() => {
    // Hands-free already owns the mic, and there's nothing for a key to add:
    // the detector is doing what ctrl+t would have done.
    if (handsFree) return push({ kind: 'note', text: 'hands-free is on — just talk (ctrl+h to stop)' });
    if (listeningRef.current) stopTalk();
    else startTalk();
  }, [handsFree, startTalk, stopTalk, push]);

  // ── hands-free ────────────────────────────────────────────────────────────
  // One press arms the mic for the whole conversation: the detector finds each
  // utterance, and each one sends itself when you stop talking.
  useEffect(() => {
    if (!handsFree) return undefined;
    const blocker = voice.listenBlocker();
    if (blocker || !voice.canHandsFree) {
      push({
        kind: 'error',
        text: `hands-free unavailable: ${blocker ?? 'needs a streaming transcriber and voice.vad.enabled'}`,
      });
      setHandsFree(false);
      return undefined;
    }

    const started = voice.startHandsFree({
      onWarming: () => push({ kind: 'note', text: 'loading the speech model — the first words may lag' }),
      onSpeech: () => {
        setPartial('');
        setListening(true);
      },
      onPartial: (text) => setPartial(text),
      onSegment: (_phrase, all) => {
        setPartial('');
        setDraft(all);
      },
      onUtterance: (text) => {
        setListening(false);
        setPartial('');
        setDraft('');
        if (text) submitRef.current(text);
      },
      onError: (text) => push({ kind: 'error', text: `hands-free: ${text}` }),
    });
    if (!started) {
      push({ kind: 'error', text: 'could not open the microphone' });
      setHandsFree(false);
      return undefined;
    }

    push({ kind: 'note', text: 'hands-free on — speak, pause, and it sends. ctrl+h to stop.' });
    return () => {
      voice.stopHandsFree();
      arm(false);
      setPartial('');
    };
  }, [handsFree, voice, push]);

  // While a turn runs — and while the reply is still being read out — the mic
  // goes deaf, or hands-free would hear his own voice and answer it.
  useEffect(() => {
    if (!handsFree || config.voice.handsFree?.pauseWhileBusy === false) return undefined;
    if (busy) {
      voice.setMuted(true);
      return undefined;
    }
    if (!voice.speaking) {
      voice.setMuted(false);
      return undefined;
    }
    const timer = setInterval(() => {
      if (voice.speaking) return;
      voice.setMuted(false);
      clearInterval(timer);
    }, 200);
    return () => clearInterval(timer);
  }, [handsFree, busy, voice, config.voice.handsFree?.pauseWhileBusy]);

  // Load the speech model up front so the first ctrl+t records instead of
  // waiting on it. Costs nothing when no streaming backend is installed.
  useEffect(() => {
    if (config.voice.stt.prewarm !== false) voice.warm();
  }, [voice, config.voice.stt.prewarm]);

  // A picker closes the moment you answer it, so a slow handler can't leave a
  // dead menu on screen.
  const resolvePicker = useCallback(
    (item) => {
      const request = picker;
      setPicker(null);
      if (!request || !item) return;
      Promise.resolve(request.onSelect(item)).catch((error) =>
        push({ kind: 'error', text: String(error?.message ?? error) }),
      );
    },
    [picker, push],
  );

  // Under autopilot a picker never reaches the screen: it takes the
  // recommended row (else the current one, else the first) and moves on.
  useEffect(() => {
    if (!autopilot || !picker) return;
    const choice = pickRecommended(picker.items);
    if (!choice) return;
    push({ kind: 'note', text: `autopilot picked ${choice.label} (${picker.title})` });
    resolvePicker(choice);
  }, [autopilot, picker, push, resolvePicker]);

  // ── keys ──────────────────────────────────────────────────────────────────
  const pending = permissions[0] ?? null;
  // Overlays take the keyboard, innermost first: permission, then picker.
  const composerActive = !pending && !picker;

  useInput(
    (input, key) => {
      if (key.escape) {
        // Escape during dictation throws the take away rather than keeping a
        // half-heard sentence: stop, restore the draft you started with. The
        // mic stays armed in hands-free — esc discards a sentence, ctrl+h ends
        // the conversation.
        if (listening) {
          arm(false);
          setPartial('');
          if (handsFree) voice.abortTake();
          else if (voice.canStream) voice.stopStreaming();
          else voice.stopRecording().catch(() => {});
          setDraft(handsFree ? '' : dictation.current.base);
          dictation.current = { base: '', text: '' };
          return;
        }
        session.interrupt();
        voice.stopSpeaking();
        return;
      }
      if (!key.ctrl) return;
      switch (input) {
        case 'c':
          exit();
          break;
        case 'a':
          setAwarenessOn((on) => !on);
          break;
        case 'p':
          push({
            kind: 'note',
            text: autopilot ? 'autopilot off' : 'autopilot on — every prompt, question and picker answers itself',
          });
          setAutopilot(!autopilot);
          break;
        case 'o': {
          const blocker = voice.speakBlocker();
          if (blocker) push({ kind: 'error', text: `speech out unavailable: ${blocker}` });
          else setVoiceOut((on) => !on);
          break;
        }
        case 't':
          toggleTalk();
          break;
        case 'h':
          // Hands-free and push-to-talk want the same microphone, so arming one
          // stands the other down.
          if (listeningRef.current && !handsFree) stopTalk();
          setHandsFree((on) => {
            if (on) push({ kind: 'note', text: 'hands-free off' });
            return !on;
          });
          break;
        case 'l':
          api.clear();
          break;
        default:
          break;
      }
    },
    { isActive: composerActive },
  );

  // Permission answers.
  useInput(
    (input) => {
      if (!pending) return;
      const answer = input.toLowerCase();
      if (answer === 'y' || answer === 'a') {
        if (answer === 'a') approvedRef.current.add(pending.toolName);
        pending.resolve({
          behavior: 'allow',
          ...(answer === 'a' && pending.suggestions ? { updatedPermissions: pending.suggestions } : {}),
        });
      } else if (answer === 'n' || answer === 'd') {
        pending.resolve({ behavior: 'deny', message: 'Denied by the user.' });
      } else {
        return;
      }
      setPermissions((queue) => queue.slice(1));
    },
    { isActive: Boolean(pending) },
  );

  // ── layout ────────────────────────────────────────────────────────────────
  const awarenessBlock = awarenessOn ? <AwarenessPanel rows={awarenessRows} /> : null;

  return (
    <ThemeContext.Provider value={theme}>
      <Box flexDirection="column" paddingX={theme.layout.padding ?? 0}>
        <Static items={items}>
          {(item) => (
            <Box key={item.id} flexDirection="column">
              <TranscriptItem item={item} resultLines={config.ui.toolResultLines} />
            </Box>
          )}
        </Static>

        {theme.layout.awarenessPosition === 'top' ? awarenessBlock : null}

        <Live
          busy={busy}
          text={live.text}
          thinking={config.ui.showThinking ? live.thinking : ''}
          running={running}
          resultLines={config.ui.toolResultLines}
          elapsedMs={elapsedMs}
        />

        <PermissionPrompt request={pending} />
        {picker && !pending ? <Selector request={picker} onResolve={resolvePicker} /> : null}

        {theme.layout.awarenessPosition !== 'top' ? awarenessBlock : null}

        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          // Dictation owns the line while it runs: a keystroke landing between
          // two phrases would be overwritten by the next one anyway.
          active={composerActive && !listening}
          busy={busy}
          history={history}
          listening={listening}
          ghost={partial}
        />

        <StatusBar
          model={config.model}
          totals={totals}
          permissionMode={config.permissionMode}
          autopilot={autopilot}
          voiceOut={voiceOut}
          listening={listening}
          handsFree={handsFree}
          awareness={awarenessOn}
        />
      </Box>
    </ThemeContext.Provider>
  );
}
