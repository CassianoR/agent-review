import { BaseAgent } from './base.js';

export class TestsAgent extends BaseAgent {
  readonly name = 'tests' as const;
  protected readonly promptFile = 'tests';
}
