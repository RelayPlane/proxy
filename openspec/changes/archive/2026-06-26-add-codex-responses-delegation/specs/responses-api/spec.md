## ADDED Requirements

### Requirement: Serve OpenAI Responses requests for native-delegate models

The proxy SHALL accept `POST /v1/responses` in the OpenAI Responses request shape
and, for a model that resolves to a native delegate with an OpenAI-compatible
endpoint, return a Responses-shaped result by reshaping the request to OpenAI Chat
Completions, forwarding to the vendor, and reshaping the reply back. No Anthropic
body SHALL be constructed on this path.

#### Scenario: Non-streaming delegate request returns a Responses object

- **WHEN** a `POST /v1/responses` with `{model:"deepseek/deepseek-pro", input:"hi"}`
  resolves to a native delegate
- **THEN** the response body is a Responses object with `object:"response"`,
  `status:"completed"`, an `output[]` containing a `message` item whose
  `content[].type` is `output_text`, and `usage.input_tokens`/`usage.output_tokens`

#### Scenario: Streaming delegate request emits ordered Responses events

- **WHEN** the same request is sent with `stream:true`
- **THEN** the response is `text/event-stream` emitting, in order,
  `response.created`, one or more `response.output_text.delta`, and a terminal
  `response.completed` carrying the assembled output and usage

#### Scenario: Instructions and input are mapped to chat messages

- **WHEN** the request carries `instructions` and an `input` array of `message`
  items with `input_text`/`output_text` content parts
- **THEN** `instructions` becomes a leading system message and each `message` item
  becomes a chat message preserving role and concatenated text

#### Scenario: Tool round-trip is preserved across the reshape

- **WHEN** the request `input` contains a `function_call` and a matching
  `function_call_output` (with `call_id`), and the model replies with a tool call
- **THEN** the `function_call` maps to an assistant `tool_calls` entry, the
  `function_call_output` maps to a `tool` message keyed by `call_id`, and a model
  tool call is returned as a Responses `function_call` item carrying `name`,
  `arguments`, and `call_id`

### Requirement: Reject unsupported models on the Responses surface

The `/v1/responses` endpoint SHALL serve only models that resolve to a native
delegate with an OpenAI-compatible endpoint, and SHALL reject anything else with a
clear client error rather than forwarding it.

#### Scenario: Non-delegate model is rejected

- **WHEN** a `POST /v1/responses` names a model that does not resolve to a native
  delegate with an `openaiBaseUrl`
- **THEN** the proxy responds `400` with a message stating that `/v1/responses`
  serves native-delegate models with an OpenAI endpoint only

#### Scenario: Malformed body is rejected

- **WHEN** the request body is not valid JSON
- **THEN** the proxy responds `400` with an invalid-JSON error and does not forward
