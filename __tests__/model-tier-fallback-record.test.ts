import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import {
  recordTierFallback,
  tierFallbackEventsPath,
  type TierFallbackEvent,
} from '../src/model-tier-fallback.js';

const base: TierFallbackEvent = {
  ts: '2026-09-29T08:00:00.000Z',
  requested_model: 'claude-sonnet-5-5',
  served_model: 'claude-haiku-4-5-20251001',
  original_model: 'claude-sonnet-5-5',
  upstream_status: 429,
  agent: 'content-radar',
  run_id: 'run-1',
  agent_label: null,
  user_agent: 'python-urllib/3.12',
  port: 4100,
};

describe('tierFallbackEventsPath', () => {
  it('joins the relayplane dir with tier-fallback-events.jsonl', () => {
    expect(tierFallbackEventsPath('/x/.relayplane')).toBe(path.join('/x/.relayplane', 'tier-fallback-events.jsonl'));
  });
});

describe('recordTierFallback (make silent Haiku downgrades loud)', () => {
  it('warns with a single loud line naming requested->served, status, agent, run and user-agent', () => {
    const warn = vi.fn();
    const append = vi.fn();
    recordTierFallback(base, { filePath: '/tmp/ev.jsonl', warn, append });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line.startsWith('[RelayPlane] WARNING tier-fallback:')).toBe(true);
    expect(line).toContain('claude-sonnet-5-5 -> claude-haiku-4-5-20251001');
    expect(line).toContain('429');
    expect(line).toContain('content-radar');
    expect(line).toContain('run-1');
    expect(line).toContain('python-urllib/3.12');
    expect(line).not.toContain('\n');
  });

  it('appends exactly one JSONL line with the contract keys', () => {
    const append = vi.fn();
    recordTierFallback(base, { filePath: '/tmp/ev.jsonl', warn: vi.fn(), append });
    expect(append).toHaveBeenCalledTimes(1);
    const [file, data] = append.mock.calls[0];
    expect(file).toBe('/tmp/ev.jsonl');
    expect(String(data).endsWith('\n')).toBe(true);
    const parsed = JSON.parse(String(data));
    expect(Object.keys(parsed).sort()).toEqual([
      'agent', 'agent_label', 'original_model', 'port', 'requested_model',
      'run_id', 'served_model', 'ts', 'upstream_status', 'user_agent',
    ]);
    expect(parsed.served_model).toBe('claude-haiku-4-5-20251001');
  });

  it('records exhaustion with served_model null and exhausted true', () => {
    const append = vi.fn();
    const warn = vi.fn();
    recordTierFallback({ ...base, served_model: null, exhausted: true }, { filePath: '/tmp/ev.jsonl', warn, append });
    const parsed = JSON.parse(String(append.mock.calls[0][1]));
    expect(parsed.served_model).toBeNull();
    expect(parsed.exhausted).toBe(true);
    expect(String(warn.mock.calls[0][0])).toContain('exhausted');
  });

  it('never throws when the append fails, and warns about the write error', () => {
    const warn = vi.fn();
    const append = vi.fn(() => { throw new Error('EACCES'); });
    expect(() => recordTierFallback(base, { filePath: '/nope/ev.jsonl', warn, append })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1][0])).toContain('EACCES');
  });

  it('defaults null identity fields to "unknown" in the warning', () => {
    const warn = vi.fn();
    recordTierFallback({ ...base, agent: null, run_id: null, user_agent: null }, { filePath: '/tmp/e', warn, append: vi.fn() });
    expect(String(warn.mock.calls[0][0])).toContain('agent=unknown');
  });
});
