import { BaseAgent } from './base.js';

export class PerformanceAgent extends BaseAgent {
  readonly name = 'performance' as const;
  protected readonly promptFile = 'performance';
}
