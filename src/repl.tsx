import { render } from 'ink';
import { App, type StartupLine } from './app.js';
import type { AuditLog } from './audit.js';

export async function startRepl({
  yolo,
  version,
  audit,
  startupLines,
}: {
  yolo: boolean;
  version: string;
  audit: AuditLog;
  startupLines: StartupLine[];
}): Promise<void> {
  const instance = render(<App yolo={yolo} version={version} audit={audit} startupLines={startupLines} />);
  await instance.waitUntilExit();
}
