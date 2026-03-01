import { describe, it, expect } from 'vitest';
import { extractRequestContent, extractResponseText } from '../src/standalone-proxy.js';

describe('extractRequestContent', () => {
  describe('Anthropic format', () => {
    it('extracts string system prompt', () => {
      const body = {
        system: 'You are a helpful assistant that writes code.',
        messages: [{ role: 'user', content: 'Write hello world' }],
      };
      const result = extractRequestContent(body, true);
      expect(result.systemPrompt).toBe('You are a helpful assistant that writes code.');
      expect(result.userMessage).toBe('Write hello world');
    });

    it('extracts array system prompt (content blocks)', () => {
      const body = {
        system: [
          { type: 'text', text: 'You are a coding assistant.' },
          { type: 'text', text: ' Be helpful.' },
        ],
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const result = extractRequestContent(body, true);
      expect(result.systemPrompt).toBe('You are a coding assistant. Be helpful.');
    });

    it('truncates system prompt to 200 chars', () => {
      const body = {
        system: 'A'.repeat(300),
        messages: [{ role: 'user', content: 'test' }],
      };
      const result = extractRequestContent(body, true);
      expect(result.systemPrompt).toHaveLength(200);
    });

    it('extracts last user message from messages array', () => {
      const body = {
        system: 'sys',
        messages: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'first answer' },
          { role: 'user', content: 'follow up question' },
        ],
      };
      const result = extractRequestContent(body, true);
      expect(result.userMessage).toBe('follow up question');
    });

    it('extracts user message with content blocks', () => {
      const body = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Look at this: ' },
              { type: 'image', source: {} },
              { type: 'text', text: 'What is it?' },
            ],
          },
        ],
      };
      const result = extractRequestContent(body, true);
      expect(result.userMessage).toBe('Look at this: What is it?');
    });

    it('returns undefined for missing content', () => {
      const body = { messages: [] as any[] };
      const result = extractRequestContent(body, true);
      expect(result.systemPrompt).toBeUndefined();
      expect(result.userMessage).toBeUndefined();
    });
  });

  describe('OpenAI format', () => {
    it('extracts system message from messages array', () => {
      const body = {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi there' },
        ],
      };
      const result = extractRequestContent(body, false);
      expect(result.systemPrompt).toBe('You are helpful.');
      expect(result.userMessage).toBe('Hi there');
    });

    it('handles missing system message', () => {
      const body = {
        messages: [{ role: 'user', content: 'Just a question' }],
      };
      const result = extractRequestContent(body, false);
      expect(result.systemPrompt).toBeUndefined();
      expect(result.userMessage).toBe('Just a question');
    });
  });

  describe('edge cases', () => {
    it('handles empty body', () => {
      const result = extractRequestContent({}, true);
      expect(result.systemPrompt).toBeUndefined();
      expect(result.userMessage).toBeUndefined();
    });

    it('handles null messages', () => {
      const result = extractRequestContent({ messages: null } as any, false);
      expect(result.systemPrompt).toBeUndefined();
      expect(result.userMessage).toBeUndefined();
    });
  });
});

describe('extractResponseText', () => {
  describe('Anthropic format', () => {
    it('extracts text from content blocks', () => {
      const response = {
        content: [
          { type: 'text', text: 'Hello! ' },
          { type: 'text', text: 'How can I help?' },
        ],
      };
      expect(extractResponseText(response, true)).toBe('Hello! How can I help?');
    });

    it('filters out non-text blocks', () => {
      const response = {
        content: [
          { type: 'text', text: 'Here is the code:' },
          { type: 'tool_use', id: 'abc', name: 'run', input: {} },
        ],
      };
      expect(extractResponseText(response, true)).toBe('Here is the code:');
    });

    it('returns empty for missing content', () => {
      expect(extractResponseText({}, true)).toBe('');
    });
  });

  describe('OpenAI format', () => {
    it('extracts from choices[0].message.content', () => {
      const response = {
        choices: [{ message: { content: 'The answer is 42.' } }],
      };
      expect(extractResponseText(response, false)).toBe('The answer is 42.');
    });

    it('returns empty for missing choices', () => {
      expect(extractResponseText({}, false)).toBe('');
      expect(extractResponseText({ choices: [] }, false)).toBe('');
    });
  });
});
