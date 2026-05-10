/**
 * Tests for the provider abstraction layer:
 *   - createProvider factory
 *   - AnthropicProvider (mocked SDK)
 *   - OpenAIProvider  (mocked SDK)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock Anthropic SDK ────────────────────────────────────────────────────────

const mockAnthropicCreate = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mockAnthropicCreate };
    constructor() {}
  }
  return { default: MockAnthropic };
});

// ── Mock OpenAI SDK ───────────────────────────────────────────────────────────

const mockOpenAICreate = vi.hoisted(() => vi.fn());

vi.mock('openai', () => {
  class MockOpenAI {
    chat = { completions: { create: mockOpenAICreate } };
    constructor() {}
  }
  return { default: MockOpenAI };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { createProvider } from '../src/providers/index.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAIProvider } from '../src/providers/openai.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAnthropicResponse(content: string, usage = {}) {
  return {
    content: [{ type: 'text', text: content }],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
      ...usage,
    },
  };
}

function makeOpenAIResponse(content: string, usage = {}) {
  return {
    choices: [{ message: { content } }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      ...usage,
    },
  };
}

// ── createProvider factory ────────────────────────────────────────────────────

describe('createProvider', () => {
  beforeEach(() => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    process.env['OPENAI_API_KEY'] = 'sk-openai-test';
  });

  it('returns an AnthropicProvider for "anthropic"', () => {
    const provider = createProvider('anthropic', { anthropicApiKey: 'sk-ant-test', model: 'claude-sonnet-4-6' });
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it('returns an OpenAIProvider for "openai"', () => {
    const provider = createProvider('openai', { openaiApiKey: 'sk-openai-test', model: 'gpt-4o' });
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it('throws for an unknown provider name', () => {
    expect(() =>
      // @ts-expect-error intentional bad value
      createProvider('gemini', { model: 'gemini-pro' }),
    ).toThrow(/unknown provider/i);
  });

  it('throws when anthropic key is missing', () => {
    expect(() =>
      createProvider('anthropic', { anthropicApiKey: '', model: 'claude-sonnet-4-6' }),
    ).toThrow(/ANTHROPIC_API_KEY/i);
  });

  it('throws when openai key is missing', () => {
    expect(() =>
      createProvider('openai', { openaiApiKey: '', model: 'gpt-4o' }),
    ).toThrow(/OPENAI_API_KEY/i);
  });
});

// ── AnthropicProvider ─────────────────────────────────────────────────────────

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider('sk-ant-test', 'claude-sonnet-4-6');
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse('hello'));
  });

  it('calls messages.create with the expected shape', async () => {
    await provider.complete('system', 'user', { model: 'claude-sonnet-4-6', maxTokens: 1000 });

    expect(mockAnthropicCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: 'user' }],
      }),
    );
  });

  it('adds cache_control to the system prompt block', async () => {
    await provider.complete('system prompt', 'user', { model: 'claude-sonnet-4-6', maxTokens: 1000 });

    const call = mockAnthropicCreate.mock.calls[0]?.[0];
    expect(call?.system).toEqual([
      { type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('returns the text content from the response', async () => {
    const result = await provider.complete('sys', 'user', { model: 'claude-sonnet-4-6', maxTokens: 1000 });
    expect(result.content).toBe('hello');
  });

  it('maps usage fields including cache tokens', async () => {
    const result = await provider.complete('sys', 'user', { model: 'claude-sonnet-4-6', maxTokens: 1000 });
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.cacheReadTokens).toBe(20);
    expect(result.usage.cacheWriteTokens).toBe(5);
  });

  it('estimates a non-zero cost', async () => {
    const result = await provider.complete('sys', 'user', { model: 'claude-sonnet-4-6', maxTokens: 1000 });
    expect(result.usage.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('propagates API errors', async () => {
    mockAnthropicCreate.mockRejectedValue(new Error('rate limit'));
    await expect(
      provider.complete('sys', 'user', { model: 'claude-sonnet-4-6', maxTokens: 1000 }),
    ).rejects.toThrow('rate limit');
  });
});

// ── OpenAIProvider ────────────────────────────────────────────────────────────

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    provider = new OpenAIProvider('sk-openai-test', 'gpt-4o');
    mockOpenAICreate.mockResolvedValue(makeOpenAIResponse('gpt response'));
  });

  it('calls chat.completions.create with the expected shape', async () => {
    await provider.complete('system', 'user', { model: 'gpt-4o', maxTokens: 1000 });

    expect(mockOpenAICreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o',
        max_tokens: 1000,
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'user' },
        ],
      }),
    );
  });

  it('returns the text content from the response', async () => {
    const result = await provider.complete('sys', 'user', { model: 'gpt-4o', maxTokens: 1000 });
    expect(result.content).toBe('gpt response');
  });

  it('maps usage fields (cache tokens are 0 for OpenAI)', async () => {
    const result = await provider.complete('sys', 'user', { model: 'gpt-4o', maxTokens: 1000 });
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.cacheReadTokens).toBe(0);
    expect(result.usage.cacheWriteTokens).toBe(0);
  });

  it('estimates a non-zero cost', async () => {
    const result = await provider.complete('sys', 'user', { model: 'gpt-4o', maxTokens: 1000 });
    expect(result.usage.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('propagates API errors', async () => {
    mockOpenAICreate.mockRejectedValue(new Error('network error'));
    await expect(
      provider.complete('sys', 'user', { model: 'gpt-4o', maxTokens: 1000 }),
    ).rejects.toThrow('network error');
  });
});
