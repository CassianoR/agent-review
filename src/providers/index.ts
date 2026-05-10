import type { LLMProvider, ProviderName } from './base.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';

export type { LLMProvider, ProviderName, ProviderCallConfig, ProviderResponse } from './base.js';
export { AnthropicProvider } from './anthropic.js';
export { OpenAIProvider } from './openai.js';

/**
 * Instantiate the correct provider from a name + credentials.
 * Throws with a clear message if the required API key is missing.
 */
export function createProvider(
  name: ProviderName,
  opts: { anthropicApiKey?: string; openaiApiKey?: string; model: string },
): LLMProvider {
  switch (name) {
    case 'anthropic': {
      const key = opts.anthropicApiKey ?? process.env['ANTHROPIC_API_KEY'];
      if (!key) throw new Error('ANTHROPIC_API_KEY is required for the Anthropic provider.');
      return new AnthropicProvider(key, opts.model);
    }
    case 'openai': {
      const key = opts.openaiApiKey ?? process.env['OPENAI_API_KEY'];
      if (!key) throw new Error('OPENAI_API_KEY is required for the OpenAI provider.');
      return new OpenAIProvider(key);
    }
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown provider: ${String(exhaustive)}`);
    }
  }
}
