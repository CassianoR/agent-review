import { BaseAgent } from './base.js';

export class SecurityAgent extends BaseAgent {
  readonly name = 'security' as const;
  protected readonly promptFile = 'security';
}
