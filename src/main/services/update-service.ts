import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UpdateInfo, UpdateProgress, UpdateState } from '../../shared/types';

const GITHUB_OWNER = 'rifkikesepara';
const GITHUB_REPO = 'MesAI';
const GITHUB_RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASES_LATEST_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASES_PAGE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;

export interface UpdateHost {
  emitStateChanged(state: UpdateState): void;
  openExternalUrl(url: string): Promise<void>;
  openPath(filePath: string): Promise<void>;
  getTempDir(): string;
  getAppVersion?(): string;
  isPackaged?(): boolean;
  quitApp?(): void;
  nativeCheck?(): Promise<{ available: boolean; version?: string; body?: string; date?: string } | null>;
  nativeDownloadAndInstall?(onProgress?: (progress: UpdateProgress) => void): Promise<boolean>;
}

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

function resolveAppVersion(host?: UpdateHost): string {
  const envVer = process.env.MESAI_APP_VERSION?.trim();
  if (envVer) return envVer;

  if (host?.getAppVersion) {
    const v = host.getAppVersion();
    if (v && v !== '0.0.0') return v;
  }

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
  return '0.0.0';
}

export class UpdateService {
  private state: UpdateState;
  private isChecking = false;
  private isDownloading = false;
  private usedNativeUpdater = false;
  private downloadedInstallerPath: string | null = null;
  private readonly host?: UpdateHost;

  constructor(hostOrLegacyFn?: UpdateHost | (() => unknown) | null) {
    this.host = typeof hostOrLegacyFn === 'function' ? undefined : (hostOrLegacyFn ?? undefined);
    const currentVersion = resolveAppVersion(this.host);

    this.state = {
      status: 'idle',
      currentVersion,
      updateInfo: null,
      progress: null,
      errorMessage: null,
      lastCheckedAt: null
    };
  }

  private buildDefaultDownloadUrl(version: string): string {
    const cleanVer = version.replace(/^v/i, '').trim();
    return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${cleanVer}/MesAI-Setup-${cleanVer}.exe`;
  }

  public getState(): UpdateState {
    return { ...this.state };
  }

  private updateState(partial: Partial<UpdateState>): void {
    this.state = {
      ...this.state,
      ...partial
    };
    try {
      this.host?.emitStateChanged(this.getState());
    } catch {
      // ignore in headless/test runs
    }
  }

  /**
   * Checks for updates.
   * Tries native Tauri updater first when packaged & configured,
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
      const canUseNative = Boolean(
        this.host?.isPackaged?.() && this.host?.nativeCheck
      );
      if (canUseNative && this.host?.nativeCheck) {
        try {
          const nativeRes = await Promise.race([
            this.host.nativeCheck(),
            new Promise<null>((_, reject) => {
              const timer = setTimeout(() => reject(new Error('Updater timeout')), 10_000);
              timer.unref?.();
            })
          ]);
          if (nativeRes) {
            this.usedNativeUpdater = true;
            if (nativeRes.available && nativeRes.version) {
              const cleanVer = nativeRes.version.replace(/^v/i, '').trim();
              this.updateState({
                status: 'available',
                updateInfo: {
                  version: cleanVer,
                  releaseDate: nativeRes.date,
                  releaseNotes: nativeRes.body,
                  releaseName: `v${cleanVer}`,
                  downloadUrl: this.buildDefaultDownloadUrl(cleanVer)
                },
                errorMessage: null,
                lastCheckedAt: new Date().toISOString()
              });
            } else {
              this.updateState({
                status: 'not_available',
                updateInfo: { version: this.state.currentVersion },
                errorMessage: null,
                lastCheckedAt: new Date().toISOString()
              });
            }
          }
        } catch {
          // Fall back to GitHub Releases HTTP check below
        }
      }

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
      const preferredAsset =
        data.assets?.find((a) => a.name.toLowerCase().includes('setup') && a.name.endsWith('.exe')) ??
        data.assets?.find((a) => a.name.endsWith('.exe'));

      this.applyResolvedRelease({
        remoteTag,
        releaseName: data.name || remoteTag,
        releaseNotes: data.body ?? undefined,
        releaseDate: data.published_at,
        downloadUrl: preferredAsset?.browser_download_url || data.html_url
      });
      return;
    } catch {
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
        const pathMatch = ymlText.match(/^path:\s*([^\r\n]+)$/m);
        if (pathMatch?.[1]) {
          const assetName = pathMatch[1].trim().replace(/^['"]|['"]$/g, '');
          downloadUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${remoteTag}/${assetName}`;
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
        this.host?.isPackaged?.() &&
          this.usedNativeUpdater &&
          this.host?.nativeDownloadAndInstall
      );

      if (canUseNativeDownload && this.host?.nativeDownloadAndInstall) {
        try {
          const handled = await this.host.nativeDownloadAndInstall((progress) => {
            this.updateState({
              status: 'downloading',
              progress,
              errorMessage: null
            });
          });
          if (handled) {
            this.isDownloading = false;
            this.updateState({
              status: 'downloaded',
              progress: {
                percent: 100,
                transferredBytes: this.state.progress?.totalBytes ?? 0,
                totalBytes: this.state.progress?.totalBytes ?? 0,
                bytesPerSecond: 0
              },
              errorMessage: null
            });
            return;
          }
        } catch {
          // Fall back to direct GitHub asset download below
        }
      }

      const targetUrl =
        updateInfo.downloadUrl || this.buildDefaultDownloadUrl(updateInfo.version);

      if (!targetUrl.toLowerCase().endsWith('.exe')) {
        await this.host?.openExternalUrl(targetUrl);
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
        await this.host?.openExternalUrl(fallbackUrl);
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
    const fileName = `MesAI-Setup-${cleanVer}.exe`;
    const tempDir = this.host?.getTempDir() || os.tmpdir();
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
        setTimeout(() => this.host?.quitApp?.(), 300);
        return;
      } catch {
        await this.host?.openPath(this.downloadedInstallerPath);
        setTimeout(() => this.host?.quitApp?.(), 300);
        return;
      }
    }

    if (this.state.updateInfo?.downloadUrl) {
      await this.host?.openExternalUrl(this.state.updateInfo.downloadUrl);
    } else {
      await this.host?.openExternalUrl(GITHUB_RELEASES_PAGE_URL);
    }
  }
}
