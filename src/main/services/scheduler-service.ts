import type { MesaiRepository } from '../db/repositories';
import type { ZoomReaderAdapter } from './zoom-adapter';
import type { GitFileWatcherService } from './git-file-watcher';

export class SchedulerService {
  private zoomTimer: NodeJS.Timeout | null = null;
  private gitTimer: NodeJS.Timeout | null = null;
  private notifyTimer: NodeJS.Timeout | null = null;
  private lastNotifiedDate: string | null = null;

  constructor(
    private readonly repo: MesaiRepository,
    private readonly zoomAdapter: ZoomReaderAdapter,
    private readonly gitWatcher: GitFileWatcherService,
    private readonly onNotify?: (title: string, body: string) => void
  ) {}

  public startOrReload(): void {
    this.stopTimersOnly();
    const settings = this.repo.getSettings();

    if (settings.trackingPaused) {
      this.gitWatcher.stopAllWatchers();
      return;
    }

    this.gitWatcher.refreshFileWatchers();

    const zoomMs = Math.max(10, settings.zoomPollIntervalSeconds) * 1000;
    const gitMs = Math.max(20, settings.gitPollIntervalSeconds) * 1000;

    this.zoomTimer = setInterval(() => {
      const s = this.repo.getSettings();
      if (!s.trackingPaused) {
        void this.zoomAdapter.pollOnce();
      }
    }, zoomMs);

    this.gitTimer = setInterval(() => {
      const s = this.repo.getSettings();
      if (!s.trackingPaused) {
        void this.gitWatcher.pollAllProjectsGit();
      }
    }, gitMs);

    this.notifyTimer = setInterval(() => {
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
