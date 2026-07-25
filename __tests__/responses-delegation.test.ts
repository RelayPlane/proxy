import { describe, expect, it } from 'vitest';
import { responsesToChatRequest } from '../src/standalone-proxy.js';

describe('Responses delegate conversion', () => {
  it('groups sibling function calls before their function-call outputs', () => {
    const request = responsesToChatRequest({
      model: 'deepseek/deepseek-pro',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect this.' }] },
        { type: 'function_call', call_id: 'call_a', name: 'first', arguments: '{}' },
        { type: 'function_call', call_id: 'call_b', name: 'second', arguments: '{"value":2}' },
        { type: 'function_call_output', call_id: 'call_a', output: 'one' },
        { type: 'function_call_output', call_id: 'call_b', output: 'two' },
      ],
    });

    expect(request.messages).toEqual([
      { role: 'user', content: 'Inspect this.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'first', arguments: '{}' } },
          { id: 'call_b', type: 'function', function: { name: 'second', arguments: '{"value":2}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: 'one' },
      { role: 'tool', tool_call_id: 'call_b', content: 'two' },
    ]);
  });
});
