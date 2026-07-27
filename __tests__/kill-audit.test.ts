import { describe, it, expect } from 'vitest';
import { KillAudit, getKillAudit } from '../src/kill-audit.js';

describe('Kill audit ring buffer', () => {
  it('test_kill_audit_record_and_list', () => {
    const audit = new KillAudit();
    const base = new Date('2026-05-29T10:00:00.000Z');
    audit.record({ timestamp: new Date(base.getTime()).toISOString(), session_id: 'sess-aaa111', agent: 'agent1', reason: 'cap_exceeded', saved_usd: 1.0 });
    audit.record({ timestamp: new Date(base.getTime() + 1000).toISOString(), session_id: 'sess-bbb222', agent: 'agent2', reason: 'runaway_loop', saved_usd: 2.0 });
    audit.record({ timestamp: new Date(base.getTime() + 2000).toISOString(), session_id: 'sess-ccc333', agent: 'agent3', reason: 'manual', saved_usd: 3.0 });
    const events = audit.list({ limit: 2 });
    expect(events).toHaveLength(2);
    expect(events[0].session_id).toBe('sess-ccc333');
    expect(events[1].session_id).toBe('sess-bbb222');
  });

  it('test_kill_audit_filter_since', () => {
    const audit = new KillAudit();
    audit.record({ timestamp: '2026-05-29T08:00:00.000Z', session_id: 'old-sess', agent: 'agent1', reason: 'manual', saved_usd: 0.5 });
    audit.record({ timestamp: '2026-05-29T10:00:00.000Z', session_id: 'new-sess', agent: 'agent2', reason: 'cap_exceeded', saved_usd: 1.5 });
    const events = audit.list({ since: '2026-05-29T09:00:00.000Z' });
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('new-sess');
  });

  it('test_kill_audit_caps_at_1000', () => {
    const audit = new KillAudit();
    for (let i = 0; i < 1100; i++) {
      audit.record({
        timestamp: new Date(Date.now() + i).toISOString(),
        session_id: `sess-${i}`,
        agent: 'agent',
        reason: 'manual',
        saved_usd: 0.01,
      });
    }
    const events = audit.list({ limit: 2000 });
    expect(events.length).toBe(1000);
  });

  it('test_getKillAudit_returns_singleton', () => {
    const a = getKillAudit();
    const b = getKillAudit();
    expect(a).toBe(b);
  });
});
