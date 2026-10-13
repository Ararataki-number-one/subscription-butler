CREATE TABLE IF NOT EXISTS ops_record (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ops_record_kind_idx ON ops_record(kind);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ops_command (
  id TEXT PRIMARY KEY NOT NULL,
  hash TEXT NOT NULL,
  result TEXT NOT NULL CHECK(json_valid(result)),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ops_change (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ops_change_record_idx ON ops_change(record_id, seq);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ops_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  record_ids TEXT NOT NULL CHECK(json_valid(record_ids)),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ops_legacy_owner (
  record_id TEXT PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ops_legacy_conflict (
  record_id TEXT PRIMARY KEY NOT NULL,
  local_fingerprint TEXT NOT NULL,
  detected_at TEXT NOT NULL
);
