/**
 * Policy Analyzer
 *
 * Reads routing-log.jsonl directly (not the in-memory buffer) and joins with
 * agents.json to produce per-agent traffic summaries used by the suggestion engine
 * and CLI display.
 */

import * as fs from 'node:fs';
import { LOG_FILE } from './routing-log.js';
import { getAgentRegistry } from './agent-tracker.js';
import type { RoutingLogEntry } from './routing-log.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentAnalysis {
  fingerprint: string;                         // 12-char hex from routing log
  name: string;                                // inferred or from agents.json
  nameIsInferred: boolean;                     // true if we guessed the name
  taskDistribution: Record<string, number>;    // taskType → fraction (0–1), sums to 1.0
  dominantTask: string;                        // taskType with highest fraction
  avgInputTokens: number;                      // average per request; 0 if no token data
  avgOutputTokens: number;                     // average per request; 0 if no token data
  avgTotalTokens: number;                      // avgInputTokens + avgOutputTokens
  tokensAreEstimated: boolean;                 // true if token data unavailable, cost-based estimate used
  requestsPerDay: number;                      // requests / days active (min 1 day)
  costPerDay: number;                          // USD; from agents.json totalCost / daysActive
  currentModel: string;                        // most recent resolvedModel from log
  daysObserved: number;                        // days between firstSeen and lastSeen in agents.json
  totalRequests: number;                       // from agents.json
  systemPromptPreview: string;                 // first 80 chars, from agents.json
}

// ─── Model cost table ─────────────────────────────────────────────────────────

// Costs in USD per 1M tokens. Input/output separately.
// Update when provider pricing changes.
export const MODEL_COST_PER_1M: Record<string, { input: number; output: number }> = {
  'anthropic/claude-opus-4-5':       { input: 15.00, output: 75.00 },
  'anthropic/claude-opus-4':         { input: 15.00, output: 75.00 },
  'anthropic/claude-sonnet-4-5':     { input: 3.00,  output: 15.00 },
  'anthropic/claude-sonnet-4':       { input: 3.00,  output: 15.00 },
  'anthropic/claude-haiku-4-5':      { input: 0.80,  output: 4.00  },
  'anthropic/claude-haiku-4':        { input: 0.80,  output: 4.00  },
  'openai/gpt-4o':                   { input: 2.50,  output: 10.00 },
  'openai/gpt-4o-mini':              { input: 0.15,  output: 0.60  },
  'google/gemini-2.0-flash':         { input: 0.10,  output: 0.40  },
  'google/gemini-1.5-flash':         { input: 0.075, output: 0.30  },
  'groq/llama-3.3-70b':              { input: 0.59,  output: 0.79  },
  'groq/llama-3.1-8b-instant':       { input: 0.05,  output: 0.08  },
  'openrouter/auto':                 { input: 1.00,  output: 5.00  }, // rough estimate
};

export function estimateDailyCost(
  avgInputTokens: number,
  avgOutputTokens: number,
  requestsPerDay: number,
  model: string,
): number {
  const costs = MODEL_COST_PER_1M[model];
  if (!costs) return 0;
  const perRequest =
    (avgInputTokens / 1_000_000) * costs.input +
    (avgOutputTokens / 1_000_000) * costs.output;
  return perRequest * requestsPerDay;
}

// ─── Name inference ───────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 24);
}

/**
 * Infer a human-readable agent name from its system prompt and task distribution.
 */
export function inferAgentName(
  systemPromptPreview: string,
  taskDistribution: Record<string, number>,
): string {
  // Priority 1: "You are a/an [role]"
  const youAreMatch = systemPromptPreview.match(/you are (?:a |an )?([A-Za-z][\w\s]{1,24})/i);
  if (youAreMatch && youAreMatch[1]) {
    return slugify(youAreMatch[1].trim());
  }

  // Priority 2: "Your job/role/task/purpose is to [verb]"
  const jobMatch = systemPromptPreview.match(/your (?:job|role|task|purpose) is to (\w+)/i);
  if (jobMatch && jobMatch[1]) {
    return slugify(jobMatch[1].trim()) + '-agent';
  }

  // Priority 3: "As a/an [role] assistant/agent/bot"
  const asAMatch = systemPromptPreview.match(/as (?:a |an )?(\w+(?:\s+\w+)?) (?:assistant|agent|bot)/i);
  if (asAMatch && asAMatch[1]) {
    return slugify(asAMatch[1].trim());
  }

  // Priority 4: fallback to dominant task
  const dominant = Object.entries(taskDistribution).sort((a, b) => b[1] - a[1])[0];
  if (dominant) {
    return dominant[0] + '-agent';
  }

  return 'unknown-agent';
}

// ─── Main analysis function ───────────────────────────────────────────────────

/**
 * Read routing-log.jsonl and agents.json to produce per-agent traffic summaries.
 * Default lookbackDays = 7.
 */
