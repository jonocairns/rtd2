---
name: scratch-sqlite
description: Use a temporary SQLite database as scratch space when working with large datasets, large JSON/CSV files, long tool outputs, or list comparisons so only compact summaries and query results enter the context window.
---

# Scratch SQLite

Use this skill when a task involves large datasets, large JSON/CSV files, long tool outputs, repeated filtering/joining/grouping, or list comparisons that would bloat the context window.

## Goal

Put bulky data in SQLite, query it there, and bring only small result sets back into context.

## Storage

Prefer a temporary DB outside the repo:

```text
/tmp/rtd2-scratch-<short-task-name>.sqlite
```

Use `data/scratch-*.sqlite` only when the user wants the scratch DB to survive the session. `data/` is gitignored.

Do not commit scratch DB files.

## Workflow

1. Create a scratch DB with one table per source.
2. Import only structured fields needed for the task; avoid storing irrelevant huge text blobs unless the user needs text search.
3. Add indexes for join/filter keys before repeated queries.
4. Inspect with counts, schema, null rates, and sample rows.
5. Use SQL for joins, grouping, filtering, dedupe, ranking, and set differences.
6. Return only compact outputs: counts, top rows, missing IDs, anomalies, or paths to generated artifacts.

## Import Pattern

For JSON/JSONL/CSV, prefer a short Node script using `better-sqlite3` because this repo already depends on it. Keep scripts in `/tmp` unless the user asks to keep them.

Use transactions for bulk inserts:

```js
const db = new Database('/tmp/rtd2-scratch-task.sqlite');
db.exec('create table if not exists items (id text primary key, title text, year integer)');
const insert = db.prepare('insert or replace into items (id, title, year) values (?, ?, ?)');
const tx = db.transaction((rows) => {
  for (const row of rows) insert.run(row.id, row.title, row.year);
});
tx(rows);
```

## Query Discipline

Never dump full tables into the response. Start with:

```sql
select count(*) from table_name;
pragma table_info(table_name);
select * from table_name limit 5;
```

Then answer with targeted queries:

```sql
select genre, count(*) as n
from items
group by genre
order by n desc
limit 20;
```

For list gaps:

```sql
select wanted.*
from wanted
left join library using (tmdb_id)
where library.tmdb_id is null
order by wanted.rank;
```

## Context Hygiene

- Keep raw data in files/SQLite, not in chat.
- Prefer `limit 20` unless the user asks for all rows.
- If a result is still large, write it to a file and summarize the count/path.
- Preserve enough provenance columns to explain where each row came from.

## Safety

Treat scratch DBs as disposable. Before deleting or overwriting a non-`/tmp` DB, confirm it is scratch data. Never run destructive SQL against app databases such as `data/media-agent.sqlite` unless the user explicitly asks and the operation has been backed up or scoped.
