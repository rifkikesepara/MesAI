import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  type NativeImage,
  Notification,
  shell,
  Tray
} from 'electron';
import fs from 'node:fs';
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
import { TaskbarService } from './services/taskbar-service';
import { registerIpcHandlers } from './ipc-handlers';
import { IPC_CHANNELS } from '../shared/ipc-channels';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let taskbarService: TaskbarService | null = null;
let isQuitting = false;

let database: MesaiDatabase | null = null;
let scheduler: SchedulerService | null = null;

const isSmokeVerify = process.argv.includes('--verify-smoke');
const isUiVerify = process.argv.includes('--verify-ui');
const isCaptureScreenshots = process.argv.includes('--capture-screenshots');

if (isSmokeVerify || isUiVerify || isCaptureScreenshots) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !isSmokeVerify && !isUiVerify && !isCaptureScreenshots) {
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
      const isPaused = settings.trackingPaused;
      try {
        tray.setImage(getTrayIcon(isPaused));
      } catch {
        // ignore
      }
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
          label: isPaused ? '▶ Takibi Devam Ettir' : '⏸ Takibi Duraklat',
          click: () => {
            repo.updateSettings({ trackingPaused: !isPaused });
            scheduler?.startOrReload();
            updateAllTrackingIndicators();
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
        `MesAI (DevTrack AI) — ${isPaused ? 'Duraklatıldı' : 'Aktif Takip'}`
      );
      tray.setContextMenu(contextMenu);
    };

    taskbarService = new TaskbarService(
      () => mainWindow,
      repo,
      scheduler,
      zoomAdapter,
      gitWatcher,
      updateTrayMenu
    );

    const updateAllTrackingIndicators = () => {
      const current = repo.getSettings();
      updateTrayMenu();
      taskbarService?.updateTaskbar(current.trackingPaused);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.TRACKING_STATE_CHANGED, current.trackingPaused);
      }
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
      onTrayUpdate: updateAllTrackingIndicators
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

    createTray(updateTrayMenu, settings.trackingPaused);
    createMainWindow();
    taskbarService?.updateTaskbar(settings.trackingPaused);
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

    if (isCaptureScreenshots && mainWindow) {
      mainWindow.webContents.on('did-finish-load', async () => {
        const outDir = path.resolve(process.cwd(), 'docs/images');
        fs.mkdirSync(outDir, { recursive: true });

        const tabs = [
          { name: '01-dashboard.png', selector: '.nav-list .nav-btn:nth-child(1)' },
          { name: '02-projects.png', selector: '.nav-list .nav-btn:nth-child(2)' },
          { name: '03-timeline.png', selector: '.nav-list .nav-btn:nth-child(3)' },
          { name: '04-daily-report.png', selector: '.nav-list .nav-btn:nth-child(4)' },
          { name: '05-integrations.png', selector: '.nav-list .nav-btn:nth-child(5)' },
          { name: '06-settings.png', selector: '.sidebar-nav-bottom .nav-btn' }
        ];

        // Wait initial render
        await new Promise((r) => setTimeout(r, 2500));

        // 1. Dashboard
        const img1 = await mainWindow!.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, '01-dashboard.png'), img1.toPNG());
        console.log('Captured 01-dashboard.png');

        // 2. Projects
        await mainWindow!.webContents.executeJavaScript(`
          document.querySelector('.nav-list .nav-btn:nth-child(2)')?.click();
        `);
        await new Promise((r) => setTimeout(r, 1500));
        const img2 = await mainWindow!.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, '02-projects.png'), img2.toPNG());
        console.log('Captured 02-projects.png');

        // 3. Timeline
        await mainWindow!.webContents.executeJavaScript(`
          document.querySelector('.nav-list .nav-btn:nth-child(3)')?.click();
        `);
        await new Promise((r) => setTimeout(r, 1500));
        const img3 = await mainWindow!.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, '03-timeline.png'), img3.toPNG());
        console.log('Captured 03-timeline.png');

        // 4. Daily Report (select 2026-10-16 with existing verified items)
        await mainWindow!.webContents.executeJavaScript(`
          (async () => {
            document.querySelector('.nav-list .nav-btn:nth-child(4)')?.click();
          })();
        `);
        await new Promise((r) => setTimeout(r, 1500));
        await mainWindow!.webContents.executeJavaScript(`
          (async () => {
            const dateInput = document.querySelector('input[type="date"]');
            if (dateInput) {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
              setter?.call(dateInput, '2026-10-16');
              dateInput.dispatchEvent(new Event('input', { bubbles: true }));
              dateInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
          })();
        `);
        await new Promise((r) => setTimeout(r, 2000));
        const img4 = await mainWindow!.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, '04-daily-report.png'), img4.toPNG());
        console.log('Captured 04-daily-report.png');

        // 5. Integrations (wait for health check)
        await mainWindow!.webContents.executeJavaScript(`
          document.querySelector('.nav-list .nav-btn:nth-child(5)')?.click();
        `);
        await new Promise((r) => setTimeout(r, 3500));
        const img5 = await mainWindow!.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, '05-integrations.png'), img5.toPNG());
        console.log('Captured 05-integrations.png');

        // 6. Settings
        await mainWindow!.webContents.executeJavaScript(`
          document.querySelector('.sidebar-nav-bottom .nav-btn')?.click();
        `);
        await new Promise((r) => setTimeout(r, 1500));
        const img6 = await mainWindow!.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, '06-settings.png'), img6.toPNG());
        console.log('Captured 06-settings.png');

        // 7. Light Theme Dashboard
        await mainWindow!.webContents.executeJavaScript(`
          document.documentElement.setAttribute('data-theme', 'light');
          document.querySelector('.nav-list .nav-btn:nth-child(1)')?.click();
        `);
        await new Promise((r) => setTimeout(r, 1500));
        const img7 = await mainWindow!.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, '07-light-theme.png'), img7.toPNG());
        console.log('Captured 07-light-theme.png');

        isQuitting = true;
        gitWatcher.stopAllWatchers();
        scheduler?.stopAll();
        database?.close();
        app.exit(0);
      });
    }
  });
}