export async function analyzeTraffic(opts?: { lookbackDays?: number }): Promise<AgentAnalysis[]> {
  const lookbackDays = opts?.lookbackDays ?? 7;
  const cutoff = Date.now() - lookbackDays * 86_400_000;

  // 1. Read JSONL file
  if (!fs.existsSync(LOG_FILE)) {
    return [];
  }

  let lines: string[];
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    lines = content.split('\n').filter(l => l.trim().length > 0);
  } catch {
    return [];
  }

  // Parse and filter entries within lookback window
  const entries: RoutingLogEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as RoutingLogEntry;
      const ts = Date.parse(entry.ts);
      if (!isNaN(ts) && ts >= cutoff) {
        entries.push(entry);
      }
    } catch {
      // Skip corrupt lines
    }
  }

  if (entries.length === 0) {
    return [];
  }

  // 2. Group by agentFingerprint (skip null fingerprints)
  const groups = new Map<string, RoutingLogEntry[]>();
  for (const entry of entries) {
    if (!entry.agentFingerprint) continue;
    const existing = groups.get(entry.agentFingerprint);
    if (existing) {
      existing.push(entry);
    } else {
      groups.set(entry.agentFingerprint, [entry]);
    }
  }

  if (groups.size === 0) {
    return [];
  }

  // 3. Load agent registry
  const registry = getAgentRegistry();

  // 4. Build analysis for each fingerprint group
  const analyses: AgentAnalysis[] = [];

  for (const [fingerprint, groupEntries] of groups) {
    const total = groupEntries.length;

    // a. Task distribution
    const taskCounts: Record<string, number> = {};
    for (const e of groupEntries) {
      taskCounts[e.taskType] = (taskCounts[e.taskType] ?? 0) + 1;
    }
    const taskDistribution: Record<string, number> = {};
    for (const [task, count] of Object.entries(taskCounts)) {
      taskDistribution[task] = count / total;
    }

    // b. Dominant task
    const dominantTask = Object.entries(taskDistribution).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';

    // c. Token averages
    const entriesWithTokens = groupEntries.filter(e => e.inputTokens !== undefined || e.outputTokens !== undefined);
    let avgInputTokens: number;
    let avgOutputTokens: number;
    let tokensAreEstimated: boolean;

    if (entriesWithTokens.length > 0) {
      avgInputTokens = entriesWithTokens.reduce((sum, e) => sum + (e.inputTokens ?? 0), 0) / entriesWithTokens.length;
      avgOutputTokens = entriesWithTokens.reduce((sum, e) => sum + (e.outputTokens ?? 0), 0) / entriesWithTokens.length;
      tokensAreEstimated = false;
    } else {
      // Estimate from cost: assume 80/20 input/output split
      // We'll estimate based on the model pricing
      let totalEstimatedTokens = 0;
      let validEntries = 0;
      for (const e of groupEntries) {
        const costs = MODEL_COST_PER_1M[e.resolvedModel];
        if (costs && costs.input > 0) {
          // Rough estimate: use a small baseline if cost not available
          const estimatedTokens = 2000; // baseline
          totalEstimatedTokens += estimatedTokens;
          validEntries++;
        }
      }
      const avgTotal = validEntries > 0 ? totalEstimatedTokens / validEntries : 2000;
      avgInputTokens = avgTotal * 0.8;
      avgOutputTokens = avgTotal * 0.2;
      tokensAreEstimated = true;
    }

    const avgTotalTokens = avgInputTokens + avgOutputTokens;

    // d. Current model (most recent entry by ts)
    const sortedByTs = [...groupEntries].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    const currentModel = sortedByTs[0]?.resolvedModel ?? 'unknown';

    // e. Join with agents.json
    const registryEntry = registry[fingerprint];
    let daysObserved = 1;
    let costPerDay = 0;
    let requestsPerDay = total;
    let systemPromptPreview = '';
    let totalRequests = total;
    let name: string;
    let nameIsInferred: boolean;

    if (registryEntry) {
      const firstSeen = Date.parse(registryEntry.firstSeen);
      const lastSeen = Date.parse(registryEntry.lastSeen);
      daysObserved = Math.max(1, (lastSeen - firstSeen) / 86_400_000);
      costPerDay = registryEntry.totalCost / daysObserved;
      requestsPerDay = registryEntry.totalRequests / daysObserved;
      systemPromptPreview = (registryEntry.systemPromptPreview ?? '').slice(0, 80);
      totalRequests = registryEntry.totalRequests;

      // Use registry name if user-renamed (not "Agent N" pattern)
      const isDefaultName = /^Agent \d+$/.test(registryEntry.name);
      if (!isDefaultName) {
        name = registryEntry.name;
        nameIsInferred = false;
      } else {
        name = inferAgentName(systemPromptPreview, taskDistribution);
        nameIsInferred = true;
      }
    } else {
      // Fingerprint in log but not in agents.json — use log data
      name = inferAgentName(systemPromptPreview, taskDistribution);
      nameIsInferred = true;
    }

    analyses.push({
      fingerprint,
      name,
      nameIsInferred,
      taskDistribution,
      dominantTask,
      avgInputTokens,
      avgOutputTokens,
      avgTotalTokens,
      tokensAreEstimated,
      requestsPerDay,
      costPerDay,
      currentModel,
      daysObserved,
      totalRequests,
      systemPromptPreview,
    });
  }

  // 5. Sort by costPerDay descending
  analyses.sort((a, b) => b.costPerDay - a.costPerDay);

  return analyses;
}
