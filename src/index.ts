import './env.js';
import { env } from './env.js';
import { validateConnection as validateOverseerr } from './tools/overseerr.js';
import { validateConnection as validateRadarr } from './tools/radarr.js';
import { validateConnection as validateSonarr } from './tools/sonarr.js';
import { startRepl } from './cli/repl.js';
import { AuditLog } from './audit.js';
import type { StartupLine } from './cli/app.js';

const VERSION = process.env.npm_package_version ?? '0.1.0';

function parseArgs(argv: string[]): { yolo: boolean } {
  return {
    yolo: argv.includes('--yolo'),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      '✗ rtd2 is an interactive TTY app. Run it directly in a terminal — piping stdin/stdout is not supported.\n'
    );
    process.exit(1);
  }

  const startupLines: StartupLine[] = [];
  let fatal: string | null = null;

  try {
    await validateOverseerr();
    startupLines.push({ text: 'Overseerr connected', tone: 'ok' });
  } catch (e) {
    fatal = `Overseerr connection failed: ${(e as Error).message}\nCheck OVERSEERR_URL and OVERSEERR_API_KEY in .env`;
  }

  if (!fatal && env.RADARR_URL && env.RADARR_API_KEY) {
    try {
      await validateRadarr();
      startupLines.push({ text: 'Radarr connected', tone: 'ok' });
    } catch (e) {
      fatal = `Radarr connection failed: ${(e as Error).message}\nCheck RADARR_URL and RADARR_API_KEY in .env`;
    }
  }

  if (!fatal && env.SONARR_URL && env.SONARR_API_KEY) {
    try {
      await validateSonarr();
      startupLines.push({ text: 'Sonarr connected', tone: 'ok' });
    } catch (e) {
      fatal = `Sonarr connection failed: ${(e as Error).message}\nCheck SONARR_URL and SONARR_API_KEY in .env`;
    }
  }

  if (fatal) {
    process.stderr.write(`✗ ${fatal}\n`);
    process.exit(1);
  }

  const audit = new AuditLog();
  audit.append({
    type: 'session_start',
    ts: new Date().toISOString(),
    yolo: opts.yolo,
    version: VERSION,
  });
  startupLines.push({ text: `Audit log: ${audit.path}`, tone: 'info' });

  await startRepl({ ...opts, version: VERSION, audit, startupLines });
}

main().catch((e) => {
  process.stderr.write(`✗ Fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
