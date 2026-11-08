import { app, shell, type BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoUpdater, type UpdateInfo as ElectronUpdateInfo, type ProgressInfo } from 'electron-updater';
import type { UpdateInfo, UpdateProgress, UpdateState } from '../../shared/types';

const GITHUB_OWNER = 'rifkikesepara';
const GITHUB_REPO = 'MesAI';
const GITHUB_RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASES_LATEST_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASES_PAGE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;

export function parseSemver(versionStr: string): [number, number, number] {
  const cleaned = versionStr.replace(/^v/i, '').trim();
  const parts = cleaned.split('-')[0].split('.').map((p) => parseInt(p, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

export function isNewerVersion(remoteVersion: string, currentVersion: string): boolean {
  const [rMaj, rMin, rPat] = parseSemver(remoteVersion);
  const [cMaj, cMin, cPat] = parseSemver(currentVersion);

  if (rMaj > cMaj) return true;
  if (rMaj < cMaj) return false;
  if (rMin > cMin) return true;
  if (rMin < cMin) return false;
  return rPat > cPat;
}

function resolveAppVersion(): string {
  const candidates = [
    path.resolve(__dirname, '../../../../package.json'),
    path.resolve(__dirname, '../../../package.json'),
    path.resolve(process.cwd(), 'package.json')
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { name?: string; version?: string };
        if (pkg.version && (!pkg.name || pkg.name.toLowerCase() === 'mesai')) {
          return pkg.version;
        }
      }
    } catch {
      // continue
    }
  }
  try {
    if (app && typeof app.getVersion === 'function') {
      const v = app.getVersion();
      if (v) return v;
    }
  } catch {
    // ignore
  }
  return '0.0.0';
}

export class UpdateService {
  private state: UpdateState;
  private isChecking = false;
  private isDownloading = false;
  private usedNativeUpdater = false;
  private downloadedInstallerPath: string | null = null;

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {
    const currentVersion = resolveAppVersion();

    this.state = {
      status: 'idle',
      currentVersion,
      updateInfo: null,
      progress: null,
      errorMessage: null,
      lastCheckedAt: null
    };

    this.initAutoUpdater();
  }

  private isPortableBuild(): boolean {
    return Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);
  }

  private buildDefaultDownloadUrl(version: string): string {
    const cleanVer = version.replace(/^v/i, '').trim();
    const fileName = this.isPortableBuild()
      ? `MesAI-${cleanVer}-Portable.exe`
      : `MesAI-Setup-${cleanVer}.exe`;
    return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${cleanVer}/${fileName}`;
  }

  private initAutoUpdater(): void {
    try {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.allowDowngrade = false;
      autoUpdater.disableWebInstaller = true;

      autoUpdater.on('checking-for-update', () => {
        this.updateState({
          status: 'checking',
          errorMessage: null
        });
      });

      autoUpdater.on('update-available', (info: ElectronUpdateInfo) => {
        this.usedNativeUpdater = true;
        const releaseNotesText = Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n) => (typeof n === 'string' ? n : n.note)).join('\n')
          : typeof info.releaseNotes === 'string'
            ? info.releaseNotes
            : undefined;
        const cleanVersion = (info.version || '').replace(/^v/i, '');

        this.updateState({
          status: 'available',
          updateInfo: {
            version: cleanVersion,
            releaseDate: info.releaseDate,
            releaseNotes: releaseNotesText,
            releaseName: info.releaseName ?? `v${cleanVersion}`,
            downloadUrl: this.buildDefaultDownloadUrl(cleanVersion)
          },
          errorMessage: null,
          lastCheckedAt: new Date().toISOString()
        });
      });

      autoUpdater.on('update-not-available', (info: ElectronUpdateInfo) => {
        this.usedNativeUpdater = true;
        this.updateState({
          status: 'not_available',
          updateInfo: {
            version: (info.version || this.state.currentVersion).replace(/^v/i, '')
          },
          errorMessage: null,
          lastCheckedAt: new Date().toISOString()
        });
      });

      autoUpdater.on('download-progress', (progressObj: ProgressInfo) => {
        const progress: UpdateProgress = {
          percent: Math.round(progressObj.percent * 10) / 10,
          transferredBytes: progressObj.transferred,
          totalBytes: progressObj.total,
          bytesPerSecond: progressObj.bytesPerSecond
        };

        this.updateState({
          status: 'downloading',
          progress,
          errorMessage: null
        });
      });

      autoUpdater.on('update-downloaded', (info: ElectronUpdateInfo) => {
        this.isDownloading = false;
        const cleanVersion = (info.version || this.state.updateInfo?.version || '').replace(/^v/i, '');
        this.updateState({
          status: 'downloaded',
          updateInfo: {
            ...this.state.updateInfo,
            version: cleanVersion,
            releaseDate: info.releaseDate ?? this.state.updateInfo?.releaseDate,
            releaseName: info.releaseName ?? this.state.updateInfo?.releaseName
          },
          errorMessage: null
        });
      });

      autoUpdater.on('error', (err: Error) => {
        // Ignore intermediate electron-updater errors while checkForUpdates or downloadUpdate
        // is actively running, because both have automatic GitHub HTTP fallbacks.
        if (this.isChecking || this.isDownloading) {
          return;
        }
        this.updateState({
          status: 'error',
          errorMessage: err.message || 'Güncelleme hatası oluştu.',
          lastCheckedAt: new Date().toISOString()
        });
      });
    } catch {
      // In headless or test environments where autoUpdater is unconfigured
    }
  }

  public getState(): UpdateState {
    return { ...this.state };
  }

  private updateState(partial: Partial<UpdateState>): void {
    this.state = {
      ...this.state,
      ...partial
    };

    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('mesai:updater:stateChanged', this.getState());
    }
  }

  /**
   * Checks for updates.
   * Tries electron-updater first when running as an installed NSIS package,
   * and seamlessly falls back to GitHub Releases HTTP check if unavailable or failing.
   */
  public async checkForUpdates(): Promise<UpdateState> {
    if (this.isChecking) return this.getState();
    this.isChecking = true;
    this.usedNativeUpdater = false;

    this.updateState({
      status: 'checking',
      errorMessage: null
    });

    try {
      const canUseNative = Boolean(app && app.isPackaged && !this.isPortableBuild());
      if (canUseNative) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            autoUpdater.checkForUpdates(),
            new Promise<null>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Updater timeout')), 10_000);
              timer.unref?.();
            })
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }

      // If native updater did not resolve to available / not_available, use GitHub Releases HTTP check
      if (this.state.status !== 'available' && this.state.status !== 'not_available') {
        await this.checkViaGitHubApi();
      }
    } catch (err) {
      try {
        await this.checkViaGitHubApi();
      } catch (apiErr) {
        this.updateState({
          status: 'error',
          errorMessage:
            (apiErr as Error).message ||
            (err as Error).message ||
            'GitHub Releases servisine ulaşılamadı.',
          lastCheckedAt: new Date().toISOString()
        });
      }
    } finally {
      this.isChecking = false;
    }

    return this.getState();
  }

  private applyResolvedRelease(params: {
    remoteTag: string;
    releaseName?: string;
    releaseNotes?: string;
    releaseDate?: string;
    downloadUrl?: string;
  }): void {
    const cleanRemoteVersion = params.remoteTag.replace(/^v/i, '').trim();
    const currentVersion = this.state.currentVersion;

    if (cleanRemoteVersion && isNewerVersion(cleanRemoteVersion, currentVersion)) {
      this.updateState({
        status: 'available',
        updateInfo: {
          version: cleanRemoteVersion,
          releaseDate: params.releaseDate,
          releaseNotes: params.releaseNotes,
          releaseName: params.releaseName || `v${cleanRemoteVersion}`,
          downloadUrl: params.downloadUrl || this.buildDefaultDownloadUrl(cleanRemoteVersion)
        },
        errorMessage: null,
        lastCheckedAt: new Date().toISOString()
      });
    } else {
      this.updateState({
        status: 'not_available',
        updateInfo: {
          version: cleanRemoteVersion || currentVersion
        },
        errorMessage: null,
        lastCheckedAt: new Date().toISOString()
      });
    }
  }

  private async checkViaGitHubApi(): Promise<void> {
    try {
      const res = await fetch(GITHUB_RELEASES_API_URL, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'MesAI-Desktop-App'
        },
        signal: AbortSignal.timeout(8_000)
      });

      if (res.status === 404) {
        this.updateState({
          status: 'not_available',
          updateInfo: { version: this.state.currentVersion },
          errorMessage: null,
          lastCheckedAt: new Date().toISOString()
        });
        return;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = (await res.json()) as {
        tag_name: string;
        name?: string;
        body?: string;
        published_at?: string;
        html_url?: string;
        assets?: Array<{ browser_download_url: string; name: string }>;
      };

      const remoteTag = data.tag_name || '';
      const isPortable = this.isPortableBuild();
      const preferredAsset =
        data.assets?.find((a) =>
          isPortable
            ? a.name.toLowerCase().includes('portable') && a.name.endsWith('.exe')
            : a.name.toLowerCase().includes('setup') && a.name.endsWith('.exe')
        ) ?? data.assets?.find((a) => a.name.endsWith('.exe'));

      this.applyResolvedRelease({
        remoteTag,
        releaseName: data.name || remoteTag,
        releaseNotes: data.body ?? undefined,
        releaseDate: data.published_at,
        downloadUrl: preferredAsset?.browser_download_url || data.html_url
      });
      return;
    } catch {
      // Fallback to github.com web endpoints (not subject to 60 req/hr api.github.com rate limit)
      await this.checkViaGitHubWebFallback();
    }
  }

  private async checkViaGitHubWebFallback(): Promise<void> {
    const res = await fetch(GITHUB_RELEASES_LATEST_URL, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'MesAI-Desktop-App'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8_000)
    });

    if (res.status === 404) {
      this.updateState({
        status: 'not_available',
        updateInfo: { version: this.state.currentVersion },
        errorMessage: null,
        lastCheckedAt: new Date().toISOString()
      });
      return;
    }

    if (!res.ok) {
      throw new Error(`GitHub Releases sorgusu başarısız (HTTP ${res.status}): ${res.statusText}`);
    }

    let remoteTag = '';
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const json = (await res.json()) as { tag_name?: string };
      remoteTag = json.tag_name || '';
    } else {
      const finalUrl = res.url || '';
      const tagMatch = finalUrl.match(/\/releases\/tag\/([^/?#]+)/i);
      if (tagMatch?.[1]) {
        remoteTag = decodeURIComponent(tagMatch[1]);
      }
    }

    if (!remoteTag) {
      throw new Error('GitHub Releases üzerinden son sürüm etiketi okunamadı.');
    }

    const cleanVer = remoteTag.replace(/^v/i, '').trim();
    let releaseDate: string | undefined;
    let downloadUrl = this.buildDefaultDownloadUrl(cleanVer);

    // Enrich from latest.yml if available
    try {
      const ymlUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${remoteTag}/latest.yml`;
      const ymlRes = await fetch(ymlUrl, {
        headers: { 'User-Agent': 'MesAI-Desktop-App' },
        signal: AbortSignal.timeout(5_000)
      });
      if (ymlRes.ok) {
        const ymlText = await ymlRes.text();
        const dateMatch = ymlText.match(/releaseDate:\s*['"]?([^\r\n'"]+)['"]?/i);
        if (dateMatch?.[1]) {
          releaseDate = dateMatch[1].trim();
        }
        if (!this.isPortableBuild()) {
          const pathMatch = ymlText.match(/^path:\s*([^\r\n]+)$/m);
          if (pathMatch?.[1]) {
            const assetName = pathMatch[1].trim().replace(/^['"]|['"]$/g, '');
            downloadUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${remoteTag}/${assetName}`;
          }
        }
      }
    } catch {
      // non-blocking
    }

    this.applyResolvedRelease({
      remoteTag,
      releaseName: `v${cleanVer}`,
      releaseDate,
      downloadUrl
    });
  }

  public async downloadUpdate(): Promise<void> {
    if (this.isDownloading) return;

    if (!this.state.updateInfo) {
      await this.checkForUpdates();
    }
    const updateInfo: UpdateInfo | null = this.state.updateInfo;
    if (!updateInfo) {
      this.updateState({
        status: 'error',
        errorMessage: 'İndirilecek yeni sürüm bilgisi bulunamadı.'
      });
      return;
    }

    this.isDownloading = true;
    this.downloadedInstallerPath = null;

    this.updateState({
      status: 'downloading',
      progress: {
        percent: 0,
        transferredBytes: 0,
        totalBytes: 0,
        bytesPerSecond: 0
      },
      errorMessage: null
    });

    try {
      const canUseNativeDownload = Boolean(
        app && app.isPackaged && !this.isPortableBuild() && this.usedNativeUpdater
      );

      if (canUseNativeDownload) {
        try {
          await autoUpdater.downloadUpdate();
          return;
        } catch {
          // Fall back to direct GitHub asset download below
        }
      }

      const targetUrl =
        updateInfo.downloadUrl || this.buildDefaultDownloadUrl(updateInfo.version);

      // If targetUrl is a web HTML page rather than a binary, open in browser
      if (!targetUrl.toLowerCase().endsWith('.exe')) {
        await shell.openExternal(targetUrl);
        this.isDownloading = false;
        this.updateState({
          status: 'available',
          progress: null,
          errorMessage: null
        });
        return;
      }

      await this.downloadDirectFromGitHub(targetUrl, updateInfo.version);
    } catch (err) {
      this.isDownloading = false;
      const fallbackUrl =
        updateInfo.downloadUrl ||
        this.buildDefaultDownloadUrl(updateInfo.version) ||
        GITHUB_RELEASES_PAGE_URL;
      try {
        await shell.openExternal(fallbackUrl);
      } catch {
        // ignore
      }
      this.updateState({
        status: 'error',
        errorMessage: `Uygulama içi indirme tamamlanamadı (${(err as Error).message}). İndirme bağlantısı varsayılan tarayıcınızda açıldı.`
      });
    }
  }

  private async downloadDirectFromGitHub(downloadUrl: string, version: string): Promise<void> {
    const res = await fetch(downloadUrl, {
      headers: { 'User-Agent': 'MesAI-Desktop-App' },
      redirect: 'follow'
    });

    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const cleanVer = version.replace(/^v/i, '').trim() || 'latest';
    const fileName = this.isPortableBuild()
      ? `MesAI-${cleanVer}-Portable.exe`
      : `MesAI-Setup-${cleanVer}.exe`;
    const tempDir = app && typeof app.getPath === 'function' ? app.getPath('temp') : os.tmpdir();
    const destPath = path.join(tempDir, fileName);

    const totalBytes = Number(res.headers.get('content-length') || 0);
    let transferredBytes = 0;
    const startedAt = Date.now();
    let lastEmitAt = 0;

    const fileStream = fs.createWriteStream(destPath);
    const reader = res.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          transferredBytes += value.byteLength;
          if (!fileStream.write(Buffer.from(value))) {
            await new Promise<void>((resolve) => fileStream.once('drain', resolve));
          }

          const now = Date.now();
          if (now - lastEmitAt >= 120) {
            lastEmitAt = now;
            const elapsedSec = Math.max(0.1, (now - startedAt) / 1000);
            const bytesPerSecond = Math.round(transferredBytes / elapsedSec);
            const percent =
              totalBytes > 0
                ? Math.min(99.9, Math.round((transferredBytes / totalBytes) * 1000) / 10)
                : 0;
            this.updateState({
              status: 'downloading',
              progress: {
                percent,
                transferredBytes,
                totalBytes,
                bytesPerSecond
              },
              errorMessage: null
            });
          }
        }
      }

      await new Promise<void>((resolve, reject) => {
        fileStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      fileStream.destroy();
      try {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      } catch {
        // ignore
      }
      throw err;
    }

    this.downloadedInstallerPath = destPath;
    this.isDownloading = false;
    this.updateState({
      status: 'downloaded',
      progress: {
        percent: 100,
        transferredBytes,
        totalBytes: totalBytes || transferredBytes,
        bytesPerSecond: 0
      },
      errorMessage: null
    });
  }

  public async quitAndInstall(): Promise<void> {
    if (this.downloadedInstallerPath && fs.existsSync(this.downloadedInstallerPath)) {
      try {
        const child = spawn(this.downloadedInstallerPath, ['--updated'], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        if (app && typeof app.quit === 'function') {
          setTimeout(() => app.quit(), 300);
        }
        return;
      } catch {
        await shell.openPath(this.downloadedInstallerPath);
        if (app && typeof app.quit === 'function') {
          setTimeout(() => app.quit(), 300);
        }
        return;
      }
    }

    if (app && app.isPackaged && !this.isPortableBuild() && this.usedNativeUpdater) {
      autoUpdater.quitAndInstall(false, true);
      return;
    }

    if (this.state.updateInfo?.downloadUrl) {
      await shell.openExternal(this.state.updateInfo.downloadUrl);
    } else {
      await shell.openExternal(GITHUB_RELEASES_PAGE_URL);
    }
  }
}
