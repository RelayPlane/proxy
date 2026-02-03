/**
 * RelayPlane L2/L3 Proxy Server
 *
 * An OpenAI-compatible HTTP proxy that intelligently routes requests
 * to the optimal model using @relayplane/core.
 *
 * Supports:
 * - Streaming (SSE) for both OpenAI and Anthropic
 * - Non-streaming requests
 * - Automatic format conversion (Anthropic → OpenAI format)
 * - Tool/function calling (planned)
 *
 * @packageDocumentation
 */

import * as http from 'node:http';
import * as url from 'node:url';
import { RelayPlane } from './relay.js';
import { inferTaskType, getInferenceConfidence } from './routing/inference.js';
import { loadConfig, watchConfig, getStrategy, type Config } from './config.js';
import type { Provider, TaskType } from './types.js';

/** Package version */
const VERSION = '0.1.8';

/** Recent runs buffer for /runs endpoint */
interface RecentRun {
  runId: string;
  timestamp: string;
  model: string;
  taskType: TaskType;
  confidence: number;
  mode: string;
  durationMs: number;
  promptPreview: string;
}

const recentRuns: RecentRun[] = [];
const MAX_RECENT_RUNS = 100;

/** Model distribution tracking */
const modelCounts: Record<string, number> = {};

/** Server start time for uptime */
let serverStartTime: number = 0;

/** Current configuration (hot-reloadable) */
let currentConfig: Config = loadConfig();

/**
 * Provider endpoint configuration
 */
export interface ProviderEndpoint {
  baseUrl: string;
  apiKeyEnv: string;
}

/**
 * Default provider endpoints
 */
export const DEFAULT_ENDPOINTS: Record<string, ProviderEndpoint> = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'GEMINI_API_KEY',
  },
  xai: {
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
  },
  moonshot: {
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
  },
};

/**
 * Model to provider/model mapping
 */
export const MODEL_MAPPING: Record<string, { provider: Provider; model: string }> = {
  // Anthropic models (using correct API model IDs)
  'claude-opus-4-5': { provider: 'anthropic', model: 'claude-opus-4-5-20250514' },
  'claude-sonnet-4': { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  'claude-3-5-sonnet': { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
  'claude-3-5-haiku': { provider: 'anthropic', model: 'claude-3-5-haiku-20241022' },
  haiku: { provider: 'anthropic', model: 'claude-3-5-haiku-20241022' },
  sonnet: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
  opus: { provider: 'anthropic', model: 'claude-3-opus-20240229' },
  // OpenAI models
  'gpt-4o': { provider: 'openai', model: 'gpt-4o' },
  'gpt-4o-mini': { provider: 'openai', model: 'gpt-4o-mini' },
  'gpt-4.1': { provider: 'openai', model: 'gpt-4.1' },
};

/**
 * Default routing based on task type
 * Uses Haiku 3.5 for cost optimization, upgrades based on learned rules
 */
const DEFAULT_ROUTING: Record<TaskType, { provider: Provider; model: string }> = {
  // Complex tasks → Sonnet (need reasoning & quality)
  code_review: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  analysis: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  creative_writing: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  
  // Medium tasks → Sonnet (benefit from better model)
  code_generation: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  
  // Simple tasks → Haiku (cost efficient)
  summarization: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
  data_extraction: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
  translation: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
  question_answering: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
  general: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
};

/**
 * Proxy server configuration
 */
export interface ProxyConfig {
  port?: number;
  host?: string;
  dbPath?: string;
  verbose?: boolean;
}

/**
 * Request body structure
 */
interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content: string | unknown }>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

/**
 * Extract text content from messages for routing analysis
 */
function extractPromptText(messages: ChatRequest['messages']): string {
  return messages
    .map((msg) => {
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content
          .map((c: unknown) => {
            const part = c as { type?: string; text?: string };
            return part.type === 'text' ? (part.text ?? '') : '';
          })
          .join(' ');
      }
      return '';
    })
    .join('\n');
}

/**
 * Forward non-streaming request to Anthropic API
 */
async function forwardToAnthropic(
  request: ChatRequest,
  targetModel: string,
  apiKey: string,
  betaHeaders?: string
): Promise<Response> {
  const anthropicBody = buildAnthropicBody(request, targetModel, false);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };

  // Pass through beta headers (prompt caching, extended thinking, etc.)
  if (betaHeaders) {
    headers['anthropic-beta'] = betaHeaders;
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(anthropicBody),
  });

  return response;
}

/**
 * Forward streaming request to Anthropic API
 */
async function forwardToAnthropicStream(
  request: ChatRequest,
  targetModel: string,
  apiKey: string,
  betaHeaders?: string
): Promise<Response> {
  const anthropicBody = buildAnthropicBody(request, targetModel, true);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };

  if (betaHeaders) {
    headers['anthropic-beta'] = betaHeaders;
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(anthropicBody),
  });

  return response;
}

/**
 * OpenAI message structure for type safety
 */
