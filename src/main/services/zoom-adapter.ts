import { execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MesaiRepository } from '../db/repositories';
import type { MatcherService } from './matcher-service';
import type { ZoomChatSnapshot, ZoomReaderStatus } from '../../shared/types';

export interface ZoomPollResult {
  ok: boolean;
  status: ZoomReaderStatus;
  newMessages: number;
  totalVisible: number;
  chatName: string | null;
  windowState: string | null;
  error?: string | null;
}

export class ZoomReaderAdapter {
  private activeProcess: ChildProcess | null = null;
  private isPolling = false;
  private lastSnapshot: ZoomChatSnapshot | null = null;
  private readonly stateFilePath: string;
  private readonly customExePath?: string;

  constructor(
    private readonly repo: MesaiRepository,
    private readonly matcher: MatcherService,
    options?: { stateDir?: string; customExePath?: string }
  ) {
    const baseDir = options?.stateDir ?? process.cwd();
    this.stateFilePath = path.join(baseDir, 'zoom_last_snapshot.json');
    this.customExePath = options?.customExePath;
  }

  public resolveExecutablePath(): string {
    if (this.customExePath) return this.customExePath;

    // 1. Check packaged Electron resourcesPath
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) {
      const packagedExe = path.join(resourcesPath, 'ZoomChatReader', 'ZoomChatReader.exe');
      if (fs.existsSync(packagedExe)) return packagedExe;
    }

    // 2. Check local repository Release build
    const releaseExe = path.resolve(
      process.cwd(),
      'readers',
      'ZoomChatReader',
      'bin',
      'Release',
      'net10.0-windows',
      'ZoomChatReader.exe'
    );
    if (fs.existsSync(releaseExe)) return releaseExe;

