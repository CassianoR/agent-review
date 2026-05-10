import { BaseAgent } from './base.js';

export class I18nAgent extends BaseAgent {
  readonly name = 'i18n' as const;
  protected readonly promptFile = 'i18n';
}
