import { BaseAgent } from './base.js';

export class DocsAgent extends BaseAgent {
  readonly name = 'docs' as const;
  protected readonly promptFile = 'docs';
}
