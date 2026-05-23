import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DEFAULT_DB_PATH = path.resolve('data/media-agent.sqlite');
const MEDIA_TITLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface MediaTitle {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  title: string;
  year: string | null;
}

interface StoreRow {
  value: string;
  updated_at: number;
}

let db: Database.Database | null = null;
let dbPath = process.env.MEDIA_AGENT_DB ?? DEFAULT_DB_PATH;
let now = () => Date.now();

function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_store (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (namespace, key)
    );
  `);
  return db;
}

function mediaTitleKey(mediaType: 'movie' | 'tv', tmdbId: number): string {
  return `${mediaType}:${tmdbId}`;
}

export function getStoreValue<T>(namespace: string, key: string, ttlMs: number): T | null {
  const row = getDb()
    .prepare('SELECT value, updated_at FROM tool_store WHERE namespace = ? AND key = ?')
    .get(namespace, key) as StoreRow | undefined;
  if (!row) return null;
  if (now() - row.updated_at > ttlMs) return null;
  return JSON.parse(row.value) as T;
}

export function setStoreValue(namespace: string, key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO tool_store (namespace, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
    .run(namespace, key, JSON.stringify(value), now());
}

export function getStoredMediaTitle(
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  ttlMs = MEDIA_TITLE_TTL_MS
): MediaTitle | null {
  return getStoreValue<MediaTitle>('media_title', mediaTitleKey(mediaType, tmdbId), ttlMs);
}

export function storeMediaTitle(title: MediaTitle): void {
  setStoreValue('media_title', mediaTitleKey(title.mediaType, title.tmdbId), title);
}

export function resetDbForTests(pathname?: string): void {
  db?.close();
  db = null;
  dbPath = pathname ?? process.env.MEDIA_AGENT_DB ?? DEFAULT_DB_PATH;
  now = () => Date.now();
}

export function setDbClockForTests(clock: () => number): void {
  now = clock;
}
