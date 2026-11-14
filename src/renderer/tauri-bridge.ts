import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { IPC_CHANNELS, type MesaiApi } from '../shared/ipc-channels';
import type { ReportProgressLog, UpdateState } from '../shared/types';

function rpc<T>(channel: string, ...args: unknown[]): Promise<T> {
  return invoke<T>('mesai_rpc', { channel, args });
}

export function createTauriMesaiApi(): MesaiApi {
  const appWindow = getCurrentWindow();

  return {
    getDashboard: () => rpc(IPC_CHANNELS.DASHBOARD_GET),
    pollZoomNow: () => rpc(IPC_CHANNELS.ZOOM_POLL_NOW),
    pollGitNow: () => rpc(IPC_CHANNELS.GIT_POLL_NOW),
    setTrackingPaused: (paused) => rpc(IPC_CHANNELS.TRACKING_SET_PAUSED, paused),

    listProjects: () => rpc(IPC_CHANNELS.PROJECTS_LIST),
    scanRootForProjects: (rootPath) => rpc(IPC_CHANNELS.PROJECTS_SCAN_ROOT, rootPath),
    selectFolderDialog: () => rpc(IPC_CHANNELS.PROJECTS_SELECT_FOLDER),
    updateProject: (project) => rpc(IPC_CHANNELS.PROJECTS_UPDATE, project),

    listActivities: (filter) => rpc(IPC_CHANNELS.ACTIVITIES_LIST, filter),
    addManualNote: (input) => rpc(IPC_CHANNELS.ACTIVITIES_ADD_NOTE, input),
    getEvidenceById: (evidenceId) => rpc(IPC_CHANNELS.EVIDENCE_GET, evidenceId),
    updateActivityLink: (input) => rpc(IPC_CHANNELS.MATCH_UPDATE_LINK, input),
    listWorkItems: () => rpc(IPC_CHANNELS.WORK_ITEMS_LIST),

    getDailyReport: (reportDate) => rpc(IPC_CHANNELS.REPORT_GET, reportDate),
    previewAiPayload: (reportDate, maxChars, providerOverride, modelOverride, fastLocal) =>
      rpc(IPC_CHANNELS.REPORT_PREVIEW_AI, reportDate, maxChars, providerOverride, modelOverride, fastLocal),
    generateDailyReport: (input) => rpc(IPC_CHANNELS.REPORT_GENERATE, input),
    updateReportItem: (input) => rpc(IPC_CHANNELS.REPORT_UPDATE_ITEM, input),
    addReportItem: (input) => rpc(IPC_CHANNELS.REPORT_ADD_ITEM, input),
    deleteReportItem: (itemId) => rpc(IPC_CHANNELS.REPORT_DELETE_ITEM, itemId),
    removeReportJiraKey: (reportDate, jiraKey) =>
      rpc(IPC_CHANNELS.REPORT_REMOVE_JIRA_KEY, reportDate, jiraKey),
    resetReportJiraKeys: (reportDate) => rpc(IPC_CHANNELS.REPORT_RESET_JIRA_KEYS, reportDate),
    approveReport: (reportId, notes) => rpc(IPC_CHANNELS.REPORT_APPROVE, reportId, notes),
    onReportProgress: (callback) => {
      let unlistenFn: (() => void) | null = null;
      let active = true;
      void listen<ReportProgressLog>(IPC_CHANNELS.REPORT_PROGRESS, (event) => {
        if (active) callback(event.payload);
      }).then((unsub) => {
        if (active) unlistenFn = unsub;
        else unsub();
      });
      return () => {
        active = false;
        unlistenFn?.();
      };
    },
    exportReport: (input) => rpc(IPC_CHANNELS.REPORT_EXPORT, input),

    getIntegrationsHealth: () => rpc(IPC_CHANNELS.INTEGRATIONS_HEALTH),
    saveIntegrationSecret: (input) => rpc(IPC_CHANNELS.INTEGRATIONS_SAVE_SECRET, input),
    testIntegrationConnection: (service) => rpc(IPC_CHANNELS.INTEGRATIONS_TEST_CONNECTION, service),
    saveAiApiKey: (input) => rpc(IPC_CHANNELS.AI_SAVE_KEY, input),
    testAiConnection: (provider) => rpc(IPC_CHANNELS.AI_TEST_CONNECTION, provider),
    fetchAiModels: (input) => rpc(IPC_CHANNELS.AI_FETCH_MODELS, input),
    installCli: (provider) => rpc(IPC_CHANNELS.AI_INSTALL_CLI, provider),
    authCli: (provider) => rpc(IPC_CHANNELS.AI_AUTH_CLI, provider),

    getSettings: () => rpc(IPC_CHANNELS.SETTINGS_GET),
    updateSettings: (partial) => rpc(IPC_CHANNELS.SETTINGS_UPDATE, partial),
    clearAllData: () => rpc(IPC_CHANNELS.DATA_CLEAR_ALL),

    getUpdateState: () => rpc(IPC_CHANNELS.UPDATER_GET_STATE),
    checkForUpdates: () => rpc(IPC_CHANNELS.UPDATER_CHECK),
    downloadUpdate: () => rpc(IPC_CHANNELS.UPDATER_DOWNLOAD),
    quitAndInstallUpdate: () => rpc(IPC_CHANNELS.UPDATER_INSTALL),
    onUpdateStateChanged: (callback) => {
      let unlistenFn: (() => void) | null = null;
      let active = true;
      void listen<UpdateState>('mesai:updater:stateChanged', (event) => {
        if (active) callback(event.payload);
      }).then((unsub) => {
        if (active) unlistenFn = unsub;
        else unsub();
      });
      return () => {
        active = false;
        unlistenFn?.();
      };
    },

    minimizeWindow: () => appWindow.minimize(),
    maximizeWindow: async () => {
      await appWindow.toggleMaximize();
      return appWindow.isMaximized();
    },
    closeWindow: () => appWindow.close(),
    isWindowMaximized: () => appWindow.isMaximized(),
    onMaximizeChanged: (callback) => {
      let unlistenFn: (() => void) | null = null;
      let active = true;
      void listen<boolean>('mesai:window:maximizeChanged', (event) => {
        if (active) callback(Boolean(event.payload));
      }).then((unsub) => {
        if (active) unlistenFn = unsub;
        else unsub();
      });
      return () => {
        active = false;
        unlistenFn?.();
      };
    },
    onTrackingStateChanged: (callback) => {
      let unlistenFn: (() => void) | null = null;
      let active = true;
      void listen<boolean>(IPC_CHANNELS.TRACKING_STATE_CHANGED, (event) => {
        if (active) callback(Boolean(event.payload));
      }).then((unsub) => {
        if (active) unlistenFn = unsub;
        else unsub();
      });
      return () => {
        active = false;
        unlistenFn?.();
      };
    },
    openExternalUrl: (url: string) => rpc(IPC_CHANNELS.OPEN_EXTERNAL_URL, url)
  };
}
