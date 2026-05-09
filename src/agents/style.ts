import { BaseAgent } from './base.js';

export class StyleAgent extends BaseAgent {
  readonly name = 'style' as const;
  protected readonly promptFile = 'style';
}
