import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useAnimation, useApp, useInput, usePaste, useStdout } from 'ink';
import { run, type AgentEvent, type PromptInput } from './agent.js';
import {
  createConfirmGate,
  type BlockedNotice,
  type ConfirmRequest,
} from './confirm.js';
import type { AuditLog } from './audit.js';
import type { SubagentEvent } from './investigator.js';
import { baseToolDescriptors } from './tool-registry.js';
import { addUsage, costUsd, emptyUsage, renderMarkdown, type TokenUsage } from './ui.js';

const TOOL_COUNT = baseToolDescriptors.length + 1; // + media_investigate

const LOGO = [
  ' ██████╗ ████████╗██████╗ ██████╗ ',
  ' ██╔══██╗╚══██╔══╝██╔══██╗╚════██╗',
  ' ██████╔╝   ██║   ██║  ██║ █████╔╝',
  ' ██╔══██╗   ██║   ██║  ██║██╔═══╝ ',
  ' ██║  ██║   ██║   ██████╔╝███████╗',
  ' ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚══════╝',
];

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface StartupLine {
  text: string;
  tone: 'ok' | 'info' | 'error';
}

type HistorySeed =
  | { kind: 'banner'; version: string; toolCount: number; yolo: boolean }
  | { kind: 'startup'; lines: StartupLine[] }
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; markdown: string }
  | { kind: 'tool_call'; name: string; args: string }
  | { kind: 'subagent_start'; subId: number; task: string }
  | { kind: 'subagent_tool'; subId: number; name: string; args: string }
  | { kind: 'subagent_done'; subId: number; toolCallCount: number }
  | { kind: 'subagent_error'; subId: number; message: string }
  | { kind: 'usage'; turn: TokenUsage; session: TokenUsage }
  | { kind: 'confirm_resolved'; displayName: string; lines: string[]; approved: boolean }
  | { kind: 'blocked'; title: string; lines: string[] }
  | { kind: 'error'; message: string }
  | { kind: 'note'; title: string; lines: string[]; tone: 'info' | 'warn' }
  | { kind: 'cleared' };

type HistoryItem = HistorySeed & { id: number };

export interface AppProps {
  yolo: boolean;
  version: string;
  audit: AuditLog;
  startupLines: StartupLine[];
}

type BridgeItem = PromptInput | { type: 'close' };

// Bridges React input events to the agent's async-iterable prompt contract.
// The agent awaits next(); React resolves it when the user submits text or
// invokes a control command like /new (reset).
function createInputBridge() {
  const queue: BridgeItem[] = [];
  let resolver: ((item: BridgeItem) => void) | null = null;
  let closed = false;

  function pushItem(item: BridgeItem) {
    if (closed) return;
    if (resolver) {
      const r = resolver;
      resolver = null;
      r(item);
    } else {
      queue.push(item);
    }
  }

  return {
    pushText(text: string) {
      pushItem({ type: 'user', message: { role: 'user', content: text } });
    },
    pushReset() {
      pushItem({ type: 'reset' });
    },
    close() {
      closed = true;
      pushItem({ type: 'close' });
    },
    async *iterate(): AsyncIterable<PromptInput> {
      while (!closed) {
        const item = queue.length > 0 ? queue.shift()! : await new Promise<BridgeItem>((res) => {
          resolver = res;
        });
        if (closed || item.type === 'close') return;
        yield item;
      }
    },
  };
}

interface ActiveConfirm extends ConfirmRequest {
  resolve: (approved: boolean) => void;
}

function Spinner({ label }: { label: string }) {
  const { frame } = useAnimation({ interval: 80 });
  const ch = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  return (
    <Text dimColor>
      {ch} {label}…
    </Text>
  );
}

