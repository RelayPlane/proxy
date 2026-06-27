# openai-native-delegation Specification

## Purpose
TBD - created by archiving change add-codex-responses-delegation. Update Purpose after archive.
## Requirements
### Requirement: Forward OpenAI-surface delegate requests to the vendor's OpenAI endpoint

OpenAI-surface delegation (`/v1/responses` and `/v1/chat/completions`) SHALL forward delegate requests in OpenAI Chat Completions format to the vendor's `/chat/completions` when the native-delegate provider declares an OpenAI-compatible base URL (`openaiBaseUrl`), using the per-vendor key, and SHALL NOT build an Anthropic body. The vendor's response SHALL be used as-is (reshaped only for `/v1/responses`).

#### Scenario: DeepSeek slug forwards in OpenAI format

- **WHEN** a delegate request for `deepseek/deepseek-pro` is forwarded and the
  `deepseek` provider has `openaiBaseUrl` `https://api.deepseek.com/v1`
- **THEN** the proxy POSTs to `https://api.deepseek.com/v1/chat/completions` with
  `Authorization: Bearer <DEEPSEEK_API_KEY>`, an OpenAI chat body, and the mapped
  model `deepseek-v4-pro`, and `buildAnthropicBody` is never called

#### Scenario: Provider without an OpenAI endpoint falls back to Anthropic

- **WHEN** a delegate provider has no `openaiBaseUrl` configured
- **THEN** OpenAI-surface delegation declines (the `/v1/responses` guard returns the
  unsupported-model error) and the existing Anthropic `/v1/messages` delegate path
  continues to serve that provider unchanged

#### Scenario: The resolver surfaces the OpenAI endpoint without disturbing the Anthropic one

- **WHEN** `resolveNativeDelegate` resolves a slug for a provider that has both
  `baseUrl` (Anthropic) and `openaiBaseUrl`
- **THEN** it returns both the Anthropic `url` and the `openaiUrl`, and the existing
  `/v1/messages` path keeps using `url` exactly as before

### Requirement: Connection-only retry on the OpenAI delegate forward

The OpenAI delegate forward SHALL reuse the resilient delegate dispatcher
(extended connect timeout) and retry ONLY connection-level failures. A returned
HTTP response (including 4xx/5xx) SHALL be surfaced without retry, so the token
plan is never double-charged.

#### Scenario: Transient connect failure is retried

- **WHEN** the initial connection to the vendor fails with a connection-level error
  (e.g. `ETIMEDOUT`, `ECONNRESET`, undici connect timeout)
- **THEN** the forward retries up to the bounded attempt limit before surfacing an
  error

#### Scenario: Upstream HTTP error is not retried

- **WHEN** the vendor returns an HTTP 429 or 5xx response
- **THEN** the proxy surfaces that status to the caller and does not retry the
  request

