import Anthropic from '@anthropic-ai/sdk';
import { computeCost } from '../types.js';
import type { LLMProvider, ProviderCallConfig, ProviderResponse } from './base.js';

/**
 * Anthropic Claude provider — the default backend for agentreview.
 *
 * Uses prompt caching (cache_control: ephemeral) on system prompts so
 * repeated runs on the same codebase benefit from cache-read discounts.
 */
export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 3 });
    this.model = model;
  }

  async complete(
    systemPrompt: string,
    userMessage: string,
    config: ProviderCallConfig,
  ): Promise<ProviderResponse> {
    const response = await this.client.messages.create({
      model: config.model || this.model,
      max_tokens: config.maxTokens,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          // Prompt caching: system prompts are stable across agent runs,
          // so we mark them ephemeral to get cache-read discounts.
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Anthropic returned no text content block');
    }

    const u = response.usage as Anthropic.Usage & {
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };

    const rawUsage = {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    };

    return {
      content: textBlock.text,
      usage: { ...rawUsage, estimatedCostUsd: computeCost(rawUsage, config.model || this.model) },
    };
  }
}
