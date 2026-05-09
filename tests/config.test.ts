import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `agentreview-test-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['AGENTREVIEW_MODEL'];
});

describe('resolveConfig', () => {
  it('throws when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    await expect(resolveConfig(tmpDir, {})).rejects.toThrow('ANTHROPIC_API_KEY');
  });

  it('CLI flags override .agentreviewrc values', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-key';
    await writeFile(
      join(tmpDir, '.agentreviewrc'),
      JSON.stringify({ base: 'origin/develop', agents: ['security'] }),
    );
    const config = await resolveConfig(tmpDir, { base: 'origin/feature' });
    expect(config.base).toBe('origin/feature');
    // agents not specified in flags, so rc wins
    expect(config.agents).toEqual(['security']);
  });

  it('discovers .agentreviewrc by walking up from cwd', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-key';
    const rcContent = JSON.stringify({
      base: 'origin/staging',
      agents: ['performance'],
    });
    await writeFile(join(tmpDir, '.agentreviewrc'), rcContent);

    // Create a subdirectory and resolve from there
    const subDir = join(tmpDir, 'src', 'nested');
    await mkdir(subDir, { recursive: true });

    const config = await resolveConfig(subDir, {});
    expect(config.base).toBe('origin/staging');
    expect(config.agents).toEqual(['performance']);
  });
});
