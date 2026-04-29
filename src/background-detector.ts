export interface ActivityRequest {
  request_id: string;
  timestamp: number;
  input_tokens: number;
  output_tokens: number;
  stop_reason: string;
  cost_usd: number;
}

export interface BgFgResult {
  foreground_requests: number;
  background_requests: number;
  background_spend_pct: number;
  background_request_pct: number;
  signals: string[];
}

const RAPID_BURST_GAP_MS = 2000;
const RAPID_BURST_MIN_TOKENS = 2000;
const MIDNIGHT_DENSITY_WINDOW_MS = 10 * 60 * 1000;
const MIDNIGHT_DENSITY_THRESHOLD = 5;
const LOOP_MIN_CONSECUTIVE = 5;
const LOOP_MIN_TOKENS = 2000;

function isPostMidnight(ts: number): boolean {
  const hour = new Date(ts).getUTCHours();
  return hour >= 0 && hour < 5;
}

export function classifyActivity(requests: ActivityRequest[]): BgFgResult {
  if (requests.length === 0) {
    return {
      foreground_requests: 0,
      background_requests: 0,
      background_spend_pct: 0,
      background_request_pct: 0,
      signals: [],
    };
  }

  const signals = new Set<string>();
  const bgFlags = new Array<boolean>(requests.length).fill(false);

  // H1: rapid inter-request burst (gap < 2s AND input_tokens > 2000)
  for (let i = 1; i < requests.length; i++) {
    const prev = requests[i - 1] as ActivityRequest;
    const cur = requests[i] as ActivityRequest;
    const gap = cur.timestamp - prev.timestamp;
    if (gap < RAPID_BURST_GAP_MS && cur.input_tokens > RAPID_BURST_MIN_TOKENS) {
      bgFlags[i] = true;
      signals.add('rapid_burst');
    }
  }

  // H2: post-midnight window + density > 5 req / 10 min
  for (let i = 0; i < requests.length; i++) {
    const anchor = requests[i] as ActivityRequest;
    if (!isPostMidnight(anchor.timestamp)) continue;
    const windowEnd = anchor.timestamp + MIDNIGHT_DENSITY_WINDOW_MS;
    const windowIndices: number[] = [];
    for (let j = 0; j < requests.length; j++) {
      const r = requests[j] as ActivityRequest;
      if (r.timestamp >= anchor.timestamp && r.timestamp <= windowEnd) {
        windowIndices.push(j);
      }
    }
    if (windowIndices.length > MIDNIGHT_DENSITY_THRESHOLD) {
      for (const idx of windowIndices) bgFlags[idx] = true;
      signals.add('post_midnight_burst');
    }
  }

  // H3: no stop_reason variation across >= 5 consecutive calls with input_tokens > 2000
  let runStart = 0;
  for (let i = 1; i <= requests.length; i++) {
    const anchorReq = requests[runStart] as ActivityRequest;
    const ended = i === requests.length;
    const diffReason = !ended && (requests[i] as ActivityRequest).stop_reason !== anchorReq.stop_reason;
    if (ended || diffReason) {
      const runLen = i - runStart;
      if (runLen >= LOOP_MIN_CONSECUTIVE && anchorReq.input_tokens > LOOP_MIN_TOKENS) {
        for (let k = runStart; k < i; k++) bgFlags[k] = true;
        signals.add('stop_reason_loop');
      }
      runStart = i;
    }
  }

  let bgCount = 0;
  let bgCost = 0;
  let totalCost = 0;
  for (let i = 0; i < requests.length; i++) {
    const r = requests[i] as ActivityRequest;
    totalCost += r.cost_usd;
    if (bgFlags[i]) {
      bgCount++;
      bgCost += r.cost_usd;
    }
  }

  return {
    foreground_requests: requests.length - bgCount,
    background_requests: bgCount,
    background_spend_pct: totalCost > 0 ? (bgCost / totalCost) * 100 : 0,
    background_request_pct: (bgCount / requests.length) * 100,
    signals: Array.from(signals),
  };
}
