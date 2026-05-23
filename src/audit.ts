import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type AuditEvent =
  | { type: 'session_start'; ts: string; yolo: boolean; version: string }
  | { type: 'tool_call'; ts: string; tool: string; args: unknown }
  | {
      type: 'confirm_decision';
      ts: string;
      tool: string;
      args: unknown;
      resolved: string[];
      decision: 'approved' | 'declined';
    };

export class AuditLog {
  readonly path: string;

  constructor(dir = 'logs') {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.path = join(dir, `audit-${stamp}.jsonl`);
  }

  append(event: AuditEvent): void {
    try {
      appendFileSync(this.path, JSON.stringify(event) + '\n');
    } catch {
      // Audit log is best-effort — never let a write failure break the agent.
    }
  }
}
