import { BrowserWindow, nativeImage, type NativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import type { MesaiRepository } from '../db/repositories';
import type { SchedulerService } from './scheduler-service';
import type { ZoomReaderAdapter } from './zoom-adapter';
import type { GitFileWatcherService } from './git-file-watcher';
import { IPC_CHANNELS } from '../../shared/ipc-channels';

const ASSET_DATA_URLS = {
  overlayActive:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAe0lEQVR4nGNgoDb4//+/8P///6P////f8////2VQ3AMVEyak2Qmq4ft/TPAdKueET/NBmGqBnY0oGAkcxDAE6uxl2DTiMGgZineg/vtOggEgtdHIBvQQoxnNkB5kA4hyPro3qGoAxV6gOBApi0aKExJVkjKad8jLTOQAAHqjCLeaGqwPAAAAAElFTkSuQmCC',
  overlayPaused:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAfElEQVR4nK2TwQnAIAxFvffoRq7hSpmhx+zhUMXjL4UIUamliR9yiOY/jMYQdgtABJABEACWIFmLX+YkhopZVfbSylxa9XUeXSiVCSLH5mYcIToXcdeO9Fd/AJ7arAH0ZljkpAFsAPBWgLsF9yX6ntE9SFtGeWjH9pksugFmRE7XNJRKXQAAAABJRU5ErkJggg==',
  thumbarPlay:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAXElEQVR4nO3PwQkAIAxDUYdyWedyID0JHizaNAERA73+R1P6e2q5liYLj5OF6cAqTgGsMAXYxWHgJAwBnrAbQOJ3fYBCEOCBQsAJEgZ2EA2wECqwgiTADEmBN9cBW7hKUp4pJnkAAAAASUVORK5CYII=',
  thumbarPause:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAJ0lEQVR4nGNgGAUjF/zer/IfHZMiP2rBqAWjFoxaMGoBXSwYBXQDAL/+rY7Hj/Z1AAAAAElFTkSuQmCC',
  thumbarSync:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAUUlEQVR4nGNgGAXUAlMW7/iPDdPcAqpZRMgCqvoGn6VDzxKSLCDHBWRZQIolQ98CkvRSkiJobgGyGTS1gKDtdLeAbtmf7qUnVXyCzyKqWTAKAKcoX6CJWHzZAAAAAElFTkSuQmCC'
};

function loadIcon(filename: string, fallbackDataUrl: string): NativeImage {
  try {
    const filePath = path.resolve(__dirname, '../../../assets', filename);
    if (fs.existsSync(filePath)) {
      const img = nativeImage.createFromPath(filePath);
      if (!img.isEmpty()) return img;
    }
  } catch {
    // fallback to data URL
  }
  return nativeImage.createFromDataURL(fallbackDataUrl);
}

export class TaskbarService {
  private overlayActive: NativeImage;
  private overlayPaused: NativeImage;
  private thumbarPlay: NativeImage;
  private thumbarPause: NativeImage;
  private thumbarSync: NativeImage;

  constructor(
    private readonly getMainWindow: () => BrowserWindow | null,
    private readonly repo: MesaiRepository,
    private readonly scheduler: SchedulerService,
    private readonly zoomAdapter: ZoomReaderAdapter,
    private readonly gitWatcher: GitFileWatcherService,
    private readonly onTrayUpdate?: () => void
  ) {
    this.overlayActive = loadIcon('overlay-active.png', ASSET_DATA_URLS.overlayActive);
    this.overlayPaused = loadIcon('overlay-paused.png', ASSET_DATA_URLS.overlayPaused);
    this.thumbarPlay = loadIcon('thumbar-play.png', ASSET_DATA_URLS.thumbarPlay);
    this.thumbarPause = loadIcon('thumbar-pause.png', ASSET_DATA_URLS.thumbarPause);
    this.thumbarSync = loadIcon('thumbar-sync.png', ASSET_DATA_URLS.thumbarSync);
  }

  public updateTaskbar(isPaused: boolean): void {
    if (process.platform !== 'win32') return;

    const win = this.getMainWindow();
    if (!win || win.isDestroyed()) return;

    try {
      // 1. Taskbar Icon Overlay Badge
      const overlayImg = isPaused ? this.overlayPaused : this.overlayActive;
      const desc = isPaused ? 'MesAI — Takip Duraklatıldı' : 'MesAI — Takip Aktif';
      win.setOverlayIcon(overlayImg, desc);
    } catch {
      // ignore if unsupported window handle
    }

    try {
      // 2. Spotify-Style Taskbar Thumbnail Activity Buttons
      const buttons: Electron.ThumbarButton[] = [
        {
          tooltip: isPaused ? 'Takibi Başlat / Devam Ettir' : 'Takibi Duraklat',
          icon: isPaused ? this.thumbarPlay : this.thumbarPause,
          click: () => {
            const current = this.repo.getSettings();
            const newPaused = !current.trackingPaused;
            this.repo.updateSettings({ trackingPaused: newPaused });
            this.scheduler.startOrReload();
            this.updateTaskbar(newPaused);
            this.onTrayUpdate?.();

            if (win && !win.isDestroyed()) {
              win.webContents.send(IPC_CHANNELS.TRACKING_STATE_CHANGED, newPaused);
            }
          }
        },
        {
          tooltip: 'Şimdi Tara (Zoom & Git)',
          icon: this.thumbarSync,
          click: async () => {
            await this.zoomAdapter.pollOnce();
            await this.gitWatcher.pollAllProjectsGit();
            this.onTrayUpdate?.();

            if (win && !win.isDestroyed()) {
              win.webContents.send(IPC_CHANNELS.TRACKING_STATE_CHANGED, this.repo.getSettings().trackingPaused);
            }
          }
        }
      ];

      win.setThumbarButtons(buttons);
    } catch {
      // ignore if unsupported in current environment
    }
  }
}
