// Auto-ported from imported design's data.js. Will be replaced by real-endpoint hooks.
// Values are zeroed out until each panel is wired to a live proxy endpoint.
// Shape is preserved so consuming components don't crash.

// ----- Hero stats (today) ----------------------------------------------------
export const RP_TODAY = {
  requests:       0,
  requestsDelta:  0,
  cost:           0,
  costDelta:      0,
  budget:         0,
  savings:        0,
  savingsPct:     0,
  latencyAvg:     0,
  latencyP95:     0,
  burn:           0,
  cacheHitRate:   0,
};

// ----- Live spend curve, today (one bucket per hour, 0..23) ------------------
export const RP_SPEND_TODAY = [
  0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0,
  0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
];

// ----- Providers -------------------------------------------------------------
export const RP_PROVIDERS = [];

// ----- Token pool ------------------------------------------------------------
export const RP_TOKEN_POOL = [];

// ----- Sessions (last 24h, expandable accordion) -----------------------------
export const RP_SESSIONS = [];

// ----- Live request stream ---------------------------------------------------
export const RP_REQS_SEED = [];

export const RP_REQS_TICKS = [];

// ----- Recent network learning observations ---------------------------------
export const RP_LEARNING = {
  lastApplied: "",
  matchRateDelta: 0,
  patternsFile: "",
  version: 0,
  totalLearnings: 0,
  changes: [],
  files: [],
};
