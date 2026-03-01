/**
 * Per-Agent Cost Tracking
 *
 * Fingerprints agents by hashing the first 500 chars of their system prompt
 * (SHA-256, first 12 hex chars). Maintains an agent registry at ~/.relayplane/agents.json.
 *
 * @packageDocumentation
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface AgentRegistryEntry {
  name: string;
  fingerprint: string;
  firstSeen: string;
  lastSeen: string;
  systemPromptPreview: string;
  totalRequests: number;
  totalCost: number;
}

export interface AgentRegistry {
  [fingerprint: string]: AgentRegistryEntry;
}

const REGISTRY_DIR = path.join(os.homedir(), '.relayplane');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'agents.json');

let agentRegistry: AgentRegistry = {};
let nextAgentNumber = 1;
let registryDirty = false;
let flushTimer: NodeJS.Timeout | null = null;

/**
 * Compute agent fingerprint from system prompt content.
 * Uses first 500 chars → SHA-256 → first 12 hex chars.
 */
export function computeFingerprint(systemPrompt: string): string {
  const input = systemPrompt.slice(0, 500);
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return hash.slice(0, 12);
}

/**
 * Extract system message text from a messages array.
 * Returns empty string if no system message found.
 */
export function extractSystemPrompt(messages: Array<{ role?: string; content?: unknown }>): string {
  if (!messages || !Array.isArray(messages)) return '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content
          .map((part: unknown) => {
            const p = part as { type?: string; text?: string };
            return p.type === 'text' ? (p.text ?? '') : '';
          })
          .join('');
      }
    }
  }
  return '';
}

/**
 * Extract system prompt from an Anthropic-style request body
 * where system is a top-level field rather than in messages.
 */
export function extractSystemPromptFromBody(body: Record<string, unknown>): string {
  // Check top-level 'system' field (Anthropic native format)
  if (typeof body.system === 'string') return body.system;
  if (Array.isArray(body.system)) {
    return (body.system as Array<{ type?: string; text?: string }>)
      .map(p => p.type === 'text' ? (p.text ?? '') : (typeof p === 'string' ? p : ''))
      .join('');
  }
  // Check messages array (OpenAI format)
  if (Array.isArray(body.messages)) {
    return extractSystemPrompt(body.messages as Array<{ role?: string; content?: unknown }>);
  }
  return '';
}

/**
 * Load agent registry from disk.
 */
export function loadAgentRegistry(): void {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      const data = fs.readFileSync(REGISTRY_FILE, 'utf-8');
      agentRegistry = JSON.parse(data) as AgentRegistry;
      // Compute next agent number from existing names
      for (const entry of Object.values(agentRegistry)) {
        const match = entry.name.match(/^Agent (\d+)$/);
        if (match) {
          const num = parseInt(match[1]!, 10);
          if (num >= nextAgentNumber) nextAgentNumber = num + 1;
        }
      }
    }
  } catch {
    agentRegistry = {};
  }
}

/**
 * Save agent registry to disk (debounced).
 */
function scheduleFlush(): void {
  registryDirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushAgentRegistry();
  }, 5000);
}

/**
 * Flush agent registry to disk immediately.
 */
export function flushAgentRegistry(): void {
  if (!registryDirty) return;
  try {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(agentRegistry, null, 2), 'utf-8');
    registryDirty = false;
  } catch {
    // Silent failure — don't break the proxy
  }
}

/**
 * Record a request for an agent. Creates registry entry if new.
 * Returns the fingerprint and resolved agentId.
 */
export function trackAgent(
  systemPrompt: string,
  costUsd: number,
  explicitAgentId?: string,
): { fingerprint: string; agentId: string | undefined } {
  if (!systemPrompt) {
    return { fingerprint: 'unknown', agentId: explicitAgentId };
  }

  const fingerprint = computeFingerprint(systemPrompt);
  const now = new Date().toISOString();

  if (!agentRegistry[fingerprint]) {
    agentRegistry[fingerprint] = {
      name: `Agent ${nextAgentNumber++}`,
      fingerprint,
      firstSeen: now,
      lastSeen: now,
      systemPromptPreview: systemPrompt.slice(0, 80),
      totalRequests: 0,
      totalCost: 0,
    };
  }

  const entry = agentRegistry[fingerprint]!;
  entry.lastSeen = now;
  entry.totalRequests++;
  entry.totalCost += costUsd;

  // If explicit agentId provided, use it as the name (first time only, don't override user renames)
  if (explicitAgentId && entry.name.startsWith('Agent ')) {
    entry.name = explicitAgentId;
  }

  scheduleFlush();

  return { fingerprint, agentId: explicitAgentId };
}

/**
 * Update cost for an agent after response is received.
 */
export function updateAgentCost(fingerprint: string, costUsd: number): void {
  const entry = agentRegistry[fingerprint];
  if (entry) {
    entry.totalCost += costUsd;
    scheduleFlush();
  }
}

/**
 * Rename an agent in the registry.
 */
export function renameAgent(fingerprint: string, newName: string): boolean {
  const entry = agentRegistry[fingerprint];
  if (!entry) return false;
  entry.name = newName;
  scheduleFlush();
  return true;
}

/**
 * Get the full agent registry.
 */
export function getAgentRegistry(): AgentRegistry {
  return agentRegistry;
}

/**
 * Get agent registry with cost summaries from request history.
 */
export function getAgentSummaries(
  requestHistory: Array<{ agentFingerprint?: string; costUsd: number; timestamp: string }>,
): Array<AgentRegistryEntry & { costFromHistory: number; requestsFromHistory: number }> {
  // Aggregate from history
  const historyStats = new Map<string, { cost: number; requests: number; lastActive: string }>();
  for (const r of requestHistory) {
    const fp = r.agentFingerprint ?? 'unknown';
    const existing = historyStats.get(fp) ?? { cost: 0, requests: 0, lastActive: '' };
    existing.cost += r.costUsd;
    existing.requests++;
    if (r.timestamp > existing.lastActive) existing.lastActive = r.timestamp;
    historyStats.set(fp, existing);
  }

  const results: Array<AgentRegistryEntry & { costFromHistory: number; requestsFromHistory: number }> = [];

  // Include all registered agents
  for (const [fp, entry] of Object.entries(agentRegistry)) {
    const hs = historyStats.get(fp) ?? { cost: 0, requests: 0, lastActive: '' };
    results.push({
      ...entry,
      costFromHistory: hs.cost,
      requestsFromHistory: hs.requests,
    });
    historyStats.delete(fp);
  }

  // Include unregistered fingerprints from history
  for (const [fp, hs] of historyStats) {
    if (fp === 'unknown') continue;
    results.push({
      name: fp,
      fingerprint: fp,
      firstSeen: hs.lastActive,
      lastSeen: hs.lastActive,
      systemPromptPreview: '',
      totalRequests: hs.requests,
      totalCost: hs.cost,
      costFromHistory: hs.cost,
      requestsFromHistory: hs.requests,
    });
  }

  return results;
}

/**
 * Reset registry (for testing).
 */
export function _resetForTesting(): void {
  agentRegistry = {};
  nextAgentNumber = 1;
  registryDirty = false;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
}
