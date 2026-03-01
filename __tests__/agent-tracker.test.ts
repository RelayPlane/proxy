import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeFingerprint,
  extractSystemPrompt,
  extractSystemPromptFromBody,
  trackAgent,
  renameAgent,
  getAgentRegistry,
  getAgentSummaries,
  _resetForTesting,
} from '../src/agent-tracker.js';

describe('agent-tracker', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  describe('computeFingerprint', () => {
    it('returns 12-char hex string', () => {
      const fp = computeFingerprint('You are a helpful assistant');
      expect(fp).toMatch(/^[0-9a-f]{12}$/);
    });

    it('returns same fingerprint for same input', () => {
      const a = computeFingerprint('You are a coding assistant');
      const b = computeFingerprint('You are a coding assistant');
      expect(a).toBe(b);
    });

    it('returns different fingerprints for different inputs', () => {
      const a = computeFingerprint('You are a coding assistant');
      const b = computeFingerprint('You are a research assistant');
      expect(a).not.toBe(b);
    });

    it('only uses first 500 chars', () => {
      const base = 'A'.repeat(500);
      const a = computeFingerprint(base + 'EXTRA STUFF');
      const b = computeFingerprint(base + 'DIFFERENT STUFF');
      expect(a).toBe(b);
    });

    it('differentiates prompts within first 500 chars', () => {
      const a = computeFingerprint('A'.repeat(499) + 'X');
      const b = computeFingerprint('A'.repeat(499) + 'Y');
      expect(a).not.toBe(b);
    });
  });

  describe('extractSystemPrompt', () => {
    it('extracts string system message', () => {
      const messages = [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hi' },
      ];
      expect(extractSystemPrompt(messages)).toBe('You are helpful');
    });

    it('extracts from content array', () => {
      const messages = [
        { role: 'system', content: [{ type: 'text', text: 'Part 1' }, { type: 'text', text: ' Part 2' }] },
      ];
      expect(extractSystemPrompt(messages)).toBe('Part 1 Part 2');
    });

    it('returns empty for no system message', () => {
      const messages = [{ role: 'user', content: 'Hi' }];
      expect(extractSystemPrompt(messages)).toBe('');
    });

    it('returns empty for empty/null input', () => {
      expect(extractSystemPrompt([])).toBe('');
      expect(extractSystemPrompt(null as any)).toBe('');
    });
  });

  describe('extractSystemPromptFromBody', () => {
    it('extracts from top-level system string (Anthropic)', () => {
      expect(extractSystemPromptFromBody({ system: 'You are a bot', messages: [] })).toBe('You are a bot');
    });

    it('extracts from top-level system array (Anthropic)', () => {
      expect(extractSystemPromptFromBody({
        system: [{ type: 'text', text: 'Hello' }],
        messages: [],
      })).toBe('Hello');
    });

    it('falls back to messages array', () => {
      expect(extractSystemPromptFromBody({
        messages: [{ role: 'system', content: 'From messages' }],
      })).toBe('From messages');
    });
  });

  describe('trackAgent', () => {
    it('creates new agent entry on first request', () => {
      const result = trackAgent('You are a coding assistant', 0.05);
      expect(result.fingerprint).toMatch(/^[0-9a-f]{12}$/);
      const registry = getAgentRegistry();
      expect(registry[result.fingerprint]).toBeDefined();
      expect(registry[result.fingerprint]!.name).toBe('Agent 1');
      expect(registry[result.fingerprint]!.totalRequests).toBe(1);
      expect(registry[result.fingerprint]!.totalCost).toBeCloseTo(0.05);
      expect(registry[result.fingerprint]!.systemPromptPreview).toBe('You are a coding assistant');
    });

    it('increments counters on subsequent requests', () => {
      trackAgent('You are a coding assistant', 0.05);
      trackAgent('You are a coding assistant', 0.10);
      const registry = getAgentRegistry();
      const fp = computeFingerprint('You are a coding assistant');
      expect(registry[fp]!.totalRequests).toBe(2);
      expect(registry[fp]!.totalCost).toBeCloseTo(0.15);
    });

    it('auto-numbers agents', () => {
      trackAgent('Prompt A', 0);
      trackAgent('Prompt B', 0);
      const registry = getAgentRegistry();
      const names = Object.values(registry).map(e => e.name).sort();
      expect(names).toEqual(['Agent 1', 'Agent 2']);
    });

    it('uses explicit agentId as name for auto-named agents', () => {
      trackAgent('Prompt A', 0, 'my-coder');
      const registry = getAgentRegistry();
      const fp = computeFingerprint('Prompt A');
      expect(registry[fp]!.name).toBe('my-coder');
    });

    it('returns unknown fingerprint for empty system prompt', () => {
      const result = trackAgent('', 0);
      expect(result.fingerprint).toBe('unknown');
    });
  });

  describe('renameAgent', () => {
    it('renames an existing agent', () => {
      const { fingerprint } = trackAgent('Prompt A', 0);
      const ok = renameAgent(fingerprint, 'My Coder');
      expect(ok).toBe(true);
      expect(getAgentRegistry()[fingerprint]!.name).toBe('My Coder');
    });

    it('returns false for unknown fingerprint', () => {
      expect(renameAgent('nonexistent1', 'Test')).toBe(false);
    });
  });

  describe('getAgentSummaries', () => {
    it('merges registry with history data', () => {
      trackAgent('Prompt A', 0);
      const fp = computeFingerprint('Prompt A');
      const history = [
        { agentFingerprint: fp, costUsd: 0.10, timestamp: '2026-01-01T00:00:00Z' },
        { agentFingerprint: fp, costUsd: 0.20, timestamp: '2026-01-02T00:00:00Z' },
      ];
      const summaries = getAgentSummaries(history);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.costFromHistory).toBeCloseTo(0.30);
      expect(summaries[0]!.requestsFromHistory).toBe(2);
    });
  });
});
