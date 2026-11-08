import { powerMonitor } from 'electron';
import type { MesaiRepository } from '../db/repositories';
import type { ZoomReaderAdapter } from './zoom-adapter';
import type { GitFileWatcherService } from './git-file-watcher';

export class SchedulerService {
  private zoomTimer: NodeJS.Timeout | null = null;
  private gitTimer: NodeJS.Timeout | null = null;
  private notifyTimer: NodeJS.Timeout | null = null;
  private lastNotifiedDate: string | null = null;
  private systemSuspendedOrLocked = false;
  private powerListenersRegistered = false;
  private zoomTickCounter = 0;
  private gitTickCounter = 0;

  constructor(
    private readonly repo: MesaiRepository,
    private readonly zoomAdapter: ZoomReaderAdapter,
    private readonly gitWatcher: GitFileWatcherService,
    private readonly onNotify?: (title: string, body: string) => void
  ) {
    this.registerPowerMonitorListeners();
  }

  private registerPowerMonitorListeners(): void {
    if (this.powerListenersRegistered) return;
    try {
      if (!powerMonitor || typeof powerMonitor.on !== 'function') return;
      this.powerListenersRegistered = true;

      const handlePause = () => {
        this.systemSuspendedOrLocked = true;
        this.stopTimersOnly();
      };

      const handleResume = () => {
        const wasPausedBySystem = this.systemSuspendedOrLocked;
        this.systemSuspendedOrLocked = false;
        this.startOrReload();
        if (wasPausedBySystem && !this.repo.getSettings().trackingPaused) {
          void this.zoomAdapter.pollOnce();
          void this.gitWatcher.pollAllProjectsGit();
        }
      };

      powerMonitor.on('suspend', handlePause);
      powerMonitor.on('lock-screen', handlePause);
      powerMonitor.on('resume', handleResume);
      powerMonitor.on('unlock-screen', handleResume);
    } catch {
      // Ignore if running outside Electron main process in tests
    }
  }

  private shouldThrottleOnBatteryIdle(kind: 'zoom' | 'git'): boolean {
    try {
      if (!powerMonitor || typeof powerMonitor.isOnBatteryPower !== 'function') {
        return false;
      }
      const onBattery = powerMonitor.isOnBatteryPower();
      const idleSeconds =
        typeof powerMonitor.getSystemIdleTime === 'function'
          ? powerMonitor.getSystemIdleTime()
          : 0;
      if (onBattery && idleSeconds >= 180) {
        if (kind === 'zoom') {
          this.zoomTickCounter++;
          return this.zoomTickCounter % 2 === 1;
        }
        this.gitTickCounter++;
        return this.gitTickCounter % 2 === 1;
      }
    } catch {
      // ignore
    }
    if (kind === 'zoom') this.zoomTickCounter = 0;
    else this.gitTickCounter = 0;
    return false;
  }

  public startOrReload(): void {
    this.stopTimersOnly();
    const settings = this.repo.getSettings();

    if (settings.trackingPaused || this.systemSuspendedOrLocked) {
      this.gitWatcher.stopAllWatchers();
      return;
    }

    this.gitWatcher.refreshFileWatchers();

    const zoomMs = Math.max(10, settings.zoomPollIntervalSeconds) * 1000;
    const gitMs = Math.max(20, settings.gitPollIntervalSeconds) * 1000;

    this.zoomTimer = setInterval(() => {
      if (this.systemSuspendedOrLocked) return;
      const s = this.repo.getSettings();
      if (!s.trackingPaused && !this.shouldThrottleOnBatteryIdle('zoom')) {
        void this.zoomAdapter.pollOnce();
      }
    }, zoomMs);

    this.gitTimer = setInterval(() => {
      if (this.systemSuspendedOrLocked) return;
      const s = this.repo.getSettings();
      if (!s.trackingPaused && !this.shouldThrottleOnBatteryIdle('git')) {
        void this.gitWatcher.pollAllProjectsGit();
      }
    }, gitMs);

    this.notifyTimer = setInterval(() => {
      if (this.systemSuspendedOrLocked) return;
      this.checkEndOfDayNotification();
    }, 60_000);
  }

  private checkEndOfDayNotification(): void {
    const settings = this.repo.getSettings();
    if (!settings.endOfDayNotification || settings.trackingPaused) return;

    const now = new Date();
    const hhmm = now.toTimeString().slice(0, 5);
    const today = now.toISOString().slice(0, 10);

    if (hhmm === settings.workdayEnd && this.lastNotifiedDate !== today) {
      this.lastNotifiedDate = today;
      const report = this.repo.getDailyReport(today);
      if (!report || report.status !== 'approved') {
        this.onNotify?.(
          'MesAI — Günlük Çalışma Raporu Hazır',
          `${today} tarihli aktivitelerinizi gözden geçirip günlük raporunuzu onaylayabilirsiniz.`
        );
      }
    }
  }

  private stopTimersOnly(): void {
    if (this.zoomTimer) {
      clearInterval(this.zoomTimer);
      this.zoomTimer = null;
    }
    if (this.gitTimer) {
      clearInterval(this.gitTimer);
      this.gitTimer = null;
    }
    if (this.notifyTimer) {
      clearInterval(this.notifyTimer);
      this.notifyTimer = null;
    }
  }

  public stopAll(): void {
    this.stopTimersOnly();
    this.zoomAdapter.stop();
    this.gitWatcher.stopAllWatchers();
  }
}
