export interface KillEvent {
  timestamp: string;
  session_id: string;
  agent: string;
  reason: 'cap_exceeded' | 'runaway_loop' | 'manual';
  saved_usd: number;
}

const MAX_BUFFER = 1000;

export class KillAudit {
  private events: KillEvent[] = [];

  record(ev: KillEvent): void {
    this.events.push(ev);
    if (this.events.length > MAX_BUFFER) {
      this.events.splice(0, this.events.length - MAX_BUFFER);
    }
  }

  countSince(since: string): number {
    const sinceMs = Date.parse(since);
    return this.events.filter((e) => Date.parse(e.timestamp) >= sinceMs).length;
  }

  list(opts: { limit?: number; since?: string } = {}): KillEvent[] {
    let result = this.events.slice();
    if (opts.since) {
      const sinceMs = Date.parse(opts.since);
      result = result.filter((e) => Date.parse(e.timestamp) >= sinceMs);
    }
    result.reverse();
    if (opts.limit !== undefined) {
      result = result.slice(0, opts.limit);
    }
    return result;
  }
}

let _instance: KillAudit | null = null;

export function getKillAudit(): KillAudit {
  if (!_instance) _instance = new KillAudit();
  return _instance;
}
