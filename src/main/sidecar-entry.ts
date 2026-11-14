import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type { UpdateProgress } from '../shared/types';
import { MesaiDatabase } from './db/database';
import { MesaiRepository } from './db/repositories';
import { createRpcHandlers } from './ipc-handlers';
import { resolveDefaultUserDataDir, type HostBridge, type PowerIdleState, type SaveFileDialogOptions } from './host-bridge';
import { GitFileWatcherService } from './services/git-file-watcher';
import { IntegrationsService, type SecretProvider } from './services/integrations-service';
import { MatcherService } from './services/matcher-service';
import { ReportService } from './services/report-service';
import { SchedulerService } from './services/scheduler-service';
import { UpdateService } from './services/update-service';
import { ZoomReaderAdapter } from './services/zoom-adapter';

const rawStdoutWrite = process.stdout.write.bind(process.stdout);

function writeJsonLine(obj: unknown): void {
  rawStdoutWrite(JSON.stringify(obj) + '\n');
}

function redirectConsoleToStderr(): void {
  const toErr = (...args: unknown[]) => {
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    process.stderr.write(line + '\n');
  };
  console.log = toErr;
  console.info = toErr;
  console.warn = toErr;
}

function resolveDocumentsDir(): string {
  const userProfile = process.env.USERPROFILE || os.homedir();
  const docs = path.join(userProfile, 'Documents');
  return fs.existsSync(docs) ? docs : os.homedir();
}

function resolveAppVersionFallback(): string {
  if (process.env.MESAI_APP_VERSION?.trim()) {
    return process.env.MESAI_APP_VERSION.trim();
  }
  const pkgPath = path.resolve(__dirname, '../../package.json');
  try {
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    }
  } catch {
    // ignore
  }
  return '0.0.0';
}

function runDpapiHelper(mode: 'encrypt' | 'decrypt', input: string): string {
  const hostExe = process.env.MESAI_HOST_EXE?.trim();
  if (hostExe && fs.existsSync(hostExe)) {
    const flag = mode === 'encrypt' ? '--dpapi-encrypt' : '--dpapi-decrypt';
    return execFileSync(hostExe, [flag], {
      input,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000
    }).trim();
  }

  // Fallback for standalone Node runs on Windows via PowerShell ProtectedData (stdin, never argv)
  if (process.platform === 'win32') {
    const script =
      mode === 'encrypt'
        ? [
            'Add-Type -AssemblyName System.Security',
            '$plain = [Console]::In.ReadToEnd()',
            '$bytes = [Text.Encoding]::UTF8.GetBytes($plain)',
            '$enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, "CurrentUser")',
            '[Console]::Out.Write([Convert]::ToBase64String($enc))'
          ].join('; ')
        : [
            'Add-Type -AssemblyName System.Security',
            '$b64 = [Console]::In.ReadToEnd().Trim()',
            '$enc = [Convert]::FromBase64String($b64)',
            '$dec = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, "CurrentUser")',
            '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($dec))'
          ].join('; ');
    const encodedCmd = Buffer.from(script, 'utf16le').toString('base64');
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCmd], {
      input,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000
    }).trim();
  }

  throw new Error('Windows DPAPI bu platformda kullanılamıyor.');
}

async function runSmokeVerify(): Promise<void> {
  const userDataDir = resolveDefaultUserDataDir();
  const dbPath = path.join(userDataDir, 'mesai_data.sqlite');
  const database = new MesaiDatabase(dbPath);
  const repo = new MesaiRepository(database);
  const matcher = new MatcherService(repo);
  const zoomAdapter = new ZoomReaderAdapter(repo, matcher, { stateDir: userDataDir });
  const gitWatcher = new GitFileWatcherService(repo, matcher);
  const reportService = new ReportService(repo);

  const settings = repo.getSettings();
  if (settings.watchRootPath) {
    await gitWatcher.discoverGitProjects(settings.watchRootPath, false);
  }

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

  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  gitWatcher.stopAllWatchers();
  zoomAdapter.stop();
  database.close();
  process.exit(0);
}