interface OpenAIMessage {
  role: string;
  content?: string | unknown[] | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

/**
 * Convert OpenAI messages array to Anthropic format
 * Handles: user, assistant, tool_calls, tool results
 */
function convertMessagesToAnthropic(messages: Array<{ role: string; content: string | unknown; [key: string]: unknown }>): unknown[] {
  const result: unknown[] = [];

  for (const msg of messages) {
    const m = msg as OpenAIMessage;

    // Skip system messages (handled separately)
    if (m.role === 'system') continue;

    // Tool result message → Anthropic user message with tool_result content
    if (m.role === 'tool') {
      result.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          },
        ],
      });
      continue;
    }

    // Assistant message with tool_calls → Anthropic assistant with tool_use content
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const content: unknown[] = [];

      // Add text content if present
      if (m.content && typeof m.content === 'string') {
        content.push({ type: 'text', text: m.content });
      }

      // Add tool_use blocks
      for (const tc of m.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}'),
        });
      }

      result.push({ role: 'assistant', content });
      continue;
    }

    // Regular user/assistant message
    result.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    });
  }

  return result;
}

/**
 * Build Anthropic request body from OpenAI format
 */
function buildAnthropicBody(
  request: ChatRequest,
  targetModel: string,
  stream: boolean
): Record<string, unknown> {
  // Convert OpenAI messages to Anthropic format
  const anthropicMessages = convertMessagesToAnthropic(request.messages);

  const systemMessage = request.messages.find((m) => m.role === 'system');

  const anthropicBody: Record<string, unknown> = {
    model: targetModel,
    messages: anthropicMessages,
    max_tokens: request.max_tokens ?? 4096,
    stream,
  };

  if (systemMessage) {
    anthropicBody['system'] = systemMessage.content;
  }

  if (request.temperature !== undefined) {
    anthropicBody['temperature'] = request.temperature;
  }

  // Convert OpenAI tools format to Anthropic tools format
  if (request.tools && Array.isArray(request.tools)) {
    anthropicBody['tools'] = convertToolsToAnthropic(request.tools);
  }

  // Convert tool_choice
  if (request.tool_choice) {
    anthropicBody['tool_choice'] = convertToolChoiceToAnthropic(request.tool_choice);
  }

  return anthropicBody;
}

/**
 * Convert OpenAI tools format to Anthropic format
 * OpenAI: { type: "function", function: { name, description, parameters } }
 * Anthropic: { name, description, input_schema }
 */
function convertToolsToAnthropic(tools: unknown[]): unknown[] {
  return tools.map((tool: unknown) => {
    const t = tool as { type?: string; function?: { name?: string; description?: string; parameters?: unknown } };
    if (t.type === 'function' && t.function) {
      return {
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: 'object', properties: {} },
      };
    }
    // Already in Anthropic format or unknown
    return tool;
  });
}

/**
 * Convert OpenAI tool_choice to Anthropic format
 */
function convertToolChoiceToAnthropic(toolChoice: unknown): unknown {
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'none') return { type: 'none' };
  if (toolChoice === 'required') return { type: 'any' };
  
  // Specific tool: { type: "function", function: { name: "xxx" } }
  const tc = toolChoice as { type?: string; function?: { name?: string } };
  if (tc.type === 'function' && tc.function?.name) {
    return { type: 'tool', name: tc.function.name };
  }
  
  return toolChoice;
}

/**
 * Forward non-streaming request to OpenAI API
 */
async function forwardToOpenAI(
  request: ChatRequest,
  targetModel: string,
  apiKey: string
): Promise<Response> {
  const openaiBody = {
    ...request,
    model: targetModel,
    stream: false,
  };

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(openaiBody),
  });

  return response;
}

/**
 * Forward streaming request to OpenAI API
 */
async function forwardToOpenAIStream(
  request: ChatRequest,
  targetModel: string,
  apiKey: string
): Promise<Response> {
  const openaiBody = {
    ...request,
    model: targetModel,
    stream: true,
  };

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(openaiBody),
  });

  return response;
}

/**
 * Forward non-streaming request to xAI API (OpenAI-compatible)
 */
async function forwardToXAI(
  request: ChatRequest,
  targetModel: string,
  apiKey: string
): Promise<Response> {
  const xaiBody = {
    ...request,
    model: targetModel,
    stream: false,
  };

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(xaiBody),
  });

  return response;
}

/**
 * Forward streaming request to xAI API (OpenAI-compatible)
 */
async function forwardToXAIStream(
  request: ChatRequest,
  targetModel: string,
  apiKey: string
): Promise<Response> {
  const xaiBody = {
    ...request,
    model: targetModel,
    stream: true,
  };

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(xaiBody),
  });

  return response;
}

/**
 * Forward non-streaming request to Moonshot API (OpenAI-compatible)
 */
async function forwardToMoonshot(
  request: ChatRequest,
  targetModel: string,
  apiKey: string
): Promise<Response> {
  const moonshotBody = {
    ...request,
    model: targetModel,
    stream: false,
  };

  const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(moonshotBody),
  });

  return response;
}

/**
 * Forward streaming request to Moonshot API (OpenAI-compatible)
 */
