import type { RoutingLogEntry } from './routing-log.js';

export interface SaveRecommendation {
  opusCount: number;
  avgComplexityScore: number;
  sonnetThresholdScore: number;
  estimatedDailySavings: number;
  windowSize: number;
}

const WINDOW_SIZE = 20;
const MIN_ENTRIES = 10;
const SONNET_THRESHOLD = 0.5;

// $/token pricing: Opus vs Sonnet
const OPUS_INPUT_PRICE = 15 / 1_000_000;
const OPUS_OUTPUT_PRICE = 75 / 1_000_000;
const SONNET_INPUT_PRICE = 3 / 1_000_000;
const SONNET_OUTPUT_PRICE = 15 / 1_000_000;

function complexityToScore(complexity: string): number {
  if (complexity === 'simple') return 0.2;
  if (complexity === 'moderate') return 0.35;
  return 0.7; // complex or unknown
}

export function computeSaveRecommendation(
  entries: RoutingLogEntry[]
): SaveRecommendation | null {
  if (entries.length < MIN_ENTRIES) return null;

  const window = entries.slice(-WINDOW_SIZE);
  const opusCalls = window.filter(e => e.resolvedModel.toLowerCase().includes('opus'));
  if (opusCalls.length === 0) return null;

  const avgComplexityScore =
    opusCalls.reduce((sum, e) => sum + complexityToScore(e.complexity), 0) /
    opusCalls.length;

  if (avgComplexityScore >= SONNET_THRESHOLD) return null;

  const avgInput =
    opusCalls.reduce((sum, e) => sum + (e.inputTokens ?? 0), 0) / opusCalls.length;
  const avgOutput =
    opusCalls.reduce((sum, e) => sum + (e.outputTokens ?? 0), 0) / opusCalls.length;

  let estimatedDailySavings = 0;
  if (avgInput > 0 || avgOutput > 0) {
    const savingsPerRequest =
      (OPUS_INPUT_PRICE - SONNET_INPUT_PRICE) * avgInput +
      (OPUS_OUTPUT_PRICE - SONNET_OUTPUT_PRICE) * avgOutput;
    estimatedDailySavings = savingsPerRequest * opusCalls.length;
  }

  return {
    opusCount: opusCalls.length,
    avgComplexityScore,
    sonnetThresholdScore: SONNET_THRESHOLD,
    estimatedDailySavings,
    windowSize: window.length,
  };
}

export function formatSaveRecommendationTip(rec: SaveRecommendation): string {
  const savings = `$${rec.estimatedDailySavings.toFixed(2)}/day`;
  return (
    `TIP: Last ${rec.opusCount} Opus requests averaged complexity ` +
    `${rec.avgComplexityScore} (Sonnet threshold: ${rec.sonnetThresholdScore}). ` +
    `Estimated savings if routed to Sonnet: ${savings}.`
  );
}

export function toYamlPatch(rec: SaveRecommendation): string {
  const weeklySavings = (rec.estimatedDailySavings * 7).toFixed(2);
  return (
    `routing:\n` +
    `  default_model: claude-sonnet-4-5\n` +
    `  routing_mode: complexity\n` +
    `  # Estimated weekly savings: $${weeklySavings}\n` +
    `  # Safe — last ${rec.windowSize} Opus requests classified simple/moderate ` +
    `(avg complexity ${rec.avgComplexityScore.toFixed(2)})\n`
  );
}