async function main(): Promise<void> {
  if (process.argv.includes('--verify-smoke')) {
    await runSmokeVerify();
    return;
  }

  redirectConsoleToStderr();

  let nextHostReqId = 1;
  const pendingHostCalls = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
  >();

  function callHost<T = unknown>(hostMethod: string, params: unknown = null): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = `h_${nextHostReqId++}`;
      pendingHostCalls.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject
      });
      writeJsonLine({ id, hostMethod, params });
    });
  }

  const userDataDir = resolveDefaultUserDataDir();
  const resourcesDir = process.env.MESAI_RESOURCES_DIR?.trim() || path.resolve(__dirname, '../..');
  const appVersion = resolveAppVersionFallback();
  const isPackaged = process.env.MESAI_IS_PACKAGED === '1';

  const hostBridge: HostBridge = {
    getUserDataDir: () => userDataDir,
    getDocumentsDir: () => resolveDocumentsDir(),
    getTempDir: () => os.tmpdir(),
    getResourcesDir: () => resourcesDir,
    getAppVersion: () => appVersion,
    isPackaged: () => isPackaged,

    selectFolderDialog: () => callHost<string | null>('dialog:selectFolder'),
    saveFileDialog: (options: SaveFileDialogOptions) => callHost<string | null>('dialog:saveFile', options),
    openExternalUrl: async (url: string) => {
      await callHost('shell:openExternal', { url });
    },
    openPath: async (filePath: string) => {
      await callHost('shell:openPath', { path: filePath });
    },
    showNotification: (title: string, body: string) => {
      writeJsonLine({ event: 'host:notification', payload: { title, body } });
    },
    setAutoLaunch: async (enabled: boolean) => {
      await callHost('autostart:set', { enabled });
    },
    updateTaskbarAndTray: (isPaused: boolean) => {
      writeJsonLine({ event: 'host:taskbarTrayUpdate', payload: { isPaused } });
    },
    getPowerIdleState: () => callHost<PowerIdleState>('power:getIdleState'),
    emitEvent: (channel: string, payload: unknown) => {
      writeJsonLine({ event: channel, payload });
    },
    quitApp: () => {
      writeJsonLine({ event: 'host:quit', payload: null });
    },

    dpapiEncryptSync: (plainText: string) => runDpapiHelper('encrypt', plainText),
    dpapiDecryptSync: (cipherBase64: string) => runDpapiHelper('decrypt', cipherBase64)
  };

  const dpapiSecretProvider: SecretProvider = {
    encrypt: (plainText: string) => hostBridge.dpapiEncryptSync(plainText),
    decrypt: (cipherBase64: string) => hostBridge.dpapiDecryptSync(cipherBase64)
  };

  const dbPath = path.join(userDataDir, 'mesai_data.sqlite');
  const database = new MesaiDatabase(dbPath);
  const repo = new MesaiRepository(database);
  const matcher = new MatcherService(repo);
  const zoomAdapter = new ZoomReaderAdapter(repo, matcher, { stateDir: userDataDir });
  const gitWatcher = new GitFileWatcherService(repo, matcher);
  const reportService = new ReportService(repo);
  const integrations = new IntegrationsService(repo, zoomAdapter, gitWatcher, reportService, {
    userDataDir,
    secretProvider: dpapiSecretProvider,
    secretsFileName: 'mesai_credentials.tauri.dpapi.json'
  });

  const scheduler = new SchedulerService(
    repo,
    zoomAdapter,
    gitWatcher,
    (title, body) => hostBridge.showNotification(title, body),
    { getPowerIdleState: () => hostBridge.getPowerIdleState() }
  );

  const updateService = new UpdateService({
    emitStateChanged: (state) => hostBridge.emitEvent('mesai:updater:stateChanged', state),
    openExternalUrl: (url) => hostBridge.openExternalUrl(url),
    openPath: (filePath) => hostBridge.openPath(filePath),
    getTempDir: () => hostBridge.getTempDir(),
    getAppVersion: () => hostBridge.getAppVersion(),
    isPackaged: () => hostBridge.isPackaged(),
    quitApp: () => hostBridge.quitApp(),
    nativeCheck: () =>
      callHost<{ available: boolean; version?: string; body?: string; date?: string } | null>(
        'updater:nativeCheck'
      ),
    nativeDownloadAndInstall: async (onProgress?: (p: UpdateProgress) => void) => {
      // Progress events come asynchronously from Rust if native updater is active
      void onProgress;
      return callHost<boolean>('updater:nativeDownloadAndInstall');
    }
  });

  const updateAllTrackingIndicators = () => {
    const current = repo.getSettings();
    hostBridge.updateTaskbarAndTray(current.trackingPaused);
    hostBridge.emitEvent(IPC_CHANNELS.TRACKING_STATE_CHANGED, current.trackingPaused);
  };

  const rpcHandlers = createRpcHandlers({
    host: hostBridge,
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

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  let isShuttingDown = false;
  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    scheduler.stopAll();
    database.close();
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: {
      id?: string | number;
      method?: string;
      params?: unknown[];
      result?: unknown;
      error?: { message?: string };
    };
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      process.stderr.write(`[sidecar] Invalid JSON line: ${(err as Error).message}\n`);
      return;
    }

    // Response to a sidecar -> host call
    if (!msg.method && msg.id !== undefined) {
      const pending = pendingHostCalls.get(String(msg.id));
      if (pending) {
        pendingHostCalls.delete(String(msg.id));
        if (msg.error) {
          pending.reject(new Error(msg.error.message || 'Host RPC error'));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Request from host -> sidecar
    if (msg.method) {
      const reqId = msg.id;
      const method = msg.method;
      const params = Array.isArray(msg.params) ? msg.params : [];

      void (async () => {
        try {
          let result: unknown;
          if (method === 'host:power:suspend') {
            scheduler.handleSystemSuspend();
            result = true;
          } else if (method === 'host:power:resume') {
            scheduler.handleSystemResume();
            result = true;
          } else if (method === 'host:tray:toggleTracking') {
            const current = repo.getSettings();
            repo.updateSettings({ trackingPaused: !current.trackingPaused });
            scheduler.startOrReload();
            updateAllTrackingIndicators();
            result = !current.trackingPaused;
          } else if (method === 'host:tray:pollNow') {
            await zoomAdapter.pollOnce();
            await gitWatcher.pollAllProjectsGit();
            updateAllTrackingIndicators();
            result = true;
          } else if (method === 'host:shutdown') {
            shutdown();
            result = true;
            if (reqId !== undefined) writeJsonLine({ id: reqId, result });
            process.exit(0);
            return;
          } else {
            const handler = rpcHandlers.get(method);
            if (!handler) {
              throw new Error(`Bilinmeyen RPC kanalı: ${method}`);
            }
            result = await handler(...params);
          }

          if (reqId !== undefined) {
            writeJsonLine({ id: reqId, result: result === undefined ? null : result });
          }
        } catch (err) {
          if (reqId !== undefined) {
            writeJsonLine({
              id: reqId,
              error: { message: (err as Error).message || String(err) }
            });
          }
        }
      })();
    }
  });

  rl.on('close', () => {
    shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });

  // Startup tasks
  const initialSettings = repo.getSettings();
  if (initialSettings.watchRootPath) {
    try {
      await gitWatcher.discoverGitProjects(initialSettings.watchRootPath, true);
    } catch (err) {
      process.stderr.write(`[sidecar] Git project discovery error: ${(err as Error).message}\n`);
    }
  }

  updateAllTrackingIndicators();
  scheduler.startOrReload();

  if (initialSettings.autoCheckUpdatesOnStartup !== false) {
    const timer = setTimeout(() => {
      void updateService.checkForUpdates().catch(() => undefined);
    }, 5000);
    timer.unref?.();
  }

  if (!initialSettings.trackingPaused) {
    void zoomAdapter.pollOnce().catch(() => undefined);
    void gitWatcher.pollAllProjectsGit().catch(() => undefined);
  }
}

void main();