async function forwardToMoonshotStream(
  request: ChatRequest,
  targetModel: string,
  apiKey: string
): Promise<Response> {
  const moonshotBody = {
    ...request,
    model: targetModel,
    stream: true,
  };

  const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(moonshotBody),
  });

  return response;
}

/**
 * Convert OpenAI messages to Gemini format
 */
function convertMessagesToGemini(messages: ChatRequest['messages']): unknown[] {
  const geminiContents: unknown[] = [];
  
  for (const msg of messages) {
    // Skip system messages (handled separately via systemInstruction)
    if (msg.role === 'system') continue;
    
    const role = msg.role === 'assistant' ? 'model' : 'user';
    
    if (typeof msg.content === 'string') {
      geminiContents.push({
        role,
        parts: [{ text: msg.content }],
      });
    } else if (Array.isArray(msg.content)) {
      // Handle multimodal content
      const parts = msg.content.map((part: unknown) => {
        const p = part as { type?: string; text?: string; image_url?: { url?: string } };
        if (p.type === 'text') {
          return { text: p.text };
        }
        if (p.type === 'image_url' && p.image_url?.url) {
          // Handle base64 images
          const url = p.image_url.url;
          if (url.startsWith('data:')) {
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              return {
                inline_data: {
                  mime_type: match[1],
                  data: match[2],
                },
              };
            }
          }
          // URL-based images not directly supported, return as text
          return { text: `[Image: ${url}]` };
        }
        return { text: '' };
      });
      geminiContents.push({ role, parts });
    }
  }
  
  return geminiContents;
}

/**
 * Forward non-streaming request to Gemini API
 */
async function forwardToGemini(
  request: ChatRequest,
  targetModel: string,
  apiKey: string
): Promise<Response> {
  const systemMessage = request.messages.find((m) => m.role === 'system');
  const geminiContents = convertMessagesToGemini(request.messages);
  
  const geminiBody: Record<string, unknown> = {
    contents: geminiContents,
    generationConfig: {
      maxOutputTokens: request.max_tokens ?? 4096,
    },
  };
  
  if (request.temperature !== undefined) {
    (geminiBody['generationConfig'] as Record<string, unknown>)['temperature'] = request.temperature;
  }
  
  if (systemMessage && typeof systemMessage.content === 'string') {
    geminiBody['systemInstruction'] = {
      parts: [{ text: systemMessage.content }],
    };
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(geminiBody),
    }
  );

  return response;
}

/**
 * Forward streaming request to Gemini API
 */
async function forwardToGeminiStream(
  request: ChatRequest,
  targetModel: string,
  apiKey: string
): Promise<Response> {
  const systemMessage = request.messages.find((m) => m.role === 'system');
  const geminiContents = convertMessagesToGemini(request.messages);
  
  const geminiBody: Record<string, unknown> = {
    contents: geminiContents,
    generationConfig: {
      maxOutputTokens: request.max_tokens ?? 4096,
    },
  };
  
  if (request.temperature !== undefined) {
    (geminiBody['generationConfig'] as Record<string, unknown>)['temperature'] = request.temperature;
  }
  
  if (systemMessage && typeof systemMessage.content === 'string') {
    geminiBody['systemInstruction'] = {
      parts: [{ text: systemMessage.content }],
    };
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:streamGenerateContent?alt=sse&key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(geminiBody),
    }
  );

  return response;
}

/**
 * Gemini API response structure
 */
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

/**
 * Convert Gemini response to OpenAI format
 */
function convertGeminiResponse(geminiData: GeminiResponse, model: string): Record<string, unknown> {
  const candidate = geminiData.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  
  let finishReason = 'stop';
  if (candidate?.finishReason === 'MAX_TOKENS') {
    finishReason = 'length';
  } else if (candidate?.finishReason === 'SAFETY') {
    finishReason = 'content_filter';
  }

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text,
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: geminiData.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: geminiData.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens:
        (geminiData.usageMetadata?.promptTokenCount ?? 0) +
        (geminiData.usageMetadata?.candidatesTokenCount ?? 0),
    },
  };
}

/**
 * Convert Gemini streaming event to OpenAI format
 */
function convertGeminiStreamEvent(
  eventData: GeminiResponse,
  messageId: string,
  model: string,
  isFirst: boolean
): string | null {
  const candidate = eventData.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  
  const choice: Record<string, unknown> = {
    index: 0,
    delta: {},
    finish_reason: null,
  };
  
  if (isFirst) {
    choice['delta'] = { role: 'assistant', content: text };
  } else if (text) {
    choice['delta'] = { content: text };
  }
  
  // Check for finish
  if (candidate?.finishReason) {
    let finishReason = 'stop';
    if (candidate.finishReason === 'MAX_TOKENS') {
      finishReason = 'length';
    } else if (candidate.finishReason === 'SAFETY') {
      finishReason = 'content_filter';
    }
    choice['finish_reason'] = finishReason;
  }
  
  const chunk = {
    id: messageId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [choice],
  };
  
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Parse Gemini SSE stream and convert to OpenAI format
 */
async function* convertGeminiStream(
  response: Response,
  model: string
): AsyncGenerator<string, void, unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  const messageId = `chatcmpl-${Date.now()}`;
  let isFirst = true;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events (Gemini uses "data: " prefix)
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          if (jsonStr.trim() === '[DONE]') {
            yield 'data: [DONE]\n\n';
            continue;
          }
          try {
            const parsed = JSON.parse(jsonStr) as GeminiResponse;
            const converted = convertGeminiStreamEvent(parsed, messageId, model, isFirst);
            if (converted) {
              yield converted;
              isFirst = false;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }
    
    // Send [DONE] at the end
    yield 'data: [DONE]\n\n';
  } finally {
    reader.releaseLock();
  }
}

