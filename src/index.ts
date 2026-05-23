import './env.js';
import { env } from './env.js';
import { validateConnection as validateOverseerr } from './tools/overseerr.js';
import { validateConnection as validateRadarr } from './tools/radarr.js';
import { validateConnection as validateSonarr } from './tools/sonarr.js';
import { startRepl } from './repl.js';
import { AuditLog } from './audit.js';
import { ok, info, error } from './ui.js';

const VERSION = process.env.npm_package_version ?? '0.1.0';

function parseArgs(argv: string[]): { yolo: boolean } {
  return {
    yolo: argv.includes('--yolo'),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  try {
    await validateOverseerr();
    ok('Overseerr connected');
  } catch (e) {
    error(`Overseerr connection failed: ${(e as Error).message}`);
    error('Check OVERSEERR_URL and OVERSEERR_API_KEY in .env');
    process.exit(1);
  }

  if (env.RADARR_URL && env.RADARR_API_KEY) {
    try {
      await validateRadarr();
      ok('Radarr connected');
    } catch (e) {
      error(`Radarr connection failed: ${(e as Error).message}`);
      error('Check RADARR_URL and RADARR_API_KEY in .env');
      process.exit(1);
    }
  }

  if (env.SONARR_URL && env.SONARR_API_KEY) {
    try {
      await validateSonarr();
      ok('Sonarr connected');
    } catch (e) {
      error(`Sonarr connection failed: ${(e as Error).message}`);
      error('Check SONARR_URL and SONARR_API_KEY in .env');
      process.exit(1);
    }
  }

  const audit = new AuditLog();
  audit.append({
    type: 'session_start',
    ts: new Date().toISOString(),
    yolo: opts.yolo,
    version: VERSION,
  });
  info(`Audit log: ${audit.path}`);

  await startRepl({ ...opts, version: VERSION, audit });
}

main().catch((e) => {
  error(`Fatal: ${(e as Error).message}`);
  process.exit(1);
});