    // 3. Check local repository Debug build
    const debugExe = path.resolve(
      process.cwd(),
      'readers',
      'ZoomChatReader',
      'bin',
      'Debug',
      'net10.0-windows',
      'ZoomChatReader.exe'
    );
    return debugExe;
  }

  public isCurrentlyRunning(): boolean {
    return this.isPolling;
  }

  public getLastSnapshot(): ZoomChatSnapshot | null {
    return this.lastSnapshot;
  }

  public getDefaultLimitations(): string[] {
    return (
      this.lastSnapshot?.limitations ?? [
        'Kalıcı mesaj kimliği yok: Zoom UIA mesaj düğümlerinde sunucu/veritabanı ID sunmaz; tekilleştirme oturum RuntimeId ve içerik özeti (fingerprint + sıra numarası) ile yapılır.',
        'Sanal liste (_virtualList_): Yalnızca açık olan sohbette ve o an görünüm tamponunda yüklü olan mesajlar okunur; okundu bilgisi tetiklememek için otomatik kaydırma veya sohbet değiştirme yapılmaz.',
        'Göreli tarihler: Today, Yesterday, Wed gibi ifadeler gözlem zamanına göre çözümlenir ve özgün metin her zaman korunur.'
      ]
    );
  }

  /**
   * Executes a single read cycle from ZoomChatReader.exe.
   * Prevents concurrent process execution via single-flight lock.
   */
  public async pollOnce(timeoutMs = 15_000): Promise<ZoomPollResult> {
    if (this.isPolling) {
      return {
        ok: false,
        status: 'ok',
        newMessages: 0,
        totalVisible: this.lastSnapshot?.messages.length ?? 0,
        chatName: this.lastSnapshot?.chatName ?? null,
        windowState: this.lastSnapshot?.windowState ?? null,
        error: 'Okuyucu zaten çalışıyor; eşzamanlı ikinci süreç engellendi.'
      };
    }

    const exePath = this.resolveExecutablePath();
    const attemptAt = new Date().toISOString();

    if (!fs.existsSync(exePath)) {
      const msg = `ZoomChatReader yürütülebilir dosyası bulunamadı: ${exePath}`;
      this.repo.updateSyncState({
        connector: 'zoom_reader',
        status: 'error',
        lastAttemptAt: attemptAt,
        lastError: msg
      });
      return {
        ok: false,
        status: 'error',
        newMessages: 0,
        totalVisible: 0,
        chatName: null,
        windowState: null,
        error: msg
      };
    }

    this.isPolling = true;
    try {
      const stdout = await this.runReaderProcess(exePath, ['--state-file', this.stateFilePath], timeoutMs);
      let snapshot: ZoomChatSnapshot;
      try {
        snapshot = JSON.parse(stdout) as ZoomChatSnapshot;
      } catch (parseErr) {
        const errMsg = `Zoom okuyucu geçersiz JSON döndürdü: ${(parseErr as Error).message}`;
        this.repo.updateSyncState({
          connector: 'zoom_reader',
          status: 'error',
          lastAttemptAt: attemptAt,
          lastError: errMsg
        });
        return {
          ok: false,
          status: 'error',
          newMessages: 0,
          totalVisible: 0,
          chatName: null,
          windowState: null,
          error: errMsg
        };
      }

      this.lastSnapshot = snapshot;

      if (snapshot.status !== 'ok') {
        // Distinguish "zoom_not_running", "window_minimized_or_hidden", "chat_panel_not_open", "error"
        // without wiping any previously collected records!
        const existingSync = this.repo.getSyncState('zoom_reader');
        this.repo.updateSyncState({
          connector: 'zoom_reader',
          status: snapshot.status,
          lastAttemptAt: attemptAt,
          lastError: snapshot.errorMessage ?? `Durum: ${snapshot.status}`,
          recordsCount: existingSync?.recordsCount ?? 0,
          metadata: {
            windowState: snapshot.windowState ?? 'unknown',
            activeChatName: snapshot.chatName ?? null,
            limitations: snapshot.limitations ?? []
          }
        });

        return {
          ok: false,
          status: snapshot.status,
          newMessages: 0,
          totalVisible: 0,
          chatName: snapshot.chatName ?? null,
          windowState: snapshot.windowState ?? null,
          error: snapshot.errorMessage ?? null
        };
      }

      // Ingest messages and run matching for newly created activities
      const ingested = this.repo.ingestZoomSnapshot(snapshot);
      for (const actId of ingested.newActivityIds) {
        this.matcher.matchActivityById(actId);
      }

      const prevSync = this.repo.getSyncState('zoom_reader');
      const totalCollected = (prevSync?.recordsCount ?? 0) + ingested.newMessagesCount;

      this.repo.updateSyncState({
        connector: 'zoom_reader',
        status: 'ok',
        cursor: snapshot.sessionId ?? snapshot.chatName ?? null,
        lastAttemptAt: attemptAt,
        lastSuccessAt: snapshot.capturedAt || attemptAt,
        lastError: null,
        recordsCount: totalCollected,
        metadata: {
          activeChatName: snapshot.chatName,
          chatType: snapshot.chatType,
          windowState: snapshot.windowState ?? 'normal',
          visibleMessagesInDom: snapshot.messages.length,
          lastNewMessages: ingested.newMessagesCount,
          limitations: snapshot.limitations
        }
      });

      return {
        ok: true,
        status: 'ok',
        newMessages: ingested.newMessagesCount,
        totalVisible: snapshot.messages.length,
        chatName: snapshot.chatName,
        windowState: snapshot.windowState ?? 'normal',
        error: null
      };
    } catch (err) {
      const isTimeout = (err as Error).message.includes('ETIMEDOUT') || (err as Error).message.includes('zaman aşımı');
      const status: ZoomReaderStatus = isTimeout ? 'timeout' : 'error';
      const errMsg = (err as Error).message;
      this.repo.updateSyncState({
        connector: 'zoom_reader',
        status,
        lastAttemptAt: attemptAt,
        lastError: errMsg
      });
      return {
        ok: false,
        status,
        newMessages: 0,
        totalVisible: 0,
        chatName: null,
        windowState: null,
        error: errMsg
      };
    } finally {
      this.isPolling = false;
      this.activeProcess = null;
    }
  }

  private runReaderProcess(exePath: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        exePath,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          if (error) {
            if (error.killed || (error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
              reject(new Error(`ZoomChatReader zaman aşımına uğradı (${timeoutMs}ms).`));
              return;
            }
            reject(new Error(`ZoomChatReader süreç hatası: ${stderr || error.message}`));
            return;
          }
          resolve(stdout);
        }
      );
      this.activeProcess = child;
    });
  }

  /**
   * Terminates any running ZoomChatReader helper process cleanly on app shutdown.
   */
  public stop(): void {
    if (this.activeProcess && !this.activeProcess.killed) {
      try {
        this.activeProcess.kill();
      } catch {
        // ignore if already exited
      }
      this.activeProcess = null;
    }
    this.isPolling = false;
  }
}