/**
 * Anthropic API response structure
 */
interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

/**
 * Convert Anthropic response to OpenAI format
 * Handles both text and tool_use content blocks
 */
function convertAnthropicResponse(anthropicData: AnthropicResponse): Record<string, unknown> {
  const textBlocks = anthropicData.content?.filter((c) => c.type === 'text') ?? [];
  const toolBlocks = anthropicData.content?.filter((c) => c.type === 'tool_use') ?? [];

  const textContent = textBlocks.map((c) => c.text ?? '').join('');

  // Build message object
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: textContent || null,
  };

  // Convert tool_use blocks to OpenAI tool_calls format
  if (toolBlocks.length > 0) {
    message['tool_calls'] = toolBlocks.map((block) => ({
      id: block.id || `call_${Date.now()}`,
      type: 'function',
      function: {
        name: block.name,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
      },
    }));
  }

  // Determine finish_reason
  let finishReason = 'stop';
  if (anthropicData.stop_reason === 'tool_use') {
    finishReason = 'tool_calls';
  } else if (anthropicData.stop_reason === 'end_turn') {
    finishReason = 'stop';
  } else if (anthropicData.stop_reason) {
    finishReason = anthropicData.stop_reason;
  }

  return {
    id: anthropicData.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthropicData.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: anthropicData.usage?.input_tokens ?? 0,
      completion_tokens: anthropicData.usage?.output_tokens ?? 0,
      total_tokens: (anthropicData.usage?.input_tokens ?? 0) + (anthropicData.usage?.output_tokens ?? 0),
    },
  };
}

/**
 * Streaming state for tracking tool calls across events
 */
interface StreamingToolState {
  currentToolIndex: number;
  tools: Map<number, { id: string; name: string; arguments: string }>;
}

/**
 * Convert Anthropic streaming event to OpenAI streaming chunk format
 * Handles both text content and tool_use streaming
 */
function convertAnthropicStreamEvent(
  eventType: string,
  eventData: Record<string, unknown>,
  messageId: string,
  model: string,
  toolState: StreamingToolState
): string | null {
  const choice = { index: 0, delta: {} as Record<string, unknown>, finish_reason: null as string | null };
  const baseChunk = {
    id: messageId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [choice],
  };

  switch (eventType) {
    case 'message_start': {
      // First chunk: include role
      const msg = eventData['message'] as Record<string, unknown> | undefined;
      baseChunk.id = (msg?.['id'] as string) || messageId;
      choice.delta = { role: 'assistant', content: '' };
      return `data: ${JSON.stringify(baseChunk)}\n\n`;
    }

    case 'content_block_start': {
      // New content block starting - could be text or tool_use
      const contentBlock = eventData['content_block'] as Record<string, unknown> | undefined;
      const blockIndex = eventData['index'] as number | undefined;
      
      if (contentBlock?.['type'] === 'tool_use') {
        // Tool use starting - send first chunk with tool info
        const toolId = contentBlock['id'] as string;
        const toolName = contentBlock['name'] as string;
        
        toolState.tools.set(blockIndex ?? toolState.currentToolIndex, {
          id: toolId,
          name: toolName,
          arguments: '',
        });
        toolState.currentToolIndex = blockIndex ?? toolState.currentToolIndex;
        
        choice.delta = {
          tool_calls: [{
            index: blockIndex ?? 0,
            id: toolId,
            type: 'function',
            function: { name: toolName, arguments: '' },
          }],
        };
        return `data: ${JSON.stringify(baseChunk)}\n\n`;
      }
      return null;
    }

    case 'content_block_delta': {
      // Content chunk - text or tool arguments
      const delta = eventData['delta'] as Record<string, unknown> | undefined;
      const blockIndex = eventData['index'] as number | undefined;
      
      if (delta?.['type'] === 'text_delta') {
        choice.delta = { content: delta['text'] as string };
        return `data: ${JSON.stringify(baseChunk)}\n\n`;
      }
      
      if (delta?.['type'] === 'input_json_delta') {
        // Tool arguments streaming
        const partialJson = delta['partial_json'] as string || '';
        const tool = toolState.tools.get(blockIndex ?? toolState.currentToolIndex);
        if (tool) {
          tool.arguments += partialJson;
        }
        
        choice.delta = {
          tool_calls: [{
            index: blockIndex ?? 0,
            function: { arguments: partialJson },
          }],
        };
        return `data: ${JSON.stringify(baseChunk)}\n\n`;
      }
      return null;
    }

    case 'message_delta': {
      // Final chunk with stop reason
      const delta = eventData['delta'] as Record<string, unknown> | undefined;
      const stopReason = delta?.['stop_reason'] as string | undefined;
      
      if (stopReason === 'tool_use') {
        choice.finish_reason = 'tool_calls';
      } else if (stopReason === 'end_turn') {
        choice.finish_reason = 'stop';
      } else {
        choice.finish_reason = stopReason || 'stop';
      }
      choice.delta = {};
      return `data: ${JSON.stringify(baseChunk)}\n\n`;
    }

    case 'message_stop': {
      // Stream complete
      return 'data: [DONE]\n\n';
    }

    default:
      return null;
  }
}

