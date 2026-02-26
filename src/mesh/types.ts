/**
 * Osmosis Knowledge Mesh — Types
 * Adapted from ~/osmosis/packages/core/src/types/
 */

export type TrustTier = 'quarantine' | 'local' | 'verified' | 'canonical';
export type AtomType = 'tool' | 'negative' | 'pattern' | 'skill' | 'context';
export type Outcome = 'success' | 'failure' | 'partial';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface KnowledgeAtom {
  id: string;
  type: AtomType;
  observation: string;
  context: string;
  confidence: number;
  fitness_score: number;
  trust_tier: TrustTier;
  source_agent_hash: string;
  created_at: string;
  updated_at: string;
  decay_rate: number;
  // ToolAtom fields
  tool_name?: string;
  params_hash?: string;
  outcome?: Outcome;
  error_signature?: string | null;
  latency_ms?: number | null;
  reliability_score?: number;
  // NegativeAtom fields
  anti_pattern?: string;
  failure_cluster_size?: number;
  error_type?: string;
  severity?: Severity;
  // Dedup & fitness
  evidence_count?: number;
  use_count?: number;
  success_after_use?: number;
  failure_after_use?: number;
  last_used?: string | null;
  // Sync tracking
  synced?: boolean;
}

export interface CaptureEvent {
  model: string;
  provider: string;
  task_type: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  success: boolean;
  error_type?: string;
  timestamp: string;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  deduped: number;
  errors: string[];
  timestamp: string;
}
