import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256Hex, type MesaiRepository } from '../db/repositories';
import { toLocalIsoString } from './timestamp-resolver';
import type { MatcherService } from './matcher-service';
import type { Project } from '../../shared/types';

export function shouldExcludeFilePath(
  relativePath: string,
  globalExclusions: string[],
  projectExclusions: string[]
): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return true;

  const segments = normalized.split('/');
  const allExclusions = new Set(
    [...globalExclusions, ...projectExclusions].map((s) => s.toLowerCase().trim()).filter(Boolean)
  );

  for (const seg of segments) {
    const lowerSeg = seg.toLowerCase();
    // Always exclude .git directory and any dot-prefixed hidden directories/files (including .env*)
    if (lowerSeg === '.git' || lowerSeg.startsWith('.env') || lowerSeg.startsWith('.')) {
      return true;
    }
    if (allExclusions.has(lowerSeg)) {
      return true;
    }
  }

  const fileName = segments[segments.length - 1].toLowerCase();
  if (
    fileName.endsWith('.tmp') ||
    fileName.endsWith('.temp') ||
    fileName.endsWith('.log') ||
    fileName.endsWith('.swp') ||
    fileName.endsWith('.bak') ||
    fileName.endsWith('~') ||
    fileName.endsWith('.sqlite') ||
    fileName.endsWith('.sqlite-wal') ||
    fileName.endsWith('.sqlite-shm') ||
    fileName === 'package-lock.json' ||
    fileName === 'yarn.lock' ||
    fileName === 'pnpm-lock.yaml'
  ) {
    return true;
  }

  return false;
}

export class GitFileWatcherService {
  private watchers = new Map<string, fs.FSWatcher>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private pendingFiles = new Map<string, Set<string>>();
  private isScanningGit = false;
  private cachedGitVersion: string | null = null;

  constructor(
    private readonly repo: MesaiRepository,
    private readonly matcher: MatcherService,
    private readonly debounceMs = 4000
  ) {}

  public async getGitVersion(): Promise<string | null> {
    if (this.cachedGitVersion) return this.cachedGitVersion;
    try {
      const out = await this.execGit(process.cwd(), ['--version']);
      this.cachedGitVersion = out.trim();
      return this.cachedGitVersion;
    } catch {
      return null;
    }
  }

  /**
   * Scans the given root directory (up to 2 levels deep) for Git repositories (.git folder/file)
   * without modifying any files in those repositories.
   */
  public async discoverGitProjects(rootPath: string, startWatchers = true): Promise<Project[]> {
    if (!rootPath || !fs.existsSync(rootPath)) {
      return this.repo.listProjects();
    }

    const gitDirs = this.findGitRepoPaths(rootPath, 1);
    for (const repoPath of gitDirs) {
      const name = path.basename(repoPath);
      let remoteUrl: string | null = null;
      let branch: string | null = null;

      try {
        remoteUrl =
          (await this.execGit(repoPath, ['config', '--get', 'remote.origin.url'])).trim() || null;
      } catch {
        remoteUrl = null;
      }
      try {
        branch =
          (await this.execGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || null;
      } catch {
        branch = null;
      }

      this.repo.upsertDiscoveredProject({
        name,
        rootPath: repoPath,
        repositoryUrl: remoteUrl,
        currentBranch: branch
      });
    }

    if (startWatchers) {
      this.refreshFileWatchers();
    }
    return this.repo.listProjects();
  }

  private findGitRepoPaths(dirPath: string, maxDepth: number): string[] {
    const found: string[] = [];
    if (maxDepth < 0) return found;

    try {
      const gitMarker = path.join(dirPath, '.git');
      if (fs.existsSync(gitMarker)) {
        found.push(dirPath);
        return found;
      }

      if (maxDepth === 0) return found;

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const sub = path.join(dirPath, entry.name);
        found.push(...this.findGitRepoPaths(sub, maxDepth - 1));
      }
    } catch {
      // ignore permission errors
    }

    return found;
  }

