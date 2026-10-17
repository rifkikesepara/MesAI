import { app, type BrowserWindow } from 'electron';
import { autoUpdater, type UpdateInfo as ElectronUpdateInfo, type ProgressInfo } from 'electron-updater';
import type { UpdateInfo, UpdateProgress, UpdateState } from '../../shared/types';

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

export class UpdateService {
  private state: UpdateState;
  private isChecking = false;
  private isDownloading = false;

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {
    let currentVersion = '0.0.0';
    try {
      if (app && typeof app.getVersion === 'function') {
        currentVersion = app.getVersion();
      } else {
        const pkg = require('../../../package.json');
        currentVersion = pkg.version || '0.0.0';
      }
    } catch {
      currentVersion = '0.0.0';
    }

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

  private initAutoUpdater(): void {
    try {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;

      autoUpdater.on('checking-for-update', () => {
        this.updateState({
          status: 'checking',
          errorMessage: null
        });
      });

      autoUpdater.on('update-available', (info: ElectronUpdateInfo) => {
        const releaseNotesText = Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n) => (typeof n === 'string' ? n : n.note)).join('\n')
          : typeof info.releaseNotes === 'string'
            ? info.releaseNotes
            : undefined;

        this.updateState({
          status: 'available',
          updateInfo: {
            version: info.version,
            releaseDate: info.releaseDate,
            releaseNotes: releaseNotesText,
            releaseName: info.releaseName ?? undefined
          },
          errorMessage: null,
          lastCheckedAt: new Date().toISOString()
        });
      });

      autoUpdater.on('update-not-available', (info: ElectronUpdateInfo) => {
        this.updateState({
          status: 'not_available',
          updateInfo: {
            version: info.version
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
        this.updateState({
          status: 'downloaded',
          updateInfo: {
            version: info.version,
            releaseDate: info.releaseDate,
            releaseName: info.releaseName ?? undefined
          },
          errorMessage: null
        });
      });

      autoUpdater.on('error', (err: Error) => {
        this.isChecking = false;
        this.isDownloading = false;
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
   * If running as a packaged app, delegates to electron-updater.
   * If running in development (unpackaged), checks GitHub Releases API directly.
   */
  public async checkForUpdates(): Promise<UpdateState> {
    if (this.isChecking) return this.getState();
    this.isChecking = true;

    this.updateState({
      status: 'checking',
      errorMessage: null
    });

    try {
      if (app && app.isPackaged) {
        await autoUpdater.checkForUpdates();
      } else {
        // Development / Unpackaged fallback using GitHub Releases API
        await this.checkViaGitHubApi();
      }
    } catch (err) {
      // If autoUpdater throws (e.g. dev mode or network), fallback to GitHub API
      try {
        await this.checkViaGitHubApi();
      } catch (apiErr) {
        this.updateState({
          status: 'error',
          errorMessage: (apiErr as Error).message || (err as Error).message,
          lastCheckedAt: new Date().toISOString()
        });
      }
    } finally {
      this.isChecking = false;
    }

    return this.getState();
  }

  private async checkViaGitHubApi(): Promise<void> {
    const url = 'https://api.github.com/repos/rifkikesepara/MesAI/releases/latest';
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'MesAI-Desktop-App'
      }
    });

    if (res.status === 404) {
      this.updateState({
        status: 'not_available',
        updateInfo: null,
        errorMessage: null,
        lastCheckedAt: new Date().toISOString()
      });
      return;
    }

    if (!res.ok) {
      throw new Error(`GitHub Releases sorgusu başarısız (HTTP ${res.status}): ${res.statusText}`);
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
    const currentVersion = this.state.currentVersion;

    if (isNewerVersion(remoteTag, currentVersion)) {
      const exeAsset = data.assets?.find((a) => a.name.endsWith('.exe'));
      this.updateState({
        status: 'available',
        updateInfo: {
          version: remoteTag.replace(/^v/i, ''),
          releaseDate: data.published_at,
          releaseNotes: data.body,
          releaseName: data.name || remoteTag,
          downloadUrl: exeAsset ? exeAsset.browser_download_url : data.html_url
        },
        errorMessage: null,
        lastCheckedAt: new Date().toISOString()
      });
    } else {
      this.updateState({
        status: 'not_available',
        updateInfo: {
          version: remoteTag.replace(/^v/i, '') || currentVersion
        },
        errorMessage: null,
        lastCheckedAt: new Date().toISOString()
      });
    }
  }

  public async downloadUpdate(): Promise<void> {
    if (this.isDownloading) return;
    this.isDownloading = true;

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
      if (app && app.isPackaged) {
        await autoUpdater.downloadUpdate();
      } else {
        // If dev mode, simulate download or open download URL in browser
        if (this.state.updateInfo?.downloadUrl) {
          const { shell } = await import('electron');
          await shell.openExternal(this.state.updateInfo.downloadUrl);
        }
        this.isDownloading = false;
        this.updateState({
          status: 'idle',
          errorMessage: 'Geliştirme modundasınız. En son sürüm tarayıcıda indiriliyor.'
        });
      }
    } catch (err) {
      this.isDownloading = false;
      this.updateState({
        status: 'error',
        errorMessage: `İndirme hatası: ${(err as Error).message}`
      });
    }
  }

  public async quitAndInstall(): Promise<void> {
    if (app && app.isPackaged) {
      autoUpdater.quitAndInstall(false, true);
    } else {
      this.updateState({
        status: 'idle',
        errorMessage: 'Geliştirme modunda otomatik yeniden başlatma uygulanamaz.'
      });
    }
  }
}