function getTrayIcon(isPaused: boolean): NativeImage {
  try {
    const filename = isPaused ? 'tray-icon-paused.png' : 'tray-icon-active.png';
    const iconPath = path.resolve(__dirname, '../../../assets', filename);
    if (fs.existsSync(iconPath)) {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) return img;
    }
  } catch {
    // fallback
  }
  const fallbackPath = path.resolve(__dirname, '../../../assets/tray-icon.png');
  return fs.existsSync(fallbackPath)
    ? nativeImage.createFromPath(fallbackPath)
    : nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAIJUlEQVR4nMVXa2xcVxGemXPuvetn7DTPltA0SgLZ2E6D40cAyQlVALVCoUIGVYAqhAK/ShEBIoHADUJUIrykVvxACYhHUdUVAqKiqq3aZFGJXzHgrGO1IRJxa1qSuI0de727995zBs25d+3FFJogJI5l2feec+abM/PNd+Yi3MRgAIQBQDjdRyvnTgPAvnzeIoC9GZs3DMx9ffqG1/b3K+fsDQx8q3nu7yfM5Uz6TNe6sh0e6g4LdjMBrmJmi4hXrIELxTgc3zj+0qUlZ/r7Vc3em3NgAICOpuGc3rNzUwvhpxTRRwixzSdKUoAIwJz+AlSsKVqgYQv251f/fv3xO6amyuIE5HKSGr5hBxiAJJf9AOon3TuP+KgOe1qtFqCQ2QJDLNjG2jIzoCYKWJxA9HwElN2hsZOLsfl669nzvxKQNCX8lg5wCn519ztubQqCxwKl9kXGyPuQLcucQAAS4YLlPms40+zRM2ytcSAIFoHYJ/TFXjGKf3hsdOKBh1LwlZHANwN/dfeO21s9/WzG09sqcVwGAI2I5HZaZkSgGMDMZvyNerGkm0hNEyAyMyOhBEeMSfpi39eZhTD63Uuxf2+nAI6NRbWYekWJwYWntja3kD6ZUXpbxZgKAPqIS94vHUFguFiu8ynWiGopxo4PgMDI7JPKRMZWLEJ+TwpcPWQVl5ZcEbYfBbsR6x6t015HaEwFGbw0UJjETSAkyujOm9HalisorHB8RDEtMUIIA8/zYoDpYmTuWTVUOHa5K7vhSmfbPQJeW6JUWy4znW0HGpT6ZGjiCAA9QJASsuJ3siNNX0onJmIIAnQjmWZEsoGnMxUT5xcq4XtaRwvPzXRmu5tR5Vt99eRrXTt2uqUDCTY5g7mci1ugcCCxJDMo7BYn7ArWrGByuZoWiwjoa/JLUfyjk2fO3bV6bPLl691tn23SdEoTbteKoJH0w8nygcQc94PCHJjZzmx3g+8NWREWQLTEZcvwtzqkbRW2EYIkGoCFhIRkgeMi4x1Rqey1ZPwXfaUCY21YAXu4aWji0Qtbtwa3rc48Uq/VodCyYUBDCKKQvBDDnbeMjp8XPhBc6Uu4RXRQK5fEyFNIseHzM/zGrkU2Pwu0Fi7EjuWOZ6J/YCUFViub8XQQs720YPiAgL/anc1uWlN/qj7wDwk5kpAxWebIV6Q9sh92r/r6iCCfd4zUBL0ur9UgI8RvH5ouNQwW7l8M4+O+UlLXUUpGRMIArUWPbGYxip++Zm3v6tHC72c7s/fdQvp0JuPvLZt4at7YrwDCHAJQ1TYyvNuZWZd3wmKfyGZ9RNrMaYEl5HDMdxdLw/C5Q8UoekTIhQiRJikz+AtFeqGsWl5pGC58cMPwxOWF7vbvNHreL33fW1sK49Nlg/uah849HBt+3SMi8VrKVCFueQKS1JOA9SjVANY22aRA2IUtCTcLQbmz02scLnyuGEXf9bXKKEUcG3ti9djY3KahofJMe/vbyr0dzzcE3mHSBMUo+v6Ts+EHWofHL53t7KxHSssUOS1nbtre0ZFZqoJiJpIlyp09xRW5q2qUqJdcx41DhS8uxNE3gYg8wr0y+ZBUT4ZPBIG/PzT22vU4+kTj4LkvfHRyMhSSjQFUBWi5hBFQx3EaaQCYKNI8uzy5n3Rt8kcApt71zk7M52Op3aahia/NlcoDGU8fLPV2DH5pb8dgY33m/ZU4Ojsbhe9rGZp47BSAvtrT3rmkeEluk2HdQ/Hq2rUi8SDEIPEWEKacnDgPl68IuZJbPP2t4t5dj+dyWSfdLSMT37hejr6cCbzeBs/rXgyj4y9HxbvWj07++a+7bm/p6e34bR3gEVm7fWZGypfcsRhsqpav7JcDgZRhX9JeWYbBVMzluk1TkUaNcbY+8D/2oRb/uak97Vvk3aqRwrHZUuXT86XyoYbB8UPbRy5ev7Jnx+4NdavydYF/NwHM1apXWo4skJbwzHIZrsu78FTQ/CY0VqjnbpblVLjtCuLYZIjeu8GnP8z2tB2Q960jEz9uHj1/XP5/o6vt46uUlw+IOiA2hhGccAUbjZhywoHAOjLGliz/erkMcyD3OK0ZmhwNjT3jq+QeXz5/yhREFVpTUoAb6pGemtuz80GZknKa39vx7Vbf+wUiNEZsS5CC1w4hg6+UDi2/sG6o8EceGHDY2s3296O0TQb5KDM8gwiShn/WfGYpTW0AYtGh5sD7wXxPexaB1zdofTAyJrJJrlXtzsprinm9O5CNWdQQvuomJieXqwBzOSOC0zI88eyCMSfA8wgRKrXMXbpBmUmcqRgbNXr6Mw2edzCM48haVimF07QlKQyMQSAIdeBRyZjvNQ+fe6G2WaUlkFzOSljm8NoD5UqlwMy3roxANSrpfa4qsYlCY+TqFvCkcqtimlqebm42BHhbKYyeHwsKR6pNam123XDqc/QoiP4XzeLdFWOfnshmHR+qB3PNYHUkpaoEvHZN8p6lltzo8rz6irE/nY6L9+7PQ7yyQ9bLFp0JJ8Y4cnEaAB4UCXYT5KxL3TqZdP2HcKLagVUbFifjbABQKO9sR8ViqXX84ueTVUkjX4tJtQ/VSCQXFiBs2eLOwRYi8LQOCAPXDIKAQOzac5AWHYWYhoiUr1QdKCJmuCp7t+3eHVftvdm3AcJ/GNXe7XJP27pGVPdr5PsQsN1XlIQ9+RZY+kAJmecBYTCM+cRMMHtyc36qUqXuv8NAuMnxeteOnUqpO8nAFkJuccaJLhvAFyPLf1ozUpD0/V8/Tskx/X/0cfovjrg96f1RO/7bz/N/ADOu/aTYjiU0AAAAAElFTkSuQmCC'
      );
}

function createTray(updateTrayMenu: () => void, isPaused: boolean): void {
  try {
    const image = getTrayIcon(isPaused);
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
  const iconPath = path.resolve(__dirname, '../../../assets/icon.png');
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: 'MesAI — Kanıta Dayalı Günlük Çalışma Raporu',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('mesai:window:maximizeChanged', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('mesai:window:maximizeChanged', false);
  });

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

  mainWindow.on('show', () => {
    if (database) {
      taskbarService?.updateTaskbar(new MesaiRepository(database).getSettings().trackingPaused);
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (database) {
      taskbarService?.updateTaskbar(new MesaiRepository(database).getSettings().trackingPaused);
    }
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  scheduler?.stopAll();
  database?.close();
});