function Banner({
  version,
  toolCount,
  yolo,
}: {
  version: string;
  toolCount: number;
  yolo: boolean;
}) {
  const logoWidth = LOGO[0].length;
  return (
    <Box flexDirection="column">
      <Text> </Text>
      {LOGO.map((line, i) => (
        <Text key={i} color="cyan">
          {`  ${line}`}
        </Text>
      ))}
      <Box>
        <Text>{'  '}</Text>
        <Text dimColor>like R2D2, but for movies</Text>
        <Text>{'  '}</Text>
        <Text color="gray">v{version}</Text>
      </Box>
      <Text color="gray">{`  ${'─'.repeat(logoWidth)}`}</Text>
      <Box>
        <Text>{'  '}</Text>
        <Text dimColor>{toolCount} tools</Text>
        <Text color="gray">{'  ·  '}</Text>
        {yolo ? <Text color="yellow">⚠ yolo</Text> : <Text dimColor>exit to quit</Text>}
      </Box>
      <Text> </Text>
    </Box>
  );
}

function HistoryEntry({ item }: { item: HistoryItem }) {
  switch (item.kind) {
    case 'banner':
      return <Banner version={item.version} toolCount={item.toolCount} yolo={item.yolo} />;

    case 'startup':
      return (
        <Box flexDirection="column">
          {item.lines.map((l, i) => {
            if (l.tone === 'ok') {
              return (
                <Box key={i}>
                  <Text color="green">✓</Text>
                  <Text> {l.text}</Text>
                </Box>
              );
            }
            if (l.tone === 'error') {
              return (
                <Box key={i}>
                  <Text color="red">✗</Text>
                  <Text> {l.text}</Text>
                </Box>
              );
            }
            return (
              <Text key={i} dimColor>
                {l.text}
              </Text>
            );
          })}
        </Box>
      );

    case 'user':
      return (
        <Box>
          <Text color="cyan">❯ </Text>
          <Text>{item.text}</Text>
        </Box>
      );

    case 'assistant':
      return <Text>{renderMarkdown(item.markdown)}</Text>;

    case 'tool_call': {
      const trimmed = item.args === '{}' ? '' : item.args;
      const summary = trimmed.length > 80 ? trimmed.slice(0, 77) + '…' : trimmed;
      return (
        <Box>
          <Text dimColor>⚙ </Text>
          <Text color="cyan">{item.name}</Text>
          {summary ? <Text color="gray"> {summary}</Text> : null}
        </Box>
      );
    }

    case 'subagent_start': {
      const summary = item.task.length > 96 ? item.task.slice(0, 93) + '…' : item.task;
      return (
        <Box>
          <Text color="magenta">┌ subagent #{item.subId}</Text>
          <Text color="gray"> {summary}</Text>
        </Box>
      );
    }

    case 'subagent_tool': {
      const trimmed = item.args === '{}' ? '' : item.args;
      const summary = trimmed.length > 88 ? trimmed.slice(0, 85) + '…' : trimmed;
      return (
        <Box>
          <Text color="magenta">│ </Text>
          <Text dimColor>⚙ </Text>
          <Text color="cyan">{item.name}</Text>
          {summary ? <Text color="gray"> {summary}</Text> : null}
        </Box>
      );
    }

    case 'subagent_done': {
      const noun = item.toolCallCount === 1 ? 'tool call' : 'tool calls';
      return (
        <Box>
          <Text color="magenta">└ subagent #{item.subId} done</Text>
          <Text color="gray">
            {' '}
            {item.toolCallCount} {noun}
          </Text>
        </Box>
      );
    }

    case 'subagent_error': {
      const summary = item.message.length > 96 ? item.message.slice(0, 93) + '…' : item.message;
      return (
        <Box>
          <Text color="magenta">└ subagent #{item.subId} failed</Text>
          <Text color="red"> {summary}</Text>
        </Box>
      );
    }

    case 'usage':
      return <UsageLine turn={item.turn} session={item.session} />;

    case 'confirm_resolved':
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={item.approved ? 'green' : 'yellow'}
          paddingX={1}
        >
          <Text bold>
            {item.approved ? 'Approved' : 'Declined'}: {item.displayName}
          </Text>
          {item.lines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      );

    case 'blocked':
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
          <Text bold color="red">
            {item.title}
          </Text>
          {item.lines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      );

    case 'error':
      return (
        <Box>
          <Text color="red">✗ </Text>
          <Text>{item.message}</Text>
        </Box>
      );

    case 'note': {
      const color = item.tone === 'warn' ? 'yellow' : 'cyan';
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
          <Text bold color={color}>
            {item.title}
          </Text>
          {item.lines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      );
    }

    case 'cleared':
      return <Text color="gray">── cleared ──</Text>;
  }
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtCost(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(3)}¢`;
  return `$${usd.toFixed(4)}`;
}

function UsageLine({ turn, session }: { turn: TokenUsage; session: TokenUsage }) {
  const parts = [`${fmtTokens(turn.inputTokens)} in`, `${fmtTokens(turn.outputTokens)} out`];
  if (turn.cacheReadTokens > 0) parts.push(`${fmtTokens(turn.cacheReadTokens)} cache-hit`);
  if (turn.cacheWriteTokens > 0) parts.push(`${fmtTokens(turn.cacheWriteTokens)} cache-write`);
  parts.push(`${fmtCost(costUsd(turn))} turn`);
  parts.push(`${fmtCost(costUsd(session))} session`);
  return <Text color="gray">↳ {parts.join(' · ')}</Text>;
}

function StatusBar({
  session,
  mode,
  yolo,
  toolCount,
}: {
  session: TokenUsage;
  mode: 'idle' | 'thinking' | 'processing' | 'confirm';
  yolo: boolean;
  toolCount: number;
}) {
  const totalTokens =
    session.inputTokens +
    session.outputTokens +
    session.cacheReadTokens +
    session.cacheWriteTokens;
  const modeLabel =
    mode === 'idle' ? 'idle' : mode === 'confirm' ? 'awaiting confirm' : mode;
  const modeColor =
    mode === 'idle' ? 'gray' : mode === 'confirm' ? 'yellow' : 'cyan';

  return (
    <Box>
      <Text color={modeColor}>● </Text>
      <Text color={modeColor}>{modeLabel}</Text>
      <Text color="gray"> · </Text>
      <Text dimColor>{toolCount} tools</Text>
      <Text color="gray"> · </Text>
      <Text dimColor>{fmtTokens(totalTokens)} tok</Text>
      <Text color="gray"> · </Text>
      <Text dimColor>{fmtCost(costUsd(session))} session</Text>
      {yolo ? (
        <>
          <Text color="gray"> · </Text>
          <Text color="yellow">⚠ yolo</Text>
        </>
      ) : null}
    </Box>
  );
}

interface SlashCommand {
  name: string;
  desc: string;
}

// Splits `/exit, /quit` into `['/exit', '/quit']` and strips `[args]` so we
// can do prefix matching against each alias's bare command name.
function commandAliases(c: SlashCommand): string[] {
  return c.name.split(/,\s*/).map((alias) => alias.split(/\s+/)[0]);
}

function PromptBar({
  active,
  onSubmit,
  commands,
}: {
  active: boolean;
  onSubmit: (text: string) => void;
  commands: SlashCommand[];
}) {
  const [buffer, setBuffer] = useState('');
  const [selected, setSelected] = useState(0);

  // Match by the first whitespace-delimited token in the buffer so the picker
  // keeps showing once the user starts typing args (e.g. "/export foo.md").
  const firstToken = buffer.split(/\s+/)[0];
  const showPicker = firstToken.startsWith('/');
  const filtered = useMemo(() => {
    if (!showPicker) return [];
    const q = firstToken.toLowerCase();
    return commands.filter((c) =>
      commandAliases(c).some((alias) => alias.toLowerCase().startsWith(q))
    );
  }, [commands, firstToken, showPicker]);

  // Keep the selected index in range as the filter shrinks/grows.
  useEffect(() => {
    if (selected >= filtered.length) setSelected(0);
  }, [filtered.length, selected]);

  usePaste(
    (text) => {
      const cleaned = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ');
      setBuffer((b) => b + cleaned);
    },
    { isActive: active }
  );

  useInput(
    (ch, key) => {
      const pickerActive = filtered.length > 0;

      if (pickerActive && key.upArrow) {
        setSelected((s) => Math.max(0, s - 1));
        return;
      }
      if (pickerActive && key.downArrow) {
        setSelected((s) => Math.min(filtered.length - 1, s + 1));
        return;
      }
      if (pickerActive && key.tab) {
        // Tab completes the buffer to the highlighted command's first alias,
        // preserving any args the user already typed after the command name.
        const completion = commandAliases(filtered[selected])[0];
        const rest = buffer.slice(firstToken.length); // includes leading space if any
        setBuffer(completion + (rest.length > 0 ? rest : ' '));
        setSelected(0);
        return;
      }

      if (key.return) {
        const trimmed = buffer.trim();
        setBuffer('');
        setSelected(0);
        if (trimmed) onSubmit(trimmed);
        return;
      }
      if (key.backspace || key.delete) {
        setBuffer((b) => b.slice(0, -1));
        return;
      }
      if (key.escape) {
        // Clear the line — also dismisses the picker as a side effect.
        setBuffer('');
        setSelected(0);
        return;
      }
      if (key.ctrl || key.meta) return;
      if (ch) {
        setBuffer((b) => b + ch);
      }
    },
    { isActive: active }
  );

  return (
    <Box flexDirection="column">
      {filtered.length > 0 ? (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text dimColor>↑↓ select · Tab complete · Enter submit</Text>
          {filtered.map((c, i) => {
            const isSelected = i === selected;
            return (
              <Box key={c.name}>
                <Text color={isSelected ? 'cyan' : 'gray'}>{isSelected ? '▸ ' : '  '}</Text>
                <Text bold={isSelected} color={isSelected ? 'cyan' : undefined}>
                  {c.name.padEnd(18)}
                </Text>
                <Text dimColor> {c.desc}</Text>
              </Box>
            );
          })}
        </Box>
      ) : null}
      <Box>
        <Text color="cyan">❯ </Text>
        <Text>{buffer}</Text>
        {active ? <Text dimColor>▎</Text> : null}
      </Box>
    </Box>
  );
}

function ConfirmBar({
  request,
  queueLength,
  onResolve,
}: {
  request: ActiveConfirm;
  queueLength: number;
  onResolve: (approved: boolean) => void;
}) {
  useInput((ch, key) => {
    if (key.return || key.escape) {
      onResolve(false);
      return;
    }
    const lower = ch.toLowerCase();
    if (lower === 'y') onResolve(true);
    if (lower === 'n') onResolve(false);
  });

  const queueNote =
    queueLength > 1 ? ` (1 of ${queueLength} pending)` : '';

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="yellow"
        paddingX={1}
      >
        <Text bold>Confirmation required{queueNote}</Text>
        {request.lines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
        <Text> </Text>
        <Text>y - Yes, run this exact tool call</Text>
        <Text>N - No, cancel (default)</Text>
      </Box>
      <Box>
        <Text color="yellow">Choose [y/N] </Text>
      </Box>
    </Box>
  );
}

const SLASH_COMMANDS: { name: string; desc: string }[] = [
  { name: '/help', desc: 'Show this list of slash commands' },
  { name: '/new', desc: 'Start a new conversation (resets agent message history and visible scrollback)' },
  { name: '/clear', desc: 'Wipe visible history only; agent context is preserved' },
  { name: '/yolo', desc: 'Toggle yolo mode (skip confirmation gates for mutating tools)' },
  { name: '/usage', desc: 'Show current session token + cost totals' },
  { name: '/export [file]', desc: 'Show audit log path; with [file], also write a transcript there' },
  { name: '/exit, /quit', desc: 'Exit the REPL' },
];

export function App({ yolo: initialYolo, version, audit, startupLines }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [history, setHistory] = useState<HistoryItem[]>(() => [
    { id: 0, kind: 'banner', version, toolCount: TOOL_COUNT, yolo: initialYolo },
    { id: 1, kind: 'startup', lines: startupLines },
  ]);
  const idRef = useRef(2);
  const nextId = () => idRef.current++;
  const appendHistory = (item: HistorySeed) => {
    setHistory((prev) => [...prev, { ...item, id: nextId() }]);
  };

  const [streamingText, setStreamingText] = useState('');
  const [spinnerLabel, setSpinnerLabel] = useState<string | null>(null);
  // Queue, not a single slot — when the agent fires multiple mutating tool
  // calls in one parallel batch we receive multiple promptConfirm() calls back
  // to back. A single-slot state would have later calls overwrite earlier ones
  // and strand their resolve() callbacks, deadlocking the agent loop.
  const [confirmQueue, setConfirmQueue] = useState<ActiveConfirm[]>([]);
  const activeConfirm = confirmQueue[0] ?? null;
  const [waitingForInput, setWaitingForInput] = useState(false);
  // Session-wide usage in React state so the StatusBar always reflects it,
  // separate from the per-turn `usage` history entry committed in <Static>.
  const [sessionUsage, setSessionUsage] = useState<TokenUsage>(emptyUsage);
  // Yolo state mirrors a ref so the gate can read the current value at
  // tool-call time AND the StatusBar can re-render when toggled.
  const [yolo, setYolo] = useState(initialYolo);
  const yoloRef = useRef(initialYolo);

  const inputBridge = useMemo(() => createInputBridge(), []);
  const agentStartedRef = useRef(false);

  // Always-active Ctrl+C handler. Other components' useInput handlers also
  // receive the event, but they filter out Ctrl+anything so there's no clash.
  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') {
      inputBridge.close();
      exit();
    }
  });

  useEffect(() => {
    // Guard against React 18+ dev double-mount: only ever start one agent
    // loop, never two racing for inputBridge.iterate().
    if (agentStartedRef.current) return;
    agentStartedRef.current = true;
    let cancelled = false;

    const promptConfirm = (req: ConfirmRequest): Promise<boolean> =>
      new Promise((resolve) => {
        setConfirmQueue((prev) => [...prev, { ...req, resolve }]);
      });

    const notifyBlocked = (notice: BlockedNotice) => {
      appendHistory({ kind: 'blocked', title: notice.title, lines: notice.lines });
    };

    const canUseTool = createConfirmGate({
      isYolo: () => yoloRef.current,
      audit,
      prompt: promptConfirm,
      notifyBlocked,
    });

    const onSubagentEvent = (event: SubagentEvent) => {
      switch (event.type) {
        case 'start':
          appendHistory({ kind: 'subagent_start', subId: event.id, task: event.task });
          break;
        case 'tool_call':
          appendHistory({
            kind: 'subagent_tool',
            subId: event.id,
            name: event.name,
            args: JSON.stringify(event.input ?? {}),
          });
          audit.append({
            type: 'tool_call',
            ts: new Date().toISOString(),
            tool: `subagent#${event.id}:${event.name}`,
            args: event.input ?? {},
          });
          break;
        case 'done':
          appendHistory({ kind: 'subagent_done', subId: event.id, toolCallCount: event.toolCallCount });
          break;
        case 'error':
          appendHistory({ kind: 'subagent_error', subId: event.id, message: event.message });
          break;
      }
    };

    (async () => {
      let session: TokenUsage = emptyUsage();
      let turn: TokenUsage = emptyUsage();
      let pending = '';
      setWaitingForInput(true);

      try {
        for await (const event of run({
          prompt: inputBridge.iterate(),
          canUseTool,
          onSubagentEvent,
        }) as AsyncIterable<AgentEvent>) {
          if (cancelled) break;
          switch (event.type) {
            case 'user':
              turn = emptyUsage();
              pending = '';
              setStreamingText('');
              setSpinnerLabel('thinking');
              setWaitingForInput(false);
              break;
            case 'reset':
              // Agent context was cleared via /new. The slash-command handler
              // already pushed a visible note; nothing more to render here.
              turn = emptyUsage();
              session = emptyUsage();
              setSessionUsage(session);
              break;
            case 'assistant_text_delta':
              pending += event.text;
              setStreamingText(pending);
              setSpinnerLabel(null);
              break;
            case 'tool_call':
              if (pending.trim()) {
                appendHistory({ kind: 'assistant', markdown: pending });
                pending = '';
                setStreamingText('');
              }
              appendHistory({
                kind: 'tool_call',
                name: event.name,
                args: JSON.stringify(event.input ?? {}),
              });
              audit.append({
                type: 'tool_call',
                ts: new Date().toISOString(),
                tool: event.name,
                args: event.input ?? {},
              });
              setSpinnerLabel('processing');
              break;
            case 'usage': {
              const u: TokenUsage = {
                inputTokens: event.usage.inputTokens ?? 0,
                outputTokens: event.usage.outputTokens ?? 0,
                cacheWriteTokens: event.usage.cacheWriteTokens ?? 0,
                cacheReadTokens: event.usage.cacheReadTokens ?? 0,
              };
              turn = addUsage(turn, u);
              session = addUsage(session, u);
              setSessionUsage(session);
              break;
            }
            case 'assistant_done':
              if (pending.trim()) {
                appendHistory({ kind: 'assistant', markdown: pending });
              }
              pending = '';
              setStreamingText('');
              setSpinnerLabel(null);
              appendHistory({ kind: 'usage', turn, session });
              setWaitingForInput(true);
              break;
          }
        }
      } catch (e) {
        appendHistory({ kind: 'error', message: `Agent error: ${(e as Error).message}` });
        setSpinnerLabel(null);
        setWaitingForInput(true);
      }
    })();

    return () => {
      cancelled = true;
      inputBridge.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runCommand = (raw: string) => {
    const [head, ...rest] = raw.trim().split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (head) {
      case '/help':
        appendHistory({
          kind: 'note',
          title: 'Slash commands',
          tone: 'info',
          lines: SLASH_COMMANDS.map((c) => `${c.name.padEnd(18)} ${c.desc}`),
        });
        return;
      case '/clear':
        // Wipe the visible terminal area, then reset state so <Static>
        // doesn't try to redraw the (now-flushed) committed items. Agent
        // context is unaffected — only the rendered scrollback resets.
        stdout.write('\x1b[2J\x1b[3J\x1b[H');
        idRef.current = 0;
        setHistory([{ id: nextId(), kind: 'cleared' }]);
        return;
      case '/new':
        // Same visual wipe as /clear, plus a reset signal to the agent so the
        // next prompt starts with an empty message array (the agent will also
        // emit a 'reset' event that zeroes sessionUsage).
        stdout.write('\x1b[2J\x1b[3J\x1b[H');
        idRef.current = 0;
        setHistory([
          { id: nextId(), kind: 'banner', version, toolCount: TOOL_COUNT, yolo: yoloRef.current },
          {
            id: nextId(),
            kind: 'note',
            title: 'New conversation',
            tone: 'info',
            lines: ['Agent message history cleared. Cache reads will rebuild from scratch.'],
          },
        ]);
        inputBridge.pushReset();
        return;
      case '/yolo': {
        const next = !yoloRef.current;
        yoloRef.current = next;
        setYolo(next);
        appendHistory({
          kind: 'note',
          title: next ? 'yolo ON' : 'yolo OFF',
          tone: next ? 'warn' : 'info',
          lines: next
            ? ['Mutating tools will run without confirmation. Use /yolo again to turn off.']
            : ['Confirmation gates restored for mutating tools.'],
        });
        return;
      }
      case '/usage':
        appendHistory({
          kind: 'note',
          title: 'Session usage',
          tone: 'info',
          lines: [
            `Input:        ${sessionUsage.inputTokens.toLocaleString()} tokens`,
            `Output:       ${sessionUsage.outputTokens.toLocaleString()} tokens`,
            `Cache read:   ${sessionUsage.cacheReadTokens.toLocaleString()} tokens`,
            `Cache write:  ${sessionUsage.cacheWriteTokens.toLocaleString()} tokens`,
            `Total cost:   ${fmtCost(costUsd(sessionUsage))}`,
          ],
        });
        return;
      case '/export': {
        const lines: string[] = [`Audit log path: ${audit.path}`];
        if (arg) {
          try {
            const dest = arg.startsWith('/') ? arg : join(process.cwd(), arg);
            const transcript = history
              .map((h) => {
                if (h.kind === 'user') return `> ${h.text}`;
                if (h.kind === 'assistant') return h.markdown;
                if (h.kind === 'tool_call') return `[tool ${h.name}] ${h.args}`;
                return null;
              })
              .filter((x): x is string => x !== null)
              .join('\n\n');
            writeFileSync(dest, transcript + '\n');
            lines.push(`Transcript written to ${dest}`);
          } catch (e) {
            lines.push(`Could not write transcript: ${(e as Error).message}`);
          }
        }
        appendHistory({ kind: 'note', title: 'Export', tone: 'info', lines });
        return;
      }
      case '/exit':
      case '/quit':
        inputBridge.close();
        exit();
        return;
      default:
        appendHistory({
          kind: 'note',
          title: 'Unknown command',
          tone: 'warn',
          lines: [`No such slash command: ${head}. Try /help.`],
        });
    }
  };

  const handleSubmit = (text: string) => {
    if (text === 'exit' || text === 'quit') {
      inputBridge.close();
      exit();
      return;
    }
    if (text.startsWith('/')) {
      appendHistory({ kind: 'user', text });
      runCommand(text);
      return;
    }
    appendHistory({ kind: 'user', text });
    inputBridge.pushText(text);
  };

  const handleConfirmResolve = (approved: boolean) => {
    if (!activeConfirm) return;
    const snapshot = activeConfirm;
    setConfirmQueue((prev) => prev.slice(1));
    appendHistory({
      kind: 'confirm_resolved',
      displayName: snapshot.displayName,
      lines: snapshot.lines,
      approved,
    });
    snapshot.resolve(approved);
  };

  const mode: 'idle' | 'thinking' | 'processing' | 'confirm' = activeConfirm
    ? 'confirm'
    : spinnerLabel === 'thinking'
      ? 'thinking'
      : spinnerLabel === 'processing'
        ? 'processing'
        : 'idle';

  return (
    <Box flexDirection="column">
      <Static items={history}>{(item) => <HistoryEntry key={item.id} item={item} />}</Static>
      {streamingText ? <Text>{renderMarkdown(streamingText)}</Text> : null}
      {spinnerLabel ? <Spinner label={spinnerLabel} /> : null}
      <StatusBar session={sessionUsage} mode={mode} yolo={yolo} toolCount={TOOL_COUNT} />
      {activeConfirm ? (
        <ConfirmBar
          request={activeConfirm}
          queueLength={confirmQueue.length}
          onResolve={handleConfirmResolve}
        />
      ) : waitingForInput ? (
        <PromptBar active onSubmit={handleSubmit} commands={SLASH_COMMANDS} />
      ) : null}
    </Box>
  );
}
