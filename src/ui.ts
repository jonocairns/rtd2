import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

marked.use(markedTerminal({ tab: 0 }) as never);

const isTTY = process.stdout.isTTY;
const c = (code: string) => (isTTY ? `\x1b[${code}m` : '');

export const colors = {
  reset: c('0'),
  dim: c('2'),
  bold: c('1'),
  cyan: c('36'),
  yellow: c('33'),
  green: c('32'),
  red: c('31'),
  blue: c('34'),
  magenta: c('35'),
  gray: c('90'),
};

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const LOGO = [
  ' ██████╗ ████████╗██████╗ ██████╗ ',
  ' ██╔══██╗╚══██╔══╝██╔══██╗╚════██╗',
  ' ██████╔╝   ██║   ██║  ██║ █████╔╝',
  ' ██╔══██╗   ██║   ██║  ██║██╔═══╝ ',
  ' ██║  ██║   ██║   ██████╔╝███████╗',
  ' ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚══════╝',
];

export function banner(opts: { version: string; toolCount: number; yolo: boolean }) {
  console.log('');
  for (const line of LOGO) {
    console.log(`  ${colors.cyan}${line}${colors.reset}`);
  }

  const subtitle = `  ${colors.dim}like R2D2, but for movies${colors.reset}  ${colors.gray}v${opts.version}${colors.reset}`;
  const logoWidth = LOGO[0].length;
  console.log(subtitle);
  console.log(`  ${colors.gray}${'─'.repeat(logoWidth)}${colors.reset}`);

  const meta = [
    `${colors.dim}${opts.toolCount} tools${colors.reset}`,
    opts.yolo ? `${colors.yellow}⚠ yolo${colors.reset}` : `${colors.dim}exit to quit${colors.reset}`,
  ].join(`  ${colors.gray}·${colors.reset}  `);
  console.log(`  ${meta}\n`);
}

export const PROMPT = `${colors.cyan}❯${colors.reset} `;

export function renderMarkdown(text: string): string {
  try {
    return String(marked.parse(text)).replace(/\n+$/, '');
  } catch {
    return text;
  }
}

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
  private interval: NodeJS.Timeout | null = null;
  private frame = 0;
  private label = '';

  start(label = 'thinking') {
    if (!isTTY) return;
    if (this.interval !== null) return;
    this.label = label;
    this.frame = 0;
    process.stdout.write(`${colors.dim}${frames[0]} ${this.label}…${colors.reset}`);
    this.interval = setInterval(() => {
      this.frame = (this.frame + 1) % frames.length;
      process.stdout.write(`\r\x1b[K${colors.dim}${frames[this.frame]} ${this.label}…${colors.reset}`);
    }, 80);
  }

  stop() {
    if (this.interval === null) return;
    clearInterval(this.interval);
    this.interval = null;
    if (isTTY) process.stdout.write('\r\x1b[K');
  }

  restart(label = 'thinking') {
    this.stop();
    this.start(label);
  }
}

export function toolCall(name: string, args: string) {
  const summary = args.length > 80 ? args.slice(0, 77) + '…' : args;
  console.log(`${colors.dim}⚙${colors.reset} ${colors.cyan}${name}${colors.reset} ${colors.gray}${summary}${colors.reset}`);
}

export function subagentStart(id: number, task: string) {
  const summary = task.length > 96 ? task.slice(0, 93) + '…' : task;
  console.log(`${colors.magenta}┌ subagent #${id}${colors.reset} ${colors.gray}${summary}${colors.reset}`);
}

export function subagentToolCall(id: number, name: string, args: string) {
  const summary = args.length > 88 ? args.slice(0, 85) + '…' : args;
  console.log(`${colors.magenta}│${colors.reset} ${colors.dim}⚙${colors.reset} ${colors.cyan}${name}${colors.reset} ${colors.gray}${summary}${colors.reset}`);
}

export function subagentDone(id: number, toolCallCount: number) {
  const noun = toolCallCount === 1 ? 'tool call' : 'tool calls';
  console.log(`${colors.magenta}└ subagent #${id} done${colors.reset} ${colors.gray}${toolCallCount} ${noun}${colors.reset}`);
}

export function subagentError(id: number, message: string) {
  const summary = message.length > 96 ? message.slice(0, 93) + '…' : message;
  console.log(`${colors.magenta}└ subagent #${id} failed${colors.reset} ${colors.red}${summary}${colors.reset}`);
}

export function box(title: string, body: string[], color = colors.yellow) {
  const stripped = body.map(stripAnsi);
  const inner = Math.max(stripped.reduce((m, l) => Math.max(m, l.length), 0), title.length + 4);
  const tail = '─'.repeat(Math.max(0, inner - title.length - 2));

  console.log(`\n${color}╭─ ${colors.bold}${title}${colors.reset}${color} ${tail}╮${colors.reset}`);
  for (let i = 0; i < body.length; i++) {
    const pad = ' '.repeat(inner - stripped[i].length);
    console.log(`${color}│${colors.reset} ${body[i]}${pad} ${color}│${colors.reset}`);
  }
  console.log(`${color}╰${'─'.repeat(inner + 2)}╯${colors.reset}`);
}

export function yesNoChoices(opts?: { yesLabel?: string; noLabel?: string; recommended?: 'yes' | 'no' }) {
  const recommended = opts?.recommended ?? 'no';
  const yes = opts?.yesLabel ?? 'Yes, proceed';
  const no = opts?.noLabel ?? 'No, cancel';
  return [
    `${recommended === 'yes' ? '(•)' : '( )'} ${yes}`,
    `${recommended === 'no' ? '(•)' : '( )'} ${no}`,
  ];
}

export function ok(msg: string) {
  console.log(`${colors.green}✓${colors.reset} ${msg}`);
}

export function info(msg: string) {
  console.log(`${colors.dim}${msg}${colors.reset}`);
}

export function warn(msg: string) {
  console.log(`${colors.yellow}⚠${colors.reset} ${msg}`);
}

export function error(msg: string) {
  console.error(`${colors.red}✗${colors.reset} ${msg}`);
}

// Approximate pricing for the default OpenAI model (USD per million tokens).
// This is only a local display estimate; evals resolve model-specific rates.
const PRICE = {
  input: 1.75,
  output: 14.0,
  cacheWrite: 1.75,
  cacheRead: 0.175,
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

export function costUsd(u: TokenUsage): number {
  return (
    (u.inputTokens * PRICE.input +
      u.outputTokens * PRICE.output +
      u.cacheWriteTokens * PRICE.cacheWrite +
      u.cacheReadTokens * PRICE.cacheRead) /
    1_000_000
  );
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtCost(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(3)}¢`;
  return `$${usd.toFixed(4)}`;
}

export function usageLine(turn: TokenUsage, session: TokenUsage) {
  const parts = [
    `${fmtTokens(turn.inputTokens)} in`,
    `${fmtTokens(turn.outputTokens)} out`,
  ];
  if (turn.cacheReadTokens > 0) parts.push(`${fmtTokens(turn.cacheReadTokens)} cache-hit`);
  if (turn.cacheWriteTokens > 0) parts.push(`${fmtTokens(turn.cacheWriteTokens)} cache-write`);
  parts.push(`${fmtCost(costUsd(turn))} turn`);
  parts.push(`${fmtCost(costUsd(session))} session`);
  console.log(`${colors.gray}↳ ${parts.join(' · ')}${colors.reset}`);
}