/**
 * Parse SSE stream from Anthropic and convert to OpenAI format
 */
async function* convertAnthropicStream(
  response: Response,
  model: string
): AsyncGenerator<string, void, unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let messageId = `chatcmpl-${Date.now()}`;
  
  // Tool state for tracking streaming tool calls
  const toolState: StreamingToolState = {
    currentToolIndex: 0,
    tools: new Map(),
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      let eventType = '';
      let eventData = '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          eventData = line.slice(6);
        } else if (line === '' && eventType && eventData) {
          // Complete event, process it
          try {
            const parsed = JSON.parse(eventData) as Record<string, unknown>;
            const converted = convertAnthropicStreamEvent(eventType, parsed, messageId, model, toolState);
            if (converted) {
              yield converted;
            }
          } catch {
            // Skip malformed JSON
          }
          eventType = '';
          eventData = '';
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Pipe OpenAI streaming response directly (already in correct format)
 */
async function* pipeOpenAIStream(
  response: Response
): AsyncGenerator<string, void, unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse preferred model string (format: "provider:model")
 */
function parsePreferredModel(
  preferredModel: string
): { provider: Provider; model: string } | null {
  const [provider, model] = preferredModel.split(':');
  if (!provider || !model) return null;

  // Validate provider
  const validProviders: Provider[] = ['openai', 'anthropic', 'google', 'xai', 'moonshot', 'local'];
  if (!validProviders.includes(provider as Provider)) return null;

  return { provider: provider as Provider, model };
}

/**
 * Resolve explicit model name to provider and model
 * Handles direct model names like "claude-3-5-sonnet-latest" or "gpt-4o"
 */
function resolveExplicitModel(
  modelName: string
): { provider: Provider; model: string } | null {
  // Check MODEL_MAPPING first (aliases)
  if (MODEL_MAPPING[modelName]) {
    return MODEL_MAPPING[modelName];
  }

  // Anthropic models (claude-*)
  if (modelName.startsWith('claude-')) {
    return { provider: 'anthropic', model: modelName };
  }

  // OpenAI models (gpt-*, o1-*, chatgpt-*, text-*, dall-e-*, whisper-*, tts-*)
  if (
    modelName.startsWith('gpt-') ||
    modelName.startsWith('o1-') ||
    modelName.startsWith('o3-') ||
    modelName.startsWith('chatgpt-') ||
    modelName.startsWith('text-') ||
    modelName.startsWith('dall-e') ||
    modelName.startsWith('whisper') ||
    modelName.startsWith('tts-')
  ) {
    return { provider: 'openai', model: modelName };
  }

  // Google models (gemini-*, palm-*)
  if (modelName.startsWith('gemini-') || modelName.startsWith('palm-')) {
    return { provider: 'google', model: modelName };
  }

  // xAI models (grok-*)
  if (modelName.startsWith('grok-')) {
    return { provider: 'xai', model: modelName };
  }

  // Moonshot models (moonshot-*)
  if (modelName.startsWith('moonshot-')) {
    return { provider: 'moonshot', model: modelName };
  }

  // Provider-prefixed format: "anthropic/claude-3-5-sonnet-latest"
  if (modelName.includes('/')) {
    const [provider, model] = modelName.split('/');
    const validProviders: Provider[] = ['openai', 'anthropic', 'google', 'xai', 'moonshot', 'local'];
    if (provider && model && validProviders.includes(provider as Provider)) {
      return { provider: provider as Provider, model };
    }
  }

  return null;
}

/**
 * Start the RelayPlane proxy server
 */
export async function startProxy(config: ProxyConfig = {}): Promise<http.Server> {
  const port = config.port ?? 3001;
  const host = config.host ?? '127.0.0.1';
  const verbose = config.verbose ?? false;

  // Initialize RelayPlane
  const relay = new RelayPlane({ dbPath: config.dbPath });

  const log = (msg: string) => {
    if (verbose) console.log(`[relayplane] ${msg}`);
  };

  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = url.parse(req.url || '', true);
    const pathname = parsedUrl.pathname || '';

    // =========================================================================
    // GET /health - Server health and version info
    // =========================================================================
    if (req.method === 'GET' && pathname === '/health') {
      const uptimeMs = Date.now() - serverStartTime;
      const uptimeSecs = Math.floor(uptimeMs / 1000);
      const hours = Math.floor(uptimeSecs / 3600);
      const mins = Math.floor((uptimeSecs % 3600) / 60);
      const secs = uptimeSecs % 60;

      // Check which providers have API keys
      const providers: Record<string, boolean> = {};
      for (const [name, config] of Object.entries(DEFAULT_ENDPOINTS)) {
        providers[name] = !!process.env[config.apiKeyEnv];
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: VERSION,
        uptime: `${hours}h ${mins}m ${secs}s`,
        uptimeMs,
        providers,
        totalRuns: recentRuns.length > 0 ? Object.values(modelCounts).reduce((a, b) => a + b, 0) : 0,
      }));
      return;
    }

    // =========================================================================
    // GET /stats - Aggregated statistics
    // =========================================================================
    if (req.method === 'GET' && pathname === '/stats') {
      const stats = relay.stats();
      const savings = relay.savingsReport(30);

      // Calculate model distribution from our tracking
      const totalRuns = Object.values(modelCounts).reduce((a, b) => a + b, 0);
      const modelDistribution: Record<string, { count: number; percentage: string }> = {};
      
      for (const [model, count] of Object.entries(modelCounts)) {
        modelDistribution[model] = {
          count,
          percentage: totalRuns > 0 ? ((count / totalRuns) * 100).toFixed(1) + '%' : '0%',
        };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        totalRuns,
        savings: {
          estimatedSavingsPercent: savings.savingsPercent.toFixed(1) + '%',
          actualCostUsd: savings.actualCost.toFixed(4),
          baselineCostUsd: savings.baselineCost.toFixed(4),
          savedUsd: savings.savings.toFixed(4),
        },
        modelDistribution,
        byTaskType: stats.byTaskType,
        period: stats.period,
      }));
      return;
    }

    // =========================================================================
    // GET /runs - Recent routing decisions
    // =========================================================================
    if (req.method === 'GET' && pathname === '/runs') {
      const limitParam = parsedUrl.query['limit'];
      const parsedLimit = limitParam ? parseInt(String(limitParam), 10) : 20;
      const limit = Math.min(Number.isNaN(parsedLimit) ? 20 : parsedLimit, MAX_RECENT_RUNS);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        runs: recentRuns.slice(0, limit),
        total: recentRuns.length,
      }));
      return;
    }

    // =========================================================================
    // GET /models - Available models
    // =========================================================================
    if (req.method === 'GET' && pathname.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'relayplane:auto', object: 'model', owned_by: 'relayplane' },
            { id: 'relayplane:cost', object: 'model', owned_by: 'relayplane' },
            { id: 'relayplane:quality', object: 'model', owned_by: 'relayplane' },
          ],
        })
      );
      return;
    }

    // Only handle POST to /v1/chat/completions
    if (req.method !== 'POST' || !pathname.includes('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Parse request body
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let request: ChatRequest;
    try {
      request = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const isStreaming = request.stream === true;

    // Extract routing mode from model name
    const requestedModel = request.model;
    let routingMode: 'auto' | 'cost' | 'quality' | 'passthrough' = 'auto';
    let targetModel: string = '';
    let targetProvider: Provider = 'anthropic';

    // Check if this is a RelayPlane routing model or explicit pass-through
    if (requestedModel.startsWith('relayplane:')) {
      // RelayPlane smart routing
      if (requestedModel.includes(':cost')) {
        routingMode = 'cost';
      } else if (requestedModel.includes(':quality')) {
        routingMode = 'quality';
      }
    } else {
      // Explicit model pass-through (L3 mode)
      routingMode = 'passthrough';
      const resolved = resolveExplicitModel(requestedModel);
      if (resolved) {
        targetProvider = resolved.provider;
        targetModel = resolved.model;
        log(`Pass-through mode: ${requestedModel} → ${targetProvider}/${targetModel}`);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown model: ${requestedModel}` }));
        return;
      }
    }

    log(`Received request for model: ${requestedModel} (mode: ${routingMode}, stream: ${isStreaming})`);

    // Infer task type from prompt (for logging/learning, even in passthrough)
    const promptText = extractPromptText(request.messages);
    const taskType = inferTaskType(promptText);
    const confidence = getInferenceConfidence(promptText, taskType);

    log(`Inferred task: ${taskType} (confidence: ${confidence.toFixed(2)})`);

    // Smart routing only for RelayPlane models
    if (routingMode !== 'passthrough') {
      // 1. Check config strategies first (user-defined)
      const configStrategy = getStrategy(currentConfig, taskType);

      if (configStrategy) {
        const parsed = parsePreferredModel(configStrategy.model);
        if (parsed) {
          targetProvider = parsed.provider;
          targetModel = parsed.model;
          log(`Using config strategy: ${configStrategy.model}`);
        }
      }

      // 2. If no config strategy, check learned rules
      if (!configStrategy) {
        const rule = relay.routing.get(taskType);

        if (rule && rule.preferredModel) {
          const parsed = parsePreferredModel(rule.preferredModel);
          if (parsed) {
            targetProvider = parsed.provider;
            targetModel = parsed.model;
            log(`Using learned rule: ${rule.preferredModel}`);
          } else {
            // Fallback to defaults
            const defaultRoute = DEFAULT_ROUTING[taskType];
            targetProvider = defaultRoute.provider;
            targetModel = defaultRoute.model;
          }
        } else {
          // Use default routing
          const defaultRoute = DEFAULT_ROUTING[taskType];
          targetProvider = defaultRoute.provider;
          targetModel = defaultRoute.model;
        }
      }

      // Override based on routing mode
      if (routingMode === 'cost') {
        // Use config's cost model or fallback
        const costModel = currentConfig.defaults?.costModel || 'claude-3-5-haiku-latest';
        targetModel = costModel;
        targetProvider = 'anthropic';
        log(`Cost mode: using ${costModel}`);
      } else if (routingMode === 'quality') {
        // Use config's quality model or fallback
        const qualityModel = currentConfig.defaults?.qualityModel || process.env['RELAYPLANE_QUALITY_MODEL'] || 'claude-sonnet-4-20250514';
        targetModel = qualityModel;
        targetProvider = 'anthropic';
        log(`Quality mode: using ${qualityModel}`);
      }
    }

    log(`Routing to: ${targetProvider}/${targetModel}`);

    // Get API key for target provider
    const apiKeyEnv = DEFAULT_ENDPOINTS[targetProvider]?.apiKeyEnv ?? `${targetProvider.toUpperCase()}_API_KEY`;
    const apiKey = process.env[apiKeyEnv];

    if (!apiKey) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Missing ${apiKeyEnv} environment variable` }));
      return;
    }

    const startTime = Date.now();

    // Extract Anthropic beta headers from request (for prompt caching, extended thinking, etc.)
    const betaHeaders = req.headers['anthropic-beta'] as string | undefined;

    // Handle streaming vs non-streaming
    if (isStreaming) {
      await handleStreamingRequest(
        res,
        request,
        targetProvider,
        targetModel,
        apiKey,
        relay,
        promptText,
        taskType,
        confidence,
        routingMode,
        startTime,
        log,
        betaHeaders
      );
    } else {
      await handleNonStreamingRequest(
        res,
        request,
        targetProvider,
        targetModel,
        apiKey,
        relay,
        promptText,
        taskType,
        confidence,
        routingMode,
        startTime,
        log,
        betaHeaders
      );
    }
  });

  // Set up config hot-reload
  watchConfig((newConfig) => {
    currentConfig = newConfig;
    console.log('[relayplane] Config reloaded');
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      serverStartTime = Date.now();
      console.log(`RelayPlane proxy listening on http://${host}:${port}`);
      console.log(`  Models: relayplane:auto, relayplane:cost, relayplane:quality`);
      console.log(`  Endpoint: POST /v1/chat/completions`);
      console.log(`  Stats: GET /stats, /runs, /health`);
      console.log(`  Config: ~/.relayplane/config.json (hot-reload enabled)`);
      console.log(`  Streaming: ✅ Enabled`);
      resolve(server);
    });
  });
}

