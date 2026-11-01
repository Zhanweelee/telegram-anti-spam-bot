CREATE TABLE IF NOT EXISTS audits (
  tenant_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  message_id TEXT,
  text_sha256 TEXT,
  action TEXT NOT NULL,
  score REAL NOT NULL,
  reasons TEXT NOT NULL,
  evidence TEXT NOT NULL,
  rule_ids TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, chat_id, event_id)
);

CREATE TABLE IF NOT EXISTS rule_sets (
  tenant_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  document TEXT NOT NULL,
  PRIMARY KEY (tenant_id, chat_id)
);
