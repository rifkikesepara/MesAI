import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Notification,
  Tray
} from 'electron';
import path from 'node:path';
import { MesaiDatabase } from './db/database';
import { MesaiRepository } from './db/repositories';
import { MatcherService } from './services/matcher-service';
import { ZoomReaderAdapter } from './services/zoom-adapter';
import { GitFileWatcherService } from './services/git-file-watcher';
import { ReportService } from './services/report-service';
import { IntegrationsService } from './services/integrations-service';
import { SchedulerService } from './services/scheduler-service';
import { UpdateService } from './services/update-service';
import { registerIpcHandlers } from './ipc-handlers';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

let database: MesaiDatabase | null = null;
let scheduler: SchedulerService | null = null;

const isSmokeVerify = process.argv.includes('--verify-smoke');
const isUiVerify = process.argv.includes('--verify-ui');

if (isSmokeVerify || isUiVerify) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !isSmokeVerify && !isUiVerify) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const userDataDir = app.getPath('userData');
    const dbPath = path.join(userDataDir, 'mesai_data.sqlite');

    database = new MesaiDatabase(dbPath);
    const repo = new MesaiRepository(database);
    const matcher = new MatcherService(repo);
    const zoomAdapter = new ZoomReaderAdapter(repo, matcher, { stateDir: userDataDir });
    const gitWatcher = new GitFileWatcherService(repo, matcher);
    const reportService = new ReportService(repo);
    const integrations = new IntegrationsService(repo, zoomAdapter, gitWatcher, reportService, {
      userDataDir
    });

    scheduler = new SchedulerService(
      repo,
      zoomAdapter,
      gitWatcher,
      (title, body) => {
        if (Notification.isSupported()) {
          new Notification({ title, body }).show();
        }
      }
    );

    const updateTrayMenu = () => {
      if (!tray) return;
      const settings = repo.getSettings();
      const contextMenu = Menu.buildFromTemplate([
        {
          label: 'MesAI Penceresini Aç',
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.focus();
            }
          }
        },
        {
          label: settings.trackingPaused ? '▶ Takibi Devam Ettir' : '⏸ Takibi Duraklat',
          click: () => {
            repo.updateSettings({ trackingPaused: !settings.trackingPaused });
            scheduler?.startOrReload();
            updateTrayMenu();
          }
        },
        {
          label: '🔄 Şimdi Zoom & Git Oku',
          click: async () => {
            await zoomAdapter.pollOnce();
            await gitWatcher.pollAllProjectsGit();
          }
        },
        { type: 'separator' },
        {
          label: 'Çıkış',
          click: () => {
            isQuitting = true;
            app.quit();
          }
        }
      ]);
      tray.setToolTip(
        `MesAI (DevTrack AI) — ${settings.trackingPaused ? 'Duraklatıldı' : 'Aktif Takip'}`
      );
      tray.setContextMenu(contextMenu);
    };

    const updateService = new UpdateService(() => mainWindow);

    registerIpcHandlers({
      getMainWindow: () => mainWindow,
      repo,
      zoomAdapter,
      gitWatcher,
      matcher,
      reportService,
      integrations,
      scheduler,
      updateService,
      onTrayUpdate: updateTrayMenu
    });

    const settings = repo.getSettings();
    if (settings.watchRootPath) {
      await gitWatcher.discoverGitProjects(settings.watchRootPath, !isSmokeVerify && !isUiVerify);
    }

    if (isSmokeVerify && !isUiVerify) {
      const zoomRes = await zoomAdapter.pollOnce();
      const gitRes = await gitWatcher.pollAllProjectsGit();
      const today = new Date().toISOString().slice(0, 10);
      const report = await reportService.generateReport({
        reportDate: today,
        provider: 'local_rule'
      });

      const payload = {
        smokeVerify: 'ok',
        dbPath,
        zoomPoll: zoomRes,
        gitPoll: gitRes,
        discoveredProjects: repo.listProjects().length,
        totalActivities: repo.listActivities({}).length,
        generatedReportItems: report.items.length,
        zoomExecutablePath: zoomAdapter.resolveExecutablePath()
      };
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(payload, null, 2));
      gitWatcher.stopAllWatchers();
      scheduler.stopAll();
      database.close();
      app.exit(0);
      return;
    }

    const smokeData =
      isUiVerify && isSmokeVerify
        ? {
            zoomPoll: await zoomAdapter.pollOnce(),
            gitPoll: await gitWatcher.pollAllProjectsGit(),
            reportItems: (
              await reportService.generateReport({
                reportDate: new Date().toISOString().slice(0, 10),
                provider: 'local_rule'
              })
            ).items.length,
            zoomExecutablePath: zoomAdapter.resolveExecutablePath()
          }
        : null;

    createTray(updateTrayMenu);
    createMainWindow();
    scheduler.startOrReload();

    if (settings.autoCheckUpdatesOnStartup !== false && !isSmokeVerify && !isUiVerify) {
      setTimeout(() => {
        void updateService.checkForUpdates();
      }, 5000);
    }

    if (!settings.trackingPaused && !isUiVerify) {
      void zoomAdapter.pollOnce();
      void gitWatcher.pollAllProjectsGit();
    }

    if (isUiVerify && mainWindow) {
      mainWindow.webContents.on('did-finish-load', async () => {
        await new Promise((r) => setTimeout(r, 1500));
        const bodyText = await mainWindow!.webContents.executeJavaScript(
          'document.body.innerText'
        );
        const fs = await import('node:fs');
        const payload = {
          smokeData,
          uiVerify: 'ok',
          dbPath,
          discoveredProjects: repo.listProjects().length,
          totalActivities: repo.listActivities({}).length,
          title: mainWindow!.getTitle(),
          renderedHeadingPresent: String(bodyText).includes('MesAI'),
          limitationsPresent: String(bodyText).includes('API’siz Yerel Zoom Okuyucu'),
          snippet: String(bodyText).replace(/\s+/g, ' ').slice(0, 260)
        };
        fs.writeFileSync(
          path.join(process.cwd(), 'verify-output.json'),
          JSON.stringify(payload, null, 2),
          'utf-8'
        );
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(payload, null, 2));
        isQuitting = true;
        gitWatcher.stopAllWatchers();
        scheduler?.stopAll();
        database?.close();
        app.exit(0);
      });
    }
  });
}

function createTray(updateTrayMenu: () => void): void {
  try {
    // 16x16 indigo icon data URL
    const iconDataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAySURBVDhPY/z//z8DJYCRkZGRgYGBgYFRBqNgFIyCUTAKRsEoGAWjYBSMAhAwMDAwAAAfJwMR60l66AAAAABJRU5ErkJggg==';
    const image = nativeImage.createFromDataURL(iconDataUrl);
    tray = new Tray(image);
    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    updateTrayMenu();
  } catch {
    // ignore tray creation error in headless environments
  }
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: 'MesAI — Kanıta Dayalı Günlük Çalışma Raporu',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(false);

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    const indexHtml = path.resolve(__dirname, '../../../dist-renderer/index.html');
    void mainWindow.loadFile(indexHtml);
  }

  mainWindow.on('close', (event) => {
    if (!isQuitting && tray) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  scheduler?.stopAll();
  database?.close();
});
