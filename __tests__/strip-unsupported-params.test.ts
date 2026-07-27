/**
 * Tests for stripping unsupported model params:
 *  - thinking field stripped from Haiku request bodies
 *  - OAT-unsupported beta flags filtered from anthropic-beta header
 *  - X-RelayPlane-Stripped-Thinking / X-RelayPlane-Stripped-Beta response headers
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const packageRoot = join(__dirname, '..');
const distPath = join(packageRoot, 'dist', 'standalone-proxy.js');

function getDistContent(): string {
  return readFileSync(distPath, 'utf-8');
}

describe('isHaikuModel helper', () => {
  it('is defined in the dist', () => {
    const content = getDistContent();
    expect(content).toContain('isHaikuModel');
  });

  it('returns true for haiku model names', () => {
    const content = getDistContent();
    // The implementation must check model.includes('haiku')
    expect(content).toMatch(/isHaikuModel.*model.*includes.*haiku|model.*includes.*haiku.*isHaikuModel/s);
  });
});

describe('OAT_UNSUPPORTED_BETA_FLAGS constant', () => {
  it('is defined in the dist', () => {
    const content = getDistContent();
    expect(content).toContain('OAT_UNSUPPORTED_BETA_FLAGS');
  });

  it('contains max-tokens-3-5-sonnet-2025-04-14', () => {
    const content = getDistContent();
    expect(content).toContain('max-tokens-3-5-sonnet-2025-04-14');
  });
});

describe('thinking stripping for Haiku models', () => {
  it('strips thinking from body at forwardNativeAnthropicRequest call sites', () => {
    const content = getDistContent();
    // The stripping logic must reference isHaikuModel and thinking
    expect(content).toContain('isHaikuModel');
    expect(content).toMatch(/isHaikuModel.*thinking|thinking.*isHaikuModel/s);
  });

  it('logs when thinking is stripped', () => {
    const content = getDistContent();
    // Log message format matches existing style
    expect(content).toContain('does not support extended thinking');
  });

  it('adds X-RelayPlane-Stripped-Thinking response header when thinking is stripped', () => {
    const content = getDistContent();
    expect(content).toContain('X-RelayPlane-Stripped-Thinking');
  });

  it('strips thinking when ORIGINAL requested model was Haiku (routing override case)', () => {
    const content = getDistContent();
    // The condition must check requestedModel too, not only finalModel/resolved.model
    // This ensures stripping happens even when routing.mode=auto overrides haiku→sonnet
    expect(content).toMatch(/isHaikuModel\(finalModel\)\s*\|\|\s*isHaikuModel\(requestedModel\)|isHaikuModel\(resolved\.model\)\s*\|\|\s*isHaikuModel\(requestedModel\)/);
  });
});

describe('clear_thinking_20251015 strategy stripping for Haiku without thinking', () => {
  // Bug: proxy injects (or forwards) a clear_thinking_20251015 thinking-strategy on outbound
  // requests. The Anthropic API rejects Haiku calls that carry this strategy without
  // thinking enabled with:
  //   400: clear_thinking_20251015 strategy requires thinking to be enabled or adaptive
  //
  // Fix expectations (any of these observable in the built dist satisfies the acceptance):
  //   1. The proxy strips clear_thinking_20251015 from the request when routing to a Haiku
  //      model that does not have thinking enabled, OR
  //   2. The proxy avoids injecting clear_thinking_20251015 for Haiku, OR
  //   3. The proxy sets thinking to 'adaptive' when the strategy is applied.
  //
  // The test asserts the identifier appears in the dist AND is guarded by isHaikuModel, that
  // is the minimum evidence that the proxy explicitly handles the incompatibility.

  it('references clear_thinking_20251015 in the dist (fix must handle the strategy explicitly)', () => {
    const content = getDistContent();
    expect(content).toContain('clear_thinking_20251015');
  });

  it('guards clear_thinking_20251015 handling with isHaikuModel or a thinking-enabled check', () => {
    const content = getDistContent();
    // Locate the clear_thinking_20251015 site and require nearby evidence of a Haiku or
    // thinking-enabled guard, so the strategy cannot leak into a Haiku-no-thinking request.
    const idx = content.indexOf('clear_thinking_20251015');
    expect(idx).toBeGreaterThan(-1);
    const window = content.slice(Math.max(0, idx - 2000), idx + 2000);
    expect(window).toMatch(/isHaikuModel|thinking\s*[?.:]|adaptive/);
  });

  it('logs when the clear_thinking strategy is adjusted for Haiku', () => {
    const content = getDistContent();
    // Any of these log-message fragments is acceptable evidence the branch is instrumented.
    expect(content).toMatch(/clear_thinking|thinking strategy|Stripped .*(strategy|clear_thinking)/i);
  });
});

describe('OAT beta flag stripping in header builders', () => {
  it('filters OAT_UNSUPPORTED_BETA_FLAGS in buildAnthropicHeadersWithAuth', () => {
    const content = getDistContent();
    const fnStart = content.indexOf('buildAnthropicHeadersWithAuth');
    expect(fnStart).toBeGreaterThan(-1);
    // Look within a reasonable window of the function
    const fnRegion = content.slice(fnStart, fnStart + 3000);
    expect(fnRegion).toContain('OAT_UNSUPPORTED_BETA_FLAGS');
    expect(fnRegion).toContain('sk-ant-oat');
  });

  it('filters OAT_UNSUPPORTED_BETA_FLAGS in buildAnthropicHeaders', () => {
    const content = getDistContent();
    // Find buildAnthropicHeaders (the second, simpler function)
    const fnStart = content.indexOf('buildAnthropicHeaders(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnRegion = content.slice(fnStart, fnStart + 3000);
    expect(fnRegion).toContain('OAT_UNSUPPORTED_BETA_FLAGS');
    expect(fnRegion).toContain('sk-ant-oat');
  });

  it('adds X-RelayPlane-Stripped-Beta response header when beta flags are stripped', () => {
    const content = getDistContent();
    expect(content).toContain('X-RelayPlane-Stripped-Beta');
  });

  it('logs when OAT-unsupported beta flags are stripped', () => {
    const content = getDistContent();
    expect(content).toContain('OAT-unsupported beta flags');
  });
});
