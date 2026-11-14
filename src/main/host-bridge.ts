import os from 'node:os';
import path from 'node:path';

export interface SaveFileDialogOptions {
  title: string;
  defaultPath: string;
  filters: Array<{ name: string; extensions: string[] }>;
}

export interface PowerIdleState {
  onBattery: boolean;
  idleSeconds: number;
}

export interface HostBridge {
  getUserDataDir(): string;
  getDocumentsDir(): string;
  getTempDir(): string;
  getResourcesDir(): string;
  getAppVersion(): string;
  isPackaged(): boolean;

  selectFolderDialog(): Promise<string | null>;
  saveFileDialog(options: SaveFileDialogOptions): Promise<string | null>;
  openExternalUrl(url: string): Promise<void>;
  openPath(filePath: string): Promise<void>;
  showNotification(title: string, body: string): void;
  setAutoLaunch(enabled: boolean): Promise<void>;
  updateTaskbarAndTray(isPaused: boolean): void;
  getPowerIdleState(): Promise<PowerIdleState>;
  emitEvent(channel: string, payload: unknown): void;
  quitApp(): void;

  dpapiEncryptSync(plainText: string): string;
  dpapiDecryptSync(cipherBase64: string): string;
}

export function resolveDefaultUserDataDir(): string {
  if (process.env.MESAI_USER_DATA_DIR && process.env.MESAI_USER_DATA_DIR.trim()) {
    return process.env.MESAI_USER_DATA_DIR.trim();
  }
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'MesAI');
}
