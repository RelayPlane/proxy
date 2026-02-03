/**
 * SQLite Schema Definition
 *
 * Defines the database schema for RelayPlane storage.
 *
 * @packageDocumentation
 */

/**
 * SQL statements for creating the database schema.
 */
export const SCHEMA_SQL = `
-- Runs table: stores all LLM invocations
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  system_prompt TEXT,
  task_type TEXT NOT NULL,
  model TEXT NOT NULL,
  success INTEGER NOT NULL,
  output TEXT,
  error TEXT,
  duration_ms INTEGER NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for task type queries
CREATE INDEX IF NOT EXISTS idx_runs_task_type ON runs(task_type);

-- Index for model queries
CREATE INDEX IF NOT EXISTS idx_runs_model ON runs(model);

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);

-- Outcomes table: stores user feedback on runs
CREATE TABLE IF NOT EXISTS outcomes (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  success INTEGER NOT NULL,
  quality TEXT,
  latency_satisfactory INTEGER,
  cost_satisfactory INTEGER,
  feedback TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id)
);

-- Index for run lookups
CREATE INDEX IF NOT EXISTS idx_outcomes_run_id ON outcomes(run_id);

-- Routing rules table: stores routing preferences
CREATE TABLE IF NOT EXISTS routing_rules (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL UNIQUE,
  preferred_model TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'default',
  confidence REAL,
  sample_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for task type lookups
CREATE INDEX IF NOT EXISTS idx_routing_rules_task_type ON routing_rules(task_type);

-- Suggestions table: stores routing improvement suggestions
CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  current_model TEXT NOT NULL,
  suggested_model TEXT NOT NULL,
  reason TEXT NOT NULL,
  confidence REAL NOT NULL,
  expected_improvement TEXT NOT NULL,
  sample_count INTEGER NOT NULL,
  accepted INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT
);

-- Index for task type lookups
CREATE INDEX IF NOT EXISTS idx_suggestions_task_type ON suggestions(task_type);

-- Index for pending suggestions
CREATE INDEX IF NOT EXISTS idx_suggestions_accepted ON suggestions(accepted);

-- Schema version table for migrations
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Insert initial schema version
INSERT OR IGNORE INTO schema_version (version) VALUES (1);
`;

/**
 * Default routing rules to seed the database.
 * Using -latest suffix for automatic model updates.
 */
export const DEFAULT_ROUTING_RULES = [
  // Complex tasks → Sonnet (need reasoning & quality)
  { taskType: 'code_generation', preferredModel: 'anthropic:claude-sonnet-4-20250514' },
  { taskType: 'code_review', preferredModel: 'anthropic:claude-sonnet-4-20250514' },
  { taskType: 'analysis', preferredModel: 'anthropic:claude-sonnet-4-20250514' },
  { taskType: 'creative_writing', preferredModel: 'anthropic:claude-sonnet-4-20250514' },
  // Simple tasks → Haiku (cost efficient)
  { taskType: 'summarization', preferredModel: 'anthropic:claude-3-5-haiku-latest' },
  { taskType: 'data_extraction', preferredModel: 'anthropic:claude-3-5-haiku-latest' },
  { taskType: 'translation', preferredModel: 'anthropic:claude-3-5-haiku-latest' },
  { taskType: 'question_answering', preferredModel: 'anthropic:claude-3-5-haiku-latest' },
  { taskType: 'general', preferredModel: 'anthropic:claude-3-5-haiku-latest' },
] as const;

/**
 * SQL for seeding default routing rules.
 */
export function generateSeedSQL(): string {
  const values = DEFAULT_ROUTING_RULES.map((rule, index) => {
    const id = `default-${rule.taskType}`;
    return `('${id}', '${rule.taskType}', '${rule.preferredModel}', 'default', NULL, NULL, datetime('now'), datetime('now'))`;
  }).join(',\n  ');

  return `
INSERT OR IGNORE INTO routing_rules (id, task_type, preferred_model, source, confidence, sample_count, created_at, updated_at)
VALUES
  ${values};
`;
}
