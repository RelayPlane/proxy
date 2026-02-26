/**
 * Model suggestion utilities for improved error messages
 *
 * Uses Levenshtein distance to suggest similar model names when a
 * requested model doesn't exist.
 */

function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });

  for (let j = 0; j < cols; j++) dp[0]![j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }

  return dp[rows - 1]![cols - 1]!;
}

/**
 * Suggest similar models based on Levenshtein distance
 *
 * @param requested - The model name that was requested but not found
 * @param available - List of available/valid model names
 * @param max - Maximum number of suggestions to return (default: 3)
 * @returns Array of suggested model names, sorted by similarity
 */
export function suggestModels(
  requested: string,
  available: string[],
  max = 3
): string[] {
  const requestedLower = requested.toLowerCase();

  return available
    .map((model) => ({
      model,
      dist: distance(requestedLower, model.toLowerCase()),
    }))
    .filter(({ dist }) => dist <= 4) // Within 4 edits
    .sort((a, b) => a.dist - b.dist)
    .slice(0, max)
    .map(({ model }) => model);
}

/**
 * Build an error response for model-not-found errors with suggestions
 *
 * @param requestedModel - The model name that was requested
 * @param availableModels - List of available model names
 * @returns Error response object with suggestions
 */
export function buildModelNotFoundError(
  requestedModel: string,
  availableModels: string[]
): {
  error: string;
  suggestions?: string[];
  hint?: string;
} {
  const suggestions = suggestModels(requestedModel, availableModels);

  const response: {
    error: string;
    suggestions?: string[];
    hint?: string;
  } = {
    error: `Model '${requestedModel}' does not exist`,
  };

  if (suggestions.length > 0) {
    response.suggestions = suggestions;
    response.hint = `Did you mean '${suggestions[0]}'?`;
  }

  return response;
}
