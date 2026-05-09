import { simpleGit } from 'simple-git';
import type { Diff, DiffFile } from '../types.js';

export async function findGitRoot(startPath: string): Promise<string> {
  const git = simpleGit(startPath);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error(`Not a git repository: ${startPath}`);
  }
  const root = await git.revparse(['--show-toplevel']);
  return root.trim();
}

export async function computeDiff(base: string, repoRoot: string): Promise<Diff> {
  const git = simpleGit(repoRoot);

  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error(`Not a git repository: ${repoRoot}`);
  }

  // Non-fatal fetch — allow offline usage
  try {
    await git.fetch();
  } catch {
    // continue with local refs
  }

  const head = (await git.revparse(['HEAD'])).trim();

  const rawDiff = await git.diff([base, 'HEAD']);

  const diffSummary = await git.diffSummary([base, 'HEAD']);

  const files: DiffFile[] = [];
  for (const file of diffSummary.files) {
    const filePath = 'file' in file ? file.file : '';
    if (!filePath) continue;

    const patch = await git.diff([base, 'HEAD', '--', filePath]);

    const addMatches = patch.match(/^\+[^+]/gm);
    const delMatches = patch.match(/^-[^-]/gm);

    files.push({
      path: filePath,
      status: inferStatus(),
      patch,
      additions: addMatches?.length ?? 0,
      deletions: delMatches?.length ?? 0,
    });
  }

  return {
    base,
    head,
    files,
    rawDiff,
    totalAdditions: diffSummary.insertions,
    totalDeletions: diffSummary.deletions,
    repoRoot,
  };
}

function inferStatus(): DiffFile['status'] {
  // simple-git's diffSummary doesn't expose add/rename/delete per file directly.
  return 'modified';
}