  public refreshFileWatchers(): void {
    const settings = this.repo.getSettings();
    if (settings.trackingPaused) {
      this.stopAllWatchers();
      return;
    }

    const projects = this.repo.listProjects();
    const enabledIds = new Set(projects.filter((p) => p.enabled).map((p) => p.id));

    for (const [projId, watcher] of this.watchers.entries()) {
      if (!enabledIds.has(projId)) {
        watcher.close();
        this.watchers.delete(projId);
      }
    }

    for (const proj of projects) {
      if (!proj.enabled || this.watchers.has(proj.id)) continue;
      if (!fs.existsSync(proj.rootPath)) continue;

      try {
        const watcher = fs.watch(
          proj.rootPath,
          { recursive: true },
          (_eventType, filename) => {
            if (!filename) return;
            this.handleRawFileEvent(proj, filename, true);
          }
        );
        watcher.on('error', () => {
          // prevent unhandled error events on Windows directory locks
        });
        this.watchers.set(proj.id, watcher);
      } catch {
        // ignore if recursive watch fails on a path
      }
    }
  }

  /**
   * Handles a file change event with protective filters and debouncing.
   * When invoked from live fs.watch (verifyStat=true), ignores directories and files
   * whose mtime wasn't actually modified within the last 2 minutes.
   */
  public handleRawFileEvent(
    project: Project,
    relativeFilePath: string,
    verifyStat = false
  ): void {
    const settings = this.repo.getSettings();
    if (settings.trackingPaused) return;

    if (shouldExcludeFilePath(relativeFilePath, settings.globalExclusions, project.excludedPaths)) {
      return;
    }

    if (verifyStat) {
      try {
        const fullPath = path.join(project.rootPath, relativeFilePath);
        if (!fs.existsSync(fullPath)) return;
        const stat = fs.statSync(fullPath);
        // Never record directory-level events (e.g. "public", "src", "src/bam-shared-lib")
        if (!stat.isFile()) return;
        // Only record if the file was genuinely modified in the last 2 minutes
        if (Date.now() - stat.mtimeMs > 120_000) return;
      } catch {
        return;
      }
    }

    const normalized = relativeFilePath.replace(/\\/g, '/');
    let set = this.pendingFiles.get(project.id);
    if (!set) {
      set = new Set<string>();
      this.pendingFiles.set(project.id, set);
    }
    set.add(normalized);

    const existingTimer = this.debounceTimers.get(project.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.flushDebouncedFileChanges(project);
    }, this.debounceMs);
    this.debounceTimers.set(project.id, timer);
  }

  public flushDebouncedFileChanges(project: Project): string | null {
    const timer = this.debounceTimers.get(project.id);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(project.id);
    }

    const filesSet = this.pendingFiles.get(project.id);
    if (!filesSet || filesSet.size === 0) return null;

    const changedFiles = Array.from(filesSet).sort();
    this.pendingFiles.delete(project.id);

    const now = new Date();
    const nowLocalIso = toLocalIsoString(now);
    const fiveMinBucket = nowLocalIso.slice(0, 15);
    const filesSig = sha256Hex(changedFiles.join(',')).slice(0, 12);
    const dedupKey = `file:${project.id}:${fiveMinBucket}:${filesSig}`;

    const previewFiles = changedFiles.slice(0, 5).join(', ');
    const moreSuffix = changedFiles.length > 5 ? ` (+${changedFiles.length - 5} dosya daha)` : '';

    const res = this.repo.ingestGitOrFileActivity({
      projectId: project.id,
      projectName: project.name,
      sourceType: 'file_change',
      dedupKey,
      branchName: project.currentBranch ?? null,
      occurredAtIso: nowLocalIso,
      rawTimestampText: nowLocalIso.slice(11, 16),
      title: `${project.name} — Dosya Değişikliği (${changedFiles.length} dosya)`,
      summary: `Üzerinde çalışılan dosyalar: ${previewFiles}${moreSuffix}.`,
      changedFiles,
      statusOverride: 'in_progress',
      categoryOverride: 'development'
    });

    if (res.created && res.activityId) {
      this.matcher.matchActivityById(res.activityId);
    }
    return res.activityId;
  }

  /**
   * Reads Git commits, active branch, and uncommitted working tree status
   * across all enabled projects using read-only git CLI commands.
   */
  public async pollAllProjectsGit(): Promise<{
    ok: boolean;
    scannedProjects: number;
    newActivities: number;
    error?: string | null;
  }> {
    if (this.isScanningGit) {
      return { ok: true, scannedProjects: 0, newActivities: 0 };
    }

    this.isScanningGit = true;
    const attemptAt = toLocalIsoString(new Date());
    let scannedProjects = 0;
    let newActivities = 0;

    try {
      const projects = this.repo.listProjects().filter((p) => p.enabled);
      const settings = this.repo.getSettings();

      for (const proj of projects) {
        if (!fs.existsSync(proj.rootPath)) continue;
        scannedProjects++;

        // 1. Read active branch
        let branch = proj.currentBranch ?? 'main';
        try {
          branch =
            (await this.execGit(proj.rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() ||
            branch;
          this.repo.upsertDiscoveredProject({
            name: proj.name,
            rootPath: proj.rootPath,
            currentBranch: branch
          });
        } catch {
          // ignore if empty repo without HEAD
        }

        // 2. Read recent commits (last 14 days so earlier report dates are also populated)
        try {
          let gitUserName = '';
          let gitUserEmail = '';
          try {
            gitUserName = (await this.execGit(proj.rootPath, ['config', 'user.name']))
              .trim()
              .toLowerCase();
          } catch {
            // ignore
          }
          try {
            gitUserEmail = (await this.execGit(proj.rootPath, ['config', 'user.email']))
              .trim()
              .toLowerCase();
          } catch {
            // ignore
          }
          let osUser = '';
          try {
            osUser = os.userInfo().username.trim().toLowerCase();
          } catch {
            // ignore
          }

          const logOut = await this.execGit(proj.rootPath, [
            'log',
            '--since=14.days.ago',
            '-n',
            '50',
            '-m',
            '--first-parent',
            '--name-only',
            '--pretty=format:__COMMIT__|%H|%an|%ae|%aI|%s'
          ]);

          interface ParsedCommit {
            hash: string;
            author: string;
            email: string;
            rawIsoDate: string;
            subject: string;
            changedFiles: string[];
          }

          const parsedCommits: ParsedCommit[] = [];
          let currentCommit: ParsedCommit | null = null;

          for (const rawLine of logOut.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line) continue;
            if (line.startsWith('__COMMIT__|')) {
              if (currentCommit) {
                parsedCommits.push(currentCommit);
              }
              const parts = line.slice('__COMMIT__|'.length).split('|');
              if (parts.length < 5) {
                currentCommit = null;
                continue;
              }
              const [hash, author, email, rawIsoDate, ...subjectParts] = parts;
              currentCommit = {
                hash,
                author: author.trim(),
                email: email.trim(),
                rawIsoDate: rawIsoDate.trim(),
                subject: subjectParts.join('|').trim(),
                changedFiles: []
              };
            } else if (currentCommit) {
              const normalizedFile = line.replace(/\\/g, '/');
              if (
                normalizedFile.includes('bam-shared-lib') ||
                !shouldExcludeFilePath(normalizedFile, settings.globalExclusions, proj.excludedPaths)
              ) {
                currentCommit.changedFiles.push(normalizedFile);
              }
            }
          }
          if (currentCommit) {
            parsedCommits.push(currentCommit);
          }

          const userTokens = Array.from(
            new Set(
              [
                gitUserName,
                ...gitUserName.split(/\s+/),
                gitUserEmail.split('@')[0] ?? '',
                osUser
              ]
                .map((t) => t.trim().toLowerCase())
                .filter((t) => t.length >= 3)
            )
          );

          for (const c of parsedCommits) {
            // Skip upstream sync pulls ("Merge remote-tracking branch 'origin/uat' into ...")
            if (/^merge\s+remote-tracking\s+branch/i.test(c.subject)) {
              continue;
            }

            const lowerAuthor = c.author.toLowerCase();
            const lowerEmail = c.email.toLowerCase();
            const lowerSubj = c.subject.toLowerCase();

            const isOwnCommit =
              userTokens.length === 0 ||
              userTokens.some(
                (tok) =>
                  lowerAuthor.includes(tok) ||
                  lowerEmail.includes(tok) ||
                  lowerSubj.includes(`'${tok}'`) ||
                  lowerSubj.includes(`/${tok}`)
              );

            if (!isOwnCommit) {
              continue;
            }

            const shortHash = c.hash.slice(0, 8);
            const localCommitIso = toLocalIsoString(c.rawIsoDate);
            const dedupKey = `git:commit:${proj.id}:${c.hash}`;
            const codeDiff = await this.extractCompactCommitDiff(proj.rootPath, c.hash);

            const res = this.repo.ingestGitOrFileActivity({
              projectId: proj.id,
              projectName: proj.name,
              sourceType: 'git_commit',
              dedupKey,
              externalId: shortHash,
              branchName: branch,
              sender: c.author,
              occurredAtIso: localCommitIso,
              rawTimestampText: localCommitIso.slice(11, 16),
              title: `${proj.name} [${branch}] — Commit ${shortHash}`,
              summary: c.subject,
              changedFiles: c.changedFiles,
              codeDiff,
              statusOverride: 'completed',
              categoryOverride: 'development'
            });

            if (res.created) {
              newActivities++;
              this.matcher.matchActivityById(res.activityId);
            }
          }
        } catch {
          // ignore if repo has no commits yet
        }

        // 3. Read uncommitted working tree changes grouped by actual file modification date (mtime)
        try {
          const statusOut = await this.execGit(proj.rootPath, [
            'status',
            '--porcelain',
            '--untracked-files=normal'
          ]);
          const statusLines = statusOut.split(/\r?\n/).filter(Boolean);

          // Group dirty files by their actual modification date (YYYY-MM-DD in local timezone)
          const filesByDate = new Map<
            string,
            { files: string[]; latestIso: string; latestTimeText: string }
          >();
          const cutoffMs = Date.now() - 14 * 86_400_000;

          for (const sl of statusLines) {
            const rawFile = sl.slice(3).trim().replace(/^"|"$/g, '');
            if (shouldExcludeFilePath(rawFile, settings.globalExclusions, proj.excludedPaths)) {
              continue;
            }

            const fullPath = path.join(proj.rootPath, rawFile);
            try {
              if (!fs.existsSync(fullPath)) continue;
              const stat = fs.statSync(fullPath);
              // Ignore directories / git submodules
              if (!stat.isFile()) continue;
              // Ignore untouched dirty files older than 14 days
              if (stat.mtimeMs < cutoffMs) continue;

              const fileLocalIso = toLocalIsoString(stat.mtime);
              const fileDate = fileLocalIso.slice(0, 10);
              const existingGroup = filesByDate.get(fileDate);
              if (!existingGroup) {
                filesByDate.set(fileDate, {
                  files: [rawFile],
                  latestIso: fileLocalIso,
                  latestTimeText: fileLocalIso.slice(11, 16)
                });
              } else {
                existingGroup.files.push(rawFile);
                if (fileLocalIso > existingGroup.latestIso) {
                  existingGroup.latestIso = fileLocalIso;
                  existingGroup.latestTimeText = fileLocalIso.slice(11, 16);
                }
              }
            } catch {
              // ignore stat error on deleted/locked file
            }
          }

          for (const [fileDate, group] of filesByDate.entries()) {
            const sortedFiles = group.files.sort();
            const dirtySig = sha256Hex(`${branch}|${sortedFiles.join(',')}`).slice(0, 14);
            const dedupKey = `git:wt:${proj.id}:${fileDate}:${dirtySig}`;
            const preview = sortedFiles.slice(0, 6).join(', ');
            const suffix = sortedFiles.length > 6 ? ` (+${sortedFiles.length - 6} dosya)` : '';

            const res = this.repo.ingestGitOrFileActivity({
              projectId: proj.id,
              projectName: proj.name,
              sourceType: 'git_working_tree',
              dedupKey,
              externalId: branch,
              branchName: branch,
              occurredAtIso: group.latestIso,
              rawTimestampText: group.latestTimeText,
              title: `${proj.name} [${branch}] — Çalışma Ağacı (${sortedFiles.length} dosya)`,
              summary: `Değişen/eklenen dosyalar: ${preview}${suffix}.`,
              changedFiles: sortedFiles,
              statusOverride: 'in_progress',
              categoryOverride: 'development'
            });

            if (res.created) {
              newActivities++;
              this.matcher.matchActivityById(res.activityId);
            }
          }
        } catch {
          // ignore git status failure
        }
      }

      const prevSync = this.repo.getSyncState('git_watcher');
      this.repo.updateSyncState({
        connector: 'git_watcher',
        status: 'ok',
        lastAttemptAt: attemptAt,
        lastSuccessAt: attemptAt,
        lastError: null,
        recordsCount: (prevSync?.recordsCount ?? 0) + newActivities,
        metadata: {
          scannedProjects,
          lastNewActivities: newActivities
        }
      });

      return { ok: true, scannedProjects, newActivities, error: null };
    } catch (err) {
      const errMsg = (err as Error).message;
      this.repo.updateSyncState({
        connector: 'git_watcher',
        status: 'error',
        lastAttemptAt: attemptAt,
        lastError: errMsg
      });
      return { ok: false, scannedProjects, newActivities, error: errMsg };
    } finally {
      this.isScanningGit = false;
    }
  }

  private async extractCompactCommitDiff(
    repoPath: string,
    commitHash: string
  ): Promise<string | null> {
    try {
      const rawPatch = await this.execGit(repoPath, [
        'show',
        '-m',
        '--first-parent',
        '-U1',
        '--no-color',
        '--format=',
        commitHash
      ]);
      if (!rawPatch || !rawPatch.trim()) return null;

      const sections: string[] = [];
      const mainCompact = this.compactRawGitPatch(rawPatch, 2400);
      if (mainCompact) {
        sections.push(mainCompact);
      }

      // Check if src/bam-shared-lib submodule commit pointer changed in this commit
      const subMatch = rawPatch.match(
        /-Subproject commit ([0-9a-f]{7,40})\r?\n\+Subproject commit ([0-9a-f]{7,40})/i
      );
      if (subMatch) {
        const [, oldSub, newSub] = subMatch;
        const subDir = path.join(repoPath, 'src', 'bam-shared-lib');
        if (fs.existsSync(subDir)) {
          try {
            const subLog = await this.execGit(subDir, [
              'log',
              '--oneline',
              '-n',
              '6',
              `${oldSub}..${newSub}`
            ]);
            const subStat = await this.execGit(subDir, [
              'diff',
              '--stat',
              '--no-color',
              `${oldSub}..${newSub}`
            ]);
            const subPatch = await this.execGit(subDir, [
              'diff',
              '-U1',
              '--no-color',
              `${oldSub}..${newSub}`
            ]);
            const compactSubPatch = this.compactRawGitPatch(subPatch, 1000);
            const subParts = [
              `[SUBMODULE: src/bam-shared-lib (${oldSub.slice(0, 7)}..${newSub.slice(0, 7)})]`,
              subLog.trim() ? `Submodule Commits:\n${subLog.trim()}` : '',
              subStat.trim() ? `Submodule Files:\n${subStat.trim()}` : '',
              compactSubPatch
            ].filter(Boolean);
            sections.push(subParts.join('\n'));
          } catch {
            sections.push(
              `[SUBMODULE: src/bam-shared-lib updated ${oldSub.slice(0, 7)}..${newSub.slice(0, 7)}]`
            );
          }
        }
      }

      const combined = sections.join('\n\n').trim();
      return combined ? combined.slice(0, 3400) : null;
    } catch {
      return null;
    }
  }

  private compactRawGitPatch(rawPatch: string, maxLen: number): string {
    const outLines: string[] = [];
    let currentLength = 0;

    for (const rawLine of rawPatch.split(/\r?\n/)) {
      if (currentLength >= maxLen) break;

      if (rawLine.startsWith('diff --git ')) {
        const m = rawLine.match(/ b\/(.+)$/);
        const fileLine = `FILE: ${m ? m[1] : rawLine.slice(11)}`;
        outLines.push(fileLine);
        currentLength += fileLine.length + 1;
        continue;
      }

      if (
        rawLine.startsWith('index ') ||
        rawLine.startsWith('--- ') ||
        rawLine.startsWith('+++ ') ||
        rawLine.startsWith('new file mode') ||
        rawLine.startsWith('deleted file mode')
      ) {
        continue;
      }

      if (rawLine.startsWith('@@')) {
        const ctxMatch = rawLine.match(/@@[^@]+@@\s*(.*)$/);
        if (ctxMatch && ctxMatch[1].trim()) {
          const fnHeader = `  @ ${ctxMatch[1].trim()}`;
          outLines.push(fnHeader);
          currentLength += fnHeader.length + 1;
        }
        continue;
      }

      if (rawLine.startsWith('+') || rawLine.startsWith('-')) {
        const trimmedCode = rawLine.slice(1).trim();
        // Skip empty or brace-only diff lines to preserve token budget for meaningful logic
        if (!trimmedCode || /^[{}()[\];,]+$/.test(trimmedCode)) continue;
        const compactLine = `${rawLine[0]} ${trimmedCode.slice(0, 140)}`;
        outLines.push(compactLine);
        currentLength += compactLine.length + 1;
      }
    }

    return outLines.join('\n').slice(0, maxLen);
  }

  private execGit(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        {
          cwd,
          timeout: 3500,
          maxBuffer: 5 * 1024 * 1024,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message));
            return;
          }
          resolve(stdout);
        }
      );
    });
  }

  public stopAllWatchers(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.pendingFiles.clear();

    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    this.watchers.clear();
  }
}
