import { BaseAgent } from './base.js';

export class AccessibilityAgent extends BaseAgent {
  readonly name = 'accessibility' as const;
  protected readonly promptFile = 'accessibility';
}
