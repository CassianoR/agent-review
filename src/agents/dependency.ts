import { BaseAgent } from './base.js';

export class DependencyAgent extends BaseAgent {
  readonly name = 'dependency' as const;
  protected readonly promptFile = 'dependency';
}
