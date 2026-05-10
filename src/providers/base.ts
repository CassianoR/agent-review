import type { TokenUsage } from '../types.js';

// ── Provider interface ────────────────────────────────────────────────────────

export interface ProviderCallConfig {
  model: string;
  maxTokens: number;
}

export interface ProviderResponse {
  content: string;
  usage: TokenUsage;
}

/**
 * Abstraction over an LLM provider. Implement this interface to swap in any
 * model backend (OpenAI, Gemini, local Ollama, etc.) without touching agent logic.
 */
export interface LLMProvider {
  /**
   * Send a single system+user turn and return the text response + token usage.
   * Implementations are responsible for retries, auth, and cost estimation.
   */
  complete(
    systemPrompt: string,
    userMessage: string,
    config: ProviderCallConfig,
  ): Promise<ProviderResponse>;
}

// ── Provider registry ─────────────────────────────────────────────────────────

export type ProviderName = 'anthropic' | 'openai';

export interface ProviderCredentials {
  anthropicApiKey?: string;
  openaiApiKey?: string;
}
