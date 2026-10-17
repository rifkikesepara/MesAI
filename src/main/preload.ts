import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type MesaiApi } from '../shared/ipc-channels';

const mesaiApi: MesaiApi = {
  getDashboard: () => ipcRenderer.invoke(IPC_CHANNELS.DASHBOARD_GET),
  pollZoomNow: () => ipcRenderer.invoke(IPC_CHANNELS.ZOOM_POLL_NOW),
  pollGitNow: () => ipcRenderer.invoke(IPC_CHANNELS.GIT_POLL_NOW),
  setTrackingPaused: (paused) => ipcRenderer.invoke(IPC_CHANNELS.TRACKING_SET_PAUSED, paused),

  listProjects: () => ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_LIST),
  scanRootForProjects: (rootPath) => ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_SCAN_ROOT, rootPath),
  selectFolderDialog: () => ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_SELECT_FOLDER),
  updateProject: (project) => ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_UPDATE, project),

  listActivities: (filter) => ipcRenderer.invoke(IPC_CHANNELS.ACTIVITIES_LIST, filter),
  addManualNote: (input) => ipcRenderer.invoke(IPC_CHANNELS.ACTIVITIES_ADD_NOTE, input),
  getEvidenceById: (evidenceId) => ipcRenderer.invoke(IPC_CHANNELS.EVIDENCE_GET, evidenceId),
  updateActivityLink: (input) => ipcRenderer.invoke(IPC_CHANNELS.MATCH_UPDATE_LINK, input),
  listWorkItems: () => ipcRenderer.invoke(IPC_CHANNELS.WORK_ITEMS_LIST),

  getDailyReport: (reportDate) => ipcRenderer.invoke(IPC_CHANNELS.REPORT_GET, reportDate),
  previewAiPayload: (reportDate, maxChars) =>
    ipcRenderer.invoke(IPC_CHANNELS.REPORT_PREVIEW_AI, reportDate, maxChars),
  generateDailyReport: (input) => ipcRenderer.invoke(IPC_CHANNELS.REPORT_GENERATE, input),
  updateReportItem: (input) => ipcRenderer.invoke(IPC_CHANNELS.REPORT_UPDATE_ITEM, input),
  addReportItem: (input) => ipcRenderer.invoke(IPC_CHANNELS.REPORT_ADD_ITEM, input),
  deleteReportItem: (itemId) => ipcRenderer.invoke(IPC_CHANNELS.REPORT_DELETE_ITEM, itemId),
  approveReport: (reportId, notes) => ipcRenderer.invoke(IPC_CHANNELS.REPORT_APPROVE, reportId, notes),
  exportReport: (input) => ipcRenderer.invoke(IPC_CHANNELS.REPORT_EXPORT, input),

  getIntegrationsHealth: () => ipcRenderer.invoke(IPC_CHANNELS.INTEGRATIONS_HEALTH),
  saveIntegrationSecret: (input) => ipcRenderer.invoke(IPC_CHANNELS.INTEGRATIONS_SAVE_SECRET, input),
  testIntegrationConnection: (service) => ipcRenderer.invoke(IPC_CHANNELS.INTEGRATIONS_TEST_CONNECTION, service),

  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
  updateSettings: (partial) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE, partial),
  clearAllData: () => ipcRenderer.invoke(IPC_CHANNELS.DATA_CLEAR_ALL),

  getUpdateState: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_GET_STATE),
  checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_CHECK),
  downloadUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_DOWNLOAD),
  quitAndInstallUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_INSTALL),
  onUpdateStateChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => {
      callback(state as any);
    };
    ipcRenderer.on('mesai:updater:stateChanged', handler);
    return () => {
      ipcRenderer.removeListener('mesai:updater:stateChanged', handler);
    };
  },

  minimizeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
  maximizeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MAXIMIZE),
  closeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),
  isWindowMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
  onMaximizeChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, isMaximized: unknown) => {
      callback(Boolean(isMaximized));
    };
    ipcRenderer.on('mesai:window:maximizeChanged', handler);
    return () => {
      ipcRenderer.removeListener('mesai:window:maximizeChanged', handler);
    };
  },
  onTrackingStateChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, isPaused: unknown) => {
      callback(Boolean(isPaused));
    };
    ipcRenderer.on(IPC_CHANNELS.TRACKING_STATE_CHANGED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TRACKING_STATE_CHANGED, handler);
    };
  },
  openExternalUrl: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, url)
};

contextBridge.exposeInMainWorld('mesaiApi', mesaiApi);
