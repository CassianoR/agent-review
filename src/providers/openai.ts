import type { LLMProvider, ProviderCallConfig, ProviderResponse } from './base.js';
import type { TokenUsage } from '../types.js';

// OpenAI pricing per million tokens (2026)
const OPENAI_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
  'o3-mini': { input: 1.1, output: 4.4 },
};

function estimateCost(inputTokens: number, outputTokens: number, model: string): number {
  const p = OPENAI_PRICING[model] ?? OPENAI_PRICING['gpt-4o']!;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

/**
 * OpenAI provider for agentreview.
 *
 * Requires the `openai` npm package to be installed:
 *   npm install openai
 *
 * Configure with OPENAI_API_KEY environment variable and --provider openai flag.
 */
export class OpenAIProvider implements LLMProvider {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async complete(
    systemPrompt: string,
    userMessage: string,
    config: ProviderCallConfig,
  ): Promise<ProviderResponse> {
    // Dynamic import so the `openai` package is optional — only loaded when this
    // provider is actually used. Users who only use Anthropic don't pay the dep cost.
    let OpenAI: typeof import('openai').default;
    try {
      const mod = await import('openai');
      OpenAI = mod.default;
    } catch {
      throw new Error(
        'The `openai` package is required for the OpenAI provider.\n' +
        'Install it: npm install openai',
      );
    }

    const client = new OpenAI({ apiKey: this.apiKey });

    const response = await client.chat.completions.create({
      model: config.model,
      max_tokens: config.maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });

    const choice = response.choices[0];
    if (!choice?.message?.content) {
      throw new Error('OpenAI returned no content in the completion');
    }

    const inputTokens = response.usage?.prompt_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;

    const usage: TokenUsage = {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: estimateCost(inputTokens, outputTokens, config.model),
    };

    return { content: choice.message.content, usage };
  }
}