/**
 * Handle streaming request
 */
async function handleStreamingRequest(
  res: http.ServerResponse,
  request: ChatRequest,
  targetProvider: Provider,
  targetModel: string,
  apiKey: string,
  relay: RelayPlane,
  promptText: string,
  taskType: TaskType,
  confidence: number,
  routingMode: string,
  startTime: number,
  log: (msg: string) => void,
  betaHeaders?: string
): Promise<void> {
  let providerResponse: Response;

  try {
    switch (targetProvider) {
      case 'anthropic':
        providerResponse = await forwardToAnthropicStream(request, targetModel, apiKey, betaHeaders);
        break;
      case 'google':
        providerResponse = await forwardToGeminiStream(request, targetModel, apiKey);
        break;
      case 'xai':
        providerResponse = await forwardToXAIStream(request, targetModel, apiKey);
        break;
      case 'moonshot':
        providerResponse = await forwardToMoonshotStream(request, targetModel, apiKey);
        break;
      default:
        providerResponse = await forwardToOpenAIStream(request, targetModel, apiKey);
    }

    if (!providerResponse.ok) {
      const errorData = await providerResponse.json();
      res.writeHead(providerResponse.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(errorData));
      return;
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Provider error: ${errorMsg}` }));
    return;
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  try {
    // Stream the response based on provider format
    switch (targetProvider) {
      case 'anthropic':
        // Convert Anthropic stream to OpenAI format
        for await (const chunk of convertAnthropicStream(providerResponse, targetModel)) {
          res.write(chunk);
        }
        break;
      case 'google':
        // Convert Gemini stream to OpenAI format
        for await (const chunk of convertGeminiStream(providerResponse, targetModel)) {
          res.write(chunk);
        }
        break;
      default:
        // xAI, Moonshot, OpenAI all use OpenAI-compatible streaming format
        for await (const chunk of pipeOpenAIStream(providerResponse)) {
          res.write(chunk);
        }
    }
  } catch (err) {
    log(`Streaming error: ${err}`);
  }

  const durationMs = Date.now() - startTime;
  const modelKey = `${targetProvider}/${targetModel}`;

  // Track model distribution
  modelCounts[modelKey] = (modelCounts[modelKey] || 0) + 1;

  // Record the run (non-blocking)
  relay
    .run({
      prompt: promptText.slice(0, 500),
      taskType,
      model: `${targetProvider}:${targetModel}`,
    })
    .then((runResult) => {
      // Track recent run for /runs endpoint
      recentRuns.unshift({
        runId: runResult.runId,
        timestamp: new Date().toISOString(),
        model: modelKey,
        taskType,
        confidence,
        mode: routingMode,
        durationMs,
        promptPreview: promptText.slice(0, 100) + (promptText.length > 100 ? '...' : ''),
      });
      if (recentRuns.length > MAX_RECENT_RUNS) {
        recentRuns.pop();
      }
      log(`Completed streaming in ${durationMs}ms, runId: ${runResult.runId}`);
    })
    .catch((err) => {
      log(`Failed to record run: ${err}`);
    });

  res.end();
}

/**
 * Handle non-streaming request
 */
async function handleNonStreamingRequest(
  res: http.ServerResponse,
  request: ChatRequest,
  targetProvider: Provider,
  targetModel: string,
  apiKey: string,
  relay: RelayPlane,
  promptText: string,
  taskType: TaskType,
  confidence: number,
  routingMode: string,
  startTime: number,
  log: (msg: string) => void,
  betaHeaders?: string
): Promise<void> {
  let providerResponse: Response;
  let responseData: Record<string, unknown>;

  try {
    switch (targetProvider) {
      case 'anthropic': {
        providerResponse = await forwardToAnthropic(request, targetModel, apiKey, betaHeaders);
        const rawData = (await providerResponse.json()) as AnthropicResponse;

        if (!providerResponse.ok) {
          res.writeHead(providerResponse.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(rawData));
          return;
        }

        // Convert to OpenAI format
        responseData = convertAnthropicResponse(rawData);
        break;
      }
      case 'google': {
        providerResponse = await forwardToGemini(request, targetModel, apiKey);
        const rawData = (await providerResponse.json()) as GeminiResponse;

        if (!providerResponse.ok) {
          res.writeHead(providerResponse.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(rawData));
          return;
        }

        // Convert to OpenAI format
        responseData = convertGeminiResponse(rawData, targetModel);
        break;
      }
      case 'xai': {
        providerResponse = await forwardToXAI(request, targetModel, apiKey);
        responseData = (await providerResponse.json()) as Record<string, unknown>;

        if (!providerResponse.ok) {
          res.writeHead(providerResponse.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responseData));
          return;
        }
        break;
      }
      case 'moonshot': {
        providerResponse = await forwardToMoonshot(request, targetModel, apiKey);
        responseData = (await providerResponse.json()) as Record<string, unknown>;

        if (!providerResponse.ok) {
          res.writeHead(providerResponse.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responseData));
          return;
        }
        break;
      }
      default: {
        providerResponse = await forwardToOpenAI(request, targetModel, apiKey);
        responseData = (await providerResponse.json()) as Record<string, unknown>;

        if (!providerResponse.ok) {
          res.writeHead(providerResponse.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responseData));
          return;
        }
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Provider error: ${errorMsg}` }));
    return;
  }

  const durationMs = Date.now() - startTime;
  const modelKey = `${targetProvider}/${targetModel}`;

  // Track model distribution
  modelCounts[modelKey] = (modelCounts[modelKey] || 0) + 1;

  // Record the run in RelayPlane
  try {
    const runResult = await relay.run({
      prompt: promptText.slice(0, 500),
      taskType,
      model: `${targetProvider}:${targetModel}`,
    });

    // Track recent run for /runs endpoint
    recentRuns.unshift({
      runId: runResult.runId,
      timestamp: new Date().toISOString(),
      model: modelKey,
      taskType,
      confidence,
      mode: routingMode,
      durationMs,
      promptPreview: promptText.slice(0, 100) + (promptText.length > 100 ? '...' : ''),
    });
    if (recentRuns.length > MAX_RECENT_RUNS) {
      recentRuns.pop();
    }

    // Add routing metadata to response
    responseData['_relayplane'] = {
      runId: runResult.runId,
      routedTo: modelKey,
      taskType,
      confidence,
      durationMs,
      mode: routingMode,
    };

    log(`Completed in ${durationMs}ms, runId: ${runResult.runId}`);
  } catch (err) {
    log(`Failed to record run: ${err}`);
  }

  // Send response
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(responseData));
}

/**
 * CLI entry point
 */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let port = 3001;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1] ?? '3001', 10);
      i++;
    } else if (args[i] === '-v' || args[i] === '--verbose') {
      verbose = true;
    }
  }

  try {
    await startProxy({ port, verbose });
  } catch (err) {
    console.error('Failed to start proxy:', err);
    process.exit(1);
  }
}

// Note: Use cli.ts for direct execution
// This module is imported by cli.ts
