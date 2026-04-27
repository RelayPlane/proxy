import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface CostRecord {
  tenantId: string;
  model: string;
  costUsd: number;
  requestCount: number;
  timestamp: Date;
}

export interface CostQueryResult {
  totalUsd: number;
  byModel: Record<string, number>;
  byDay: Record<string, number>;
  requestCount: number;
}

type StoredRecord = Omit<CostRecord, 'timestamp'> & { timestamp: string };

function getLedgerPath(): string {
  const home = process.env['RELAYPLANE_HOME_OVERRIDE'] ?? path.join(os.homedir(), '.relayplane');
  fs.mkdirSync(home, { recursive: true });
  return path.join(home, 'cost-ledger.json');
}

export class CostLedger {
  private records: StoredRecord[];
  private ledgerPath: string;

  constructor() {
    this.ledgerPath = getLedgerPath();
    this.records = this.load();
  }

  private load(): StoredRecord[] {
    try {
      const raw = fs.readFileSync(this.ledgerPath, 'utf8');
      return JSON.parse(raw) as StoredRecord[];
    } catch {
      return [];
    }
  }

  private save(): void {
    fs.writeFileSync(this.ledgerPath, JSON.stringify(this.records), 'utf8');
  }

  record(rec: CostRecord): void {
    this.records.push({ ...rec, timestamp: rec.timestamp.toISOString() });
    this.save();
  }

  query(tenantId: string, range: '7d' | '30d' | 'all'): CostQueryResult {
    const now = Date.now();
    const cutoff =
      range === '7d' ? now - 7 * 24 * 60 * 60 * 1000 :
      range === '30d' ? now - 30 * 24 * 60 * 60 * 1000 :
      0;

    const filtered = this.records.filter(r => {
      if (r.tenantId !== tenantId) return false;
      if (cutoff > 0 && new Date(r.timestamp).getTime() < cutoff) return false;
      return true;
    });

    const result: CostQueryResult = { totalUsd: 0, byModel: {}, byDay: {}, requestCount: 0 };

    for (const r of filtered) {
      result.totalUsd += r.costUsd;
      result.requestCount += r.requestCount;

      result.byModel[r.model] = (result.byModel[r.model] ?? 0) + r.costUsd;

      const day = r.timestamp.slice(0, 10); // YYYY-MM-DD
      result.byDay[day] = (result.byDay[day] ?? 0) + r.costUsd;
    }

    return result;
  }
}
