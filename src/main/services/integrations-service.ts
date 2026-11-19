import fs from 'node:fs';
import path from 'node:path';
import { extractJiraKeysFromText, type MesaiRepository } from '../db/repositories';
import type { ZoomReaderAdapter } from './zoom-adapter';
import type { GitFileWatcherService } from './git-file-watcher';
import type { ReportService } from './report-service';
import {
  OpenAiApiProvider,
  AnthropicApiProvider,
  CodexCliProvider,
  ClaudeCliProvider,
  OllamaCliProvider,
  formatCorporateProjectName
} from './ai-provider';
import type {
  Activity,
  AppSettings,
  GitLabMrReviewContext,
  GitLabReviewedMrItem,
  GitLabSyncReviewsResult,
  IntegrationHealth,
  ZoomReaderStatus
} from '../../shared/types';
import { toLocalIsoString } from './timestamp-resolver';

function shiftIsoDate(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, (d || 1) + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function extractGitLabProjectPath(repositoryUrl: string | null | undefined): string | null {
  if (!repositoryUrl || !repositoryUrl.trim()) return null;
  const raw = repositoryUrl.trim();
  try {
    if (/^(?:https?|ssh):\/\//i.test(raw)) {
      const parsed = new URL(raw);
      const cleanPath = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
      return cleanPath || null;
    }
  } catch {
    // fallback to regex below
  }
  const scpMatch = raw.match(/^[^@]+@[^:]+:(.+)$/);
  if (scpMatch && scpMatch[1]) {
    const cleanPath = scpMatch[1].replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    return cleanPath || null;
  }
  return null;
}

export interface SecretProvider {
  encrypt(plainText: string): string;
  decrypt(cipherBase64: string): string;
}

export class IntegrationsService {
  private readonly secretsFilePath: string;
  private readonly secretProvider: SecretProvider;
  private readonly gitlabMrCache = new Map<
    string,
    { timestamp: number; signature: string; data: Record<string, GitLabMrReviewContext> }
  >();
  private readonly gitlabReviewerDaySyncedAt = new Map<string, number>();
  private gitlabCurrentUsername: string | null = null;
  private readonly jiraKeySyncedAt = new Map<string, number>();
  private gitlabUnreachableUntil = 0;
  private jiraUnreachableUntil = 0;

  constructor(
    private readonly repo: MesaiRepository,
    private readonly zoomAdapter: ZoomReaderAdapter,
    private readonly gitWatcher: GitFileWatcherService,
    private readonly reportService: ReportService,
    options?: { userDataDir?: string; secretProvider?: SecretProvider; secretsFileName?: string }
  ) {
    const dir = options?.userDataDir ?? process.cwd();
    const fileName = options?.secretsFileName ?? 'mesai_credentials.dpapi.json';
    this.secretsFilePath = path.join(dir, fileName);
    this.secretProvider = options?.secretProvider ?? this.createDefaultSecretProvider();
    this.reportService.setJiraIssueSyncer((keys) => this.syncJiraIssuesIfConfigured(keys));
    this.reportService.setGitLabMrSyncer((date, acts) => this.resolveGitLabMrReviewsIfConfigured(date, acts));
    this.reportService.setCachedGitLabMrSyncer((date) => this.getCachedGitLabMrReviews(date));
    this.reportService.setAiApiKeyResolver((prov) => this.getDecryptedAiToken(prov));
  }

  public getCachedGitLabMrReviews(reportDate: string): Record<string, GitLabMrReviewContext> {
    const entry = this.gitlabMrCache.get(reportDate);
    if (!entry) return {};
    return entry.data;
  }

  private createDefaultSecretProvider(): SecretProvider {
    return {
      encrypt: () => {
        throw new Error('OS güvenli şifreleme (Windows DPAPI) sağlayıcısı başlatılmadı.');
      },
      decrypt: () => {
        throw new Error('OS güvenli şifreleme (Windows DPAPI) sağlayıcısı başlatılmadı.');
      }
    };
  }

  private readEncryptedStore(): Record<string, string> {
    if (!fs.existsSync(this.secretsFilePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.secretsFilePath, 'utf8'));
    } catch {
      return {};
    }
  }

  private writeEncryptedStore(data: Record<string, string>): void {
    const dir = path.dirname(this.secretsFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.secretsFilePath, JSON.stringify(data, null, 2), 'utf8');
  }

  /**
   * Saves Jira, GitLab, or Jenkins URL/username in settings and encrypts the token via OS DPAPI (never plaintext in SQLite).
   */
  public saveIntegrationCredential(input: {
    service: 'jira' | 'gitlab' | 'jenkins';
    url: string;
    usernameOrEmail: string;
    token: string;
  }): void {
    const cleanUrl = input.url.trim().replace(/\/+$/, '');
    const cleanUser = input.usernameOrEmail.trim();

    if (input.service === 'jira') {
      this.repo.updateSettings({ jiraUrl: cleanUrl, jiraEmail: cleanUser });
      this.jiraUnreachableUntil = 0;
      this.jiraKeySyncedAt.clear();
      this.cachedJiraMyself = null;
    } else if (input.service === 'gitlab') {
      this.repo.updateSettings({ gitlabUrl: cleanUrl, gitlabUsername: cleanUser });
      this.gitlabUnreachableUntil = 0;
      this.gitlabMrCache.clear();
      this.gitlabReviewerDaySyncedAt.clear();
      this.gitlabCurrentUsername = null;
    } else {
      this.repo.updateSettings({ jenkinsUrl: cleanUrl, jenkinsUsername: cleanUser });
    }

    if (input.token.trim()) {
      const store = this.readEncryptedStore();
      store[`${input.service}_token`] = this.secretProvider.encrypt(input.token.trim());
      this.writeEncryptedStore(store);
    }

    // Mark as untested until an actual connection test succeeds
    this.repo.updateSyncState({
      connector: input.service,
      status: cleanUrl ? 'untested' : 'not_configured',
      lastError: null
    });
  }

  public hasEncryptedToken(service: 'jira' | 'gitlab' | 'jenkins'): boolean {
    const store = this.readEncryptedStore();
    return Boolean(store[`${service}_token`]);
  }

  private getDecryptedToken(service: 'jira' | 'gitlab' | 'jenkins'): string | null {
    const store = this.readEncryptedStore();
    const enc = store[`${service}_token`];
    if (!enc) return null;
    try {
      return this.secretProvider.decrypt(enc);
    } catch {
      return null;
    }
  }

  public saveAiCredential(input: {
    provider: 'gemini_cli' | 'openai' | 'anthropic' | 'custom';
    apiKey?: string;
    model?: string;
    customBaseUrl?: string;
    clearKey?: boolean;
    mode?: 'auto' | 'cli' | 'api';
  }): void {
    const store = this.readEncryptedStore();
    const cleanKey = input.apiKey?.trim();
    if (input.provider !== 'gemini_cli') {
      if (cleanKey) {
        store[`${input.provider}_token`] = this.secretProvider.encrypt(cleanKey);
        this.writeEncryptedStore(store);
      } else if (input.clearKey) {
        delete store[`${input.provider}_token`];
        this.writeEncryptedStore(store);
      }
    }

    const updates: Partial<AppSettings> = {
      aiProvider: input.provider
    };
    if (input.provider === 'gemini_cli') {
      if (input.model !== undefined) updates.aiGeminiModel = input.model.trim();
      if (input.model) updates.aiModel = input.model.trim();
    } else if (input.provider === 'openai') {
      if (input.model !== undefined) updates.aiOpenaiModel = input.model.trim();
      if (input.customBaseUrl !== undefined) updates.aiOpenaiBaseUrl = input.customBaseUrl.trim();
      if (input.mode !== undefined) updates.aiOpenaiMode = input.mode;
      if (input.model) updates.aiModel = input.model.trim();
    } else if (input.provider === 'anthropic') {
      if (input.model !== undefined) updates.aiAnthropicModel = input.model.trim();
      if (input.mode !== undefined) updates.aiAnthropicMode = input.mode;
      if (input.model) updates.aiModel = input.model.trim();
    } else if (input.provider === 'custom') {
      if (input.model !== undefined) updates.aiCustomModel = input.model.trim();
      if (input.customBaseUrl !== undefined) updates.aiCustomBaseUrl = input.customBaseUrl.trim();
      if (input.mode !== undefined) updates.aiCustomMode = input.mode;
      if (input.model) updates.aiModel = input.model.trim();
    }

    this.repo.updateSettings(updates);
  }

  public hasEncryptedAiToken(provider: 'openai' | 'anthropic' | 'custom'): boolean {
    const store = this.readEncryptedStore();
    return Boolean(store[`${provider}_token`]);
  }

  public getDecryptedAiToken(provider: 'openai' | 'anthropic' | 'custom'): string | null {
    const store = this.readEncryptedStore();
    const enc = store[`${provider}_token`];
    if (!enc) return null;
    try {
      return this.secretProvider.decrypt(enc);
    } catch {
      return null;
    }
  }

  public async testAiConnection(provider: 'openai' | 'anthropic' | 'custom'): Promise<{ ok: boolean; message: string }> {
    const settings = this.repo.getSettings();
    const token = this.getDecryptedAiToken(provider);

    if (provider === 'openai') {
      const isCliMode =
        settings.aiOpenaiMode === 'cli' ||
        (settings.aiOpenaiMode !== 'api' && (!token || Boolean(CodexCliProvider.resolveCodexCliPath())));
      if (isCliMode && CodexCliProvider.resolveCodexCliPath()) {
        const codex = new CodexCliProvider({ model: settings.aiOpenaiModel });
        const h = await codex.checkHealth();
        if (h.installed) {
          return { ok: true, message: `Yerel OpenAI / Codex CLI hazır (${h.version}). API anahtarı gerekmez.` };
        }
      }
      const p = new OpenAiApiProvider({
        providerType: 'openai',
        apiKeyResolver: () => token,
        model: settings.aiOpenaiModel || settings.aiModel,
        customBaseUrl: settings.aiOpenaiBaseUrl
      });
      return p.testConnection();
    } else if (provider === 'anthropic') {
      const isCliMode =
        settings.aiAnthropicMode === 'cli' ||
        (settings.aiAnthropicMode !== 'api' && (!token && Boolean(ClaudeCliProvider.resolveClaudeCliPath())));
      if (isCliMode && ClaudeCliProvider.resolveClaudeCliPath()) {
        const claude = new ClaudeCliProvider({ model: settings.aiAnthropicModel });
        const h = await claude.checkHealth();
        if (h.installed) {
          return { ok: true, message: `Yerel Claude Code CLI hazır (${h.version}). API anahtarı gerekmez.` };
        }
      }
      const p = new AnthropicApiProvider({
        apiKeyResolver: () => token,
        model: settings.aiAnthropicModel || settings.aiModel
      });
      return p.testConnection();
    } else {
      const isCliMode =
        settings.aiCustomMode === 'cli' ||
        (settings.aiCustomMode !== 'api' && (!settings.aiCustomBaseUrl && Boolean(OllamaCliProvider.resolveOllamaCliPath())));
      if (isCliMode && OllamaCliProvider.resolveOllamaCliPath()) {
        const ollama = new OllamaCliProvider({ model: settings.aiCustomModel });
        const h = await ollama.checkHealth();
        if (h.installed) {
          return { ok: true, message: `Yerel Ollama CLI hazır (${h.version}). API anahtarı gerekmez.` };
        }
      }
      const p = new OpenAiApiProvider({
        providerType: 'custom',
        apiKeyResolver: () => token,
        model: settings.aiCustomModel || settings.aiModel,
        customBaseUrl: settings.aiCustomBaseUrl
      });
      return p.testConnection();
    }
  }

  public async fetchAiModels(input: {
    provider: 'gemini_cli' | 'openai' | 'anthropic' | 'custom';
    apiKey?: string;
    customBaseUrl?: string;
  }): Promise<{ ok: boolean; models: string[]; error?: string }> {
    if (input.provider === 'gemini_cli') {
      return this.reportService.getGeminiProvider().fetchAvailableModels();
    }
    const prov = input.provider;
    const keyResolver = () => (input.apiKey && input.apiKey.trim() ? input.apiKey.trim() : this.getDecryptedAiToken(prov));
    const settings = this.repo.getSettings();
    if (prov === 'openai') {
      const token = this.getDecryptedAiToken('openai');
      const isCli =
        settings.aiOpenaiMode === 'cli' ||
        (settings.aiOpenaiMode !== 'api' && (!token || Boolean(CodexCliProvider.resolveCodexCliPath())));
      if (isCli && CodexCliProvider.resolveCodexCliPath() && !input.apiKey?.trim()) {
        return {
          ok: true,
          models: ['gpt-6.1-sol', '6.1sol', 'gpt-4o', 'gpt-4o-mini', 'o3-mini', 'o1-mini', 'o1-preview']
        };
      }
      const p = new OpenAiApiProvider({
        providerType: 'openai',
        apiKeyResolver: keyResolver,
        customBaseUrl: input.customBaseUrl ?? settings.aiOpenaiBaseUrl
      });
      return p.fetchAvailableModels();
    } else if (input.provider === 'anthropic') {
      const token = this.getDecryptedAiToken('anthropic');
      const isCli =
        settings.aiAnthropicMode === 'cli' ||
        (settings.aiAnthropicMode !== 'api' && (!token && Boolean(ClaudeCliProvider.resolveClaudeCliPath())));
      if (isCli && ClaudeCliProvider.resolveClaudeCliPath() && !input.apiKey?.trim()) {
        return {
          ok: true,
          models: ['claude-3-7-sonnet', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229']
        };
      }
      const p = new AnthropicApiProvider({
        apiKeyResolver: keyResolver,
        model: settings.aiAnthropicModel
      });
      return p.fetchAvailableModels();
    } else {
      const isCli =
        settings.aiCustomMode === 'cli' ||
        (settings.aiCustomMode !== 'api' && !settings.aiCustomBaseUrl && Boolean(OllamaCliProvider.resolveOllamaCliPath()));
      if (isCli && OllamaCliProvider.resolveOllamaCliPath() && !input.customBaseUrl?.trim()) {
        return {
          ok: true,
          models: ['llama3.2', 'llama3.1', 'deepseek-r1', 'qwen2.5-coder:7b', 'mistral', 'phi4']
        };
      }
      const p = new OpenAiApiProvider({
        providerType: 'custom',
        apiKeyResolver: keyResolver,
        customBaseUrl: input.customBaseUrl ?? settings.aiCustomBaseUrl
      });
      return p.fetchAvailableModels();
    }
  }

  /**
   * Performs a real, read-only connection test against Jira or Jenkins.
   * Never reports "connected" unless an actual HTTP 200 response is verified.
   */
  public async testConnection(service: 'jira' | 'gitlab' | 'jenkins'): Promise<{ ok: boolean; message: string }> {
    const settings = this.repo.getSettings();
    const attemptAt = new Date().toISOString();
    const token = this.getDecryptedToken(service);

    if (service === 'jira') {
      if (!settings.jiraUrl || !settings.jiraEmail || !token) {
        const msg = 'Jira URL, e-posta veya API anahtarı yapılandırılmadı.';
        this.repo.updateSyncState({
          connector: 'jira',
          status: 'not_configured',
          lastAttemptAt: attemptAt,
          lastError: msg
        });
        return { ok: false, message: msg };
      }

      try {
        const auth = Buffer.from(`${settings.jiraEmail}:${token}`, 'utf8').toString('base64');
        const resp = await fetch(`${settings.jiraUrl}/rest/api/2/myself`, {
          method: 'GET',
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: 'application/json'
          },
          signal: AbortSignal.timeout(10_000)
        });

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }
        const data = (await resp.json()) as { displayName?: string };
        const msg = `Jira bağlantısı doğrulandı (${data.displayName || settings.jiraEmail}).`;
        this.repo.updateSyncState({
          connector: 'jira',
          status: 'connected',
          lastAttemptAt: attemptAt,
          lastSuccessAt: attemptAt,
          lastError: null
        });
        return { ok: true, message: msg };
      } catch (err) {
        const msg = `Jira bağlantı hatası: ${(err as Error).message}`;
        this.repo.updateSyncState({
          connector: 'jira',
          status: 'error',
          lastAttemptAt: attemptAt,
          lastError: msg
        });
        return { ok: false, message: msg };
      }
    } else if (service === 'gitlab') {
      if (!settings.gitlabUrl || !token) {
        const msg = 'GitLab URL veya Personal Access Token yapılandırılmadı.';
        this.repo.updateSyncState({
          connector: 'gitlab',
          status: 'not_configured',
          lastAttemptAt: attemptAt,
          lastError: msg
        });
        return { ok: false, message: msg };
      }

      try {
        const resp = await fetch(`${settings.gitlabUrl}/api/v4/user`, {
          method: 'GET',
          headers: {
            'PRIVATE-TOKEN': token,
            Accept: 'application/json'
          },
          signal: AbortSignal.timeout(10_000)
        });

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }
        const data = (await resp.json()) as { name?: string; username?: string };
        const userDisplay = data.name || data.username || settings.gitlabUsername || 'GitLab Kullanıcısı';
        const msg = `GitLab salt-okunur bağlantısı doğrulandı (${userDisplay}).`;
        this.repo.updateSyncState({
          connector: 'gitlab',
          status: 'connected',
          lastAttemptAt: attemptAt,
          lastSuccessAt: attemptAt,
          lastError: null
        });
        return { ok: true, message: msg };
      } catch (err) {
        const msg = `GitLab bağlantı hatası: ${(err as Error).message}`;
        this.repo.updateSyncState({
          connector: 'gitlab',
          status: 'error',
          lastAttemptAt: attemptAt,
          lastError: msg
        });
        return { ok: false, message: msg };
      }
    } else {
      if (!settings.jenkinsUrl || !settings.jenkinsUsername || !token) {
        const msg = 'Jenkins URL, kullanıcı adı veya API token yapılandırılmadı.';
        this.repo.updateSyncState({
          connector: 'jenkins',
          status: 'not_configured',
          lastAttemptAt: attemptAt,
          lastError: msg
        });
        return { ok: false, message: msg };
      }

      try {
        const auth = Buffer.from(`${settings.jenkinsUsername}:${token}`, 'utf8').toString('base64');
        const resp = await fetch(`${settings.jenkinsUrl}/api/json?tree=jobs[name,color]`, {
          method: 'GET',
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: 'application/json'
          },
          signal: AbortSignal.timeout(10_000)
        });

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }
        const msg = 'Jenkins salt-okunur bağlantısı doğrulandı.';
        this.repo.updateSyncState({
          connector: 'jenkins',
          status: 'connected',
          lastAttemptAt: attemptAt,
          lastSuccessAt: attemptAt,
          lastError: null
        });
        return { ok: true, message: msg };
      } catch (err) {
        const msg = `Jenkins bağlantı hatası: ${(err as Error).message}`;
        this.repo.updateSyncState({
          connector: 'jenkins',
          status: 'error',
          lastAttemptAt: attemptAt,
          lastError: msg
        });
        return { ok: false, message: msg };
      }
    }
  }

  public async getHealthSummary(): Promise<IntegrationHealth> {
    const settings = this.repo.getSettings();
    const zoomSync = this.repo.getSyncState('zoom_reader');
    const gitSync = this.repo.getSyncState('git_watcher');
    const aiSync = this.repo.getSyncState('ai_provider');
    const jiraSync = this.repo.getSyncState('jira');
    const gitlabSync = this.repo.getSyncState('gitlab');
    const jenkinsSync = this.repo.getSyncState('jenkins');

    const exePath = this.zoomAdapter.resolveExecutablePath();
    const exeExists = fs.existsSync(exePath);
    const gitVersion = await this.gitWatcher.getGitVersion();
    const geminiHealth = await this.reportService.getGeminiProvider().checkHealth();
    const codexHealth = await new CodexCliProvider().checkHealth();
    const claudeHealth = await new ClaudeCliProvider().checkHealth();
    const ollamaHealth = await new OllamaCliProvider().checkHealth();
    const enabledProjects = this.repo.listProjects().filter((p) => p.enabled).length;

    const jiraConfigured = Boolean(settings.jiraUrl && settings.jiraEmail && this.hasEncryptedToken('jira'));
    const gitlabConfigured = Boolean(settings.gitlabUrl && this.hasEncryptedToken('gitlab'));
    const jenkinsConfigured = Boolean(settings.jenkinsUrl && settings.jenkinsUsername && this.hasEncryptedToken('jenkins'));
    const openaiConfigured = this.hasEncryptedAiToken('openai');
    const anthropicConfigured = this.hasEncryptedAiToken('anthropic');
    const customConfigured = this.hasEncryptedAiToken('custom') || Boolean(settings.aiCustomBaseUrl);

    return {
      zoom: {
        status: (zoomSync?.status as ZoomReaderStatus) ?? 'idle',
        lastSuccessAt: zoomSync?.lastSuccessAt ?? null,
        lastAttemptAt: zoomSync?.lastAttemptAt ?? null,
        lastError: zoomSync?.lastError ?? null,
        activeChatName: (zoomSync?.metadata?.activeChatName as string) ?? null,
        windowState: (zoomSync?.metadata?.windowState as string) ?? null,
        recordsCount: zoomSync?.recordsCount ?? 0,
        executablePath: exePath,
        executableExists: exeExists,
        limitations: this.zoomAdapter.getDefaultLimitations()
      },
      git: {
        status: gitVersion ? (gitSync?.status ?? 'ready') : 'error',
        gitVersion,
        watchedProjectsCount: enabledProjects,
        lastSuccessAt: gitSync?.lastSuccessAt ?? null,
        lastError: gitSync?.lastError ?? (gitVersion ? null : 'Git CLI bulunamadı.')
      },
      ai: {
        activeProvider: settings.aiProvider,
        localRuleAvailable: true,
        geminiCliInstalled: geminiHealth.installed,
        geminiCliVersion: geminiHealth.version,
        geminiModel: settings.aiGeminiModel || 'gemini-4-argon-medium',
        openaiConfigured,
        openaiModel: settings.aiOpenaiModel || settings.aiModel || 'gpt-4o-mini',
        openaiBaseUrl: settings.aiOpenaiBaseUrl || '',
        openaiCliInstalled: codexHealth.installed,
        openaiCliVersion: codexHealth.version,
        openaiMode: settings.aiOpenaiMode || 'auto',
        anthropicConfigured,
        anthropicModel: settings.aiAnthropicModel || settings.aiModel || 'claude-3-5-sonnet-20241022',
        anthropicCliInstalled: claudeHealth.installed,
        anthropicCliVersion: claudeHealth.version,
        anthropicMode: settings.aiAnthropicMode || 'auto',
        customConfigured,
        customModel: settings.aiCustomModel || settings.aiModel || '',
        customBaseUrl: settings.aiCustomBaseUrl || '',
        customCliInstalled: ollamaHealth.installed,
        customCliVersion: ollamaHealth.version,
        customMode: settings.aiCustomMode || 'auto',
        remoteAiAllowed: settings.allowRemoteAiSend,
        lastError: aiSync?.lastError ?? null
      },
      jira: {
        configured: jiraConfigured,
        url: settings.jiraUrl,
        status: !jiraConfigured
          ? 'not_configured'
          : ((jiraSync?.status as 'connected' | 'error' | 'untested') ?? 'untested'),
        lastTestedAt: jiraSync?.lastAttemptAt ?? null,
        lastError: jiraSync?.lastError ?? null
      },
      gitlab: {
        configured: gitlabConfigured,
        url: settings.gitlabUrl,
        status: !gitlabConfigured
          ? 'not_configured'
          : ((gitlabSync?.status as 'connected' | 'error' | 'untested') ?? 'untested'),
        lastTestedAt: gitlabSync?.lastAttemptAt ?? null,
        lastError: gitlabSync?.lastError ?? null
      },
      jenkins: {
        configured: jenkinsConfigured,
        url: settings.jenkinsUrl,
        status: !jenkinsConfigured
          ? 'not_configured'
          : ((jenkinsSync?.status as 'connected' | 'error' | 'untested') ?? 'untested'),
        lastTestedAt: jenkinsSync?.lastAttemptAt ?? null,
        lastError: jenkinsSync?.lastError ?? null
      }
    };
  }

  private cachedJiraMyself: Record<string, string> | null = null;

  public async getJiraMyself(): Promise<Record<string, string> | null> {
    if (this.cachedJiraMyself) return this.cachedJiraMyself;
    if (Date.now() < this.jiraUnreachableUntil) return null;
    const settings = this.repo.getSettings();
    const token = this.getDecryptedToken('jira');
    if (!settings.jiraUrl || !settings.jiraEmail || !token) return null;

    try {
      const auth = Buffer.from(`${settings.jiraEmail}:${token}`, 'utf8').toString('base64');
      const resp = await fetch(`${settings.jiraUrl}/rest/api/2/myself`, {
        method: 'GET',
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(2_500)
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as Record<string, string>;
      this.cachedJiraMyself = data;
      return data;
    } catch {
      this.jiraUnreachableUntil = Date.now() + 60_000;
      return null;
    }
  }

  /**
   * Fetches read-only issue summary, description, and assignee history from Jira REST API
   * for the given keys when Jira credentials are configured, storing them in local `work_items`.
   * Checks whether the authenticated user was EVER assigned to this issue (currently or in history changelog).
   */
  public async syncJiraIssuesIfConfigured(jiraKeys: string[]): Promise<void> {
    if (!jiraKeys || jiraKeys.length === 0) return;
    if (Date.now() < this.jiraUnreachableUntil) return;
    const settings = this.repo.getSettings();
    const token = this.getDecryptedToken('jira');
    if (!settings.jiraUrl || !settings.jiraEmail || !token) return;

    const nowMs = Date.now();
    const uniqueKeys = Array.from(new Set(jiraKeys.map((k) => k.trim().toUpperCase()).filter(Boolean))).filter(
      (k) => nowMs - (this.jiraKeySyncedAt.get(k) ?? 0) > 10 * 60_000
    );
    if (uniqueKeys.length === 0) return;

    const auth = Buffer.from(`${settings.jiraEmail}:${token}`, 'utf8').toString('base64');

    const myself = await this.getJiraMyself();
    if (Date.now() < this.jiraUnreachableUntil) return;

    const userIdentifiers = new Set<string>();
    if (settings.jiraEmail) {
      userIdentifiers.add(settings.jiraEmail.toLowerCase().trim());
      const localPart = settings.jiraEmail.split('@')[0].toLowerCase().trim();
      if (localPart) userIdentifiers.add(localPart);
    }
    if (myself) {
      for (const val of Object.values(myself)) {
        if (typeof val === 'string' && val.trim()) {
          userIdentifiers.add(val.toLowerCase().trim());
        }
      }
    }

    const matchesUser = (val?: unknown): boolean => {
      if (typeof val !== 'string' || !val.trim()) return false;
      const lower = val.toLowerCase().trim();
      return userIdentifiers.has(lower);
    };

    await Promise.all(
      uniqueKeys.slice(0, 8).map(async (key) => {
        try {
          const resp = await fetch(
            `${settings.jiraUrl}/rest/api/2/issue/${encodeURIComponent(key)}?expand=changelog&fields=summary,description,status,assignee`,
            {
              method: 'GET',
              headers: {
                Authorization: `Basic ${auth}`,
                Accept: 'application/json'
              },
              signal: AbortSignal.timeout(2_500)
            }
          );
          this.jiraKeySyncedAt.set(key, Date.now());
          if (!resp.ok) return;

          const data = (await resp.json()) as {
            fields?: {
              summary?: string;
              description?: unknown;
              status?: { name?: string };
              assignee?: Record<string, unknown> | null;
            };
            changelog?: {
              histories?: Array<{
                items?: Array<{
                  field?: string;
                  to?: string | null;
                  toString?: string | null;
                }>;
              }>;
            };
          };

          const summary = typeof data.fields?.summary === 'string' ? data.fields.summary.trim() : '';
          let descriptionText: string | null = null;
          if (typeof data.fields?.description === 'string') {
            descriptionText = data.fields.description.replace(/\s+/g, ' ').trim().slice(0, 800);
          } else if (data.fields?.description && typeof data.fields.description === 'object') {
            descriptionText = JSON.stringify(data.fields.description).slice(0, 800);
          }
          const statusName = data.fields?.status?.name ?? undefined;

          // 1. Check current assignee
          let isUserAssignee = false;
          const curAssignee = data.fields?.assignee;
          if (curAssignee && typeof curAssignee === 'object') {
            if (
              matchesUser(curAssignee.name) ||
              matchesUser(curAssignee.key) ||
              matchesUser(curAssignee.emailAddress) ||
              matchesUser(curAssignee.displayName) ||
              matchesUser(curAssignee.accountId)
            ) {
              isUserAssignee = true;
            }
          }

          // 2. Check changelog history if not currently assigned
          if (!isUserAssignee && Array.isArray(data.changelog?.histories)) {
            for (const hist of data.changelog.histories) {
              for (const item of hist.items ?? []) {
                if (item.field === 'assignee') {
                  if (matchesUser(item.to) || matchesUser(item.toString)) {
                    isUserAssignee = true;
                    break;
                  }
                }
              }
              if (isUserAssignee) break;
            }
          }

          this.repo.upsertWorkItem({
            jiraKey: key,
            projectId: null,
            title: summary || `${key} İşi`,
            description: descriptionText,
            status: statusName,
            isUserAssignee
          });
        } catch {
          this.jiraUnreachableUntil = Date.now() + 60_000;
        }
      })
    );
  }

  private async resolveCurrentGitLabUsername(
    baseUrl: string,
    headers: Record<string, string>,
    configuredUsername: string
  ): Promise<string | null> {
    if (configuredUsername.trim()) return configuredUsername.trim();
    if (this.gitlabCurrentUsername) return this.gitlabCurrentUsername;
    try {
      const resp = await fetch(`${baseUrl}/api/v4/user`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(2_500)
      });
      if (resp.ok) {
        const data = (await resp.json()) as { username?: string };
        if (data.username && data.username.trim()) {
          this.gitlabCurrentUsername = data.username.trim();
          return this.gitlabCurrentUsername;
        }
      }
    } catch {
      // ignore user lookup failure
    }
    return null;
  }

  /**
   * Fetches reviewer-side GitLab MR activities (comments and approvals) across [startDate, endDate]
   * and persists each (project, mrIid, date) as a first-class 'gitlab_mr_review' Timeline activity.
   */
  public async syncGitLabReviewerActivities(options: {
    startDate: string;
    endDate: string;
    maxPages?: number;
  }): Promise<{ ok: boolean; createdCount: number; updatedCount: number; totalMrs: number; error?: string }> {
    const settings = this.repo.getSettings();
    const token = this.getDecryptedToken('gitlab');
    if (!settings.gitlabUrl || !token) {
      return {
        ok: false,
        createdCount: 0,
        updatedCount: 0,
        totalMrs: 0,
        error: 'GitLab URL veya Personal Access Token yapılandırılmadı.'
      };
    }

    const baseUrl = settings.gitlabUrl.trim().replace(/\/+$/, '');
    const headers: Record<string, string> = {
      'PRIVATE-TOKEN': token,
      Accept: 'application/json'
    };
    const maxPages = Math.max(1, Math.min(options.maxPages ?? 2, 15));

    const currentUsername = await this.resolveCurrentGitLabUsername(
      baseUrl,
      headers,
      settings.gitlabUsername || ''
    );

    interface GitLabEventApiItem {
      id?: number;
      project_id?: number;
      action_name?: string;
      target_type?: string | null;
      target_iid?: number | null;
      target_title?: string | null;
      created_at?: string;
      note?: {
        id?: number;
        body?: string;
        system?: boolean;
        noteable_type?: string;
        noteable_iid?: number;
        position?: { new_path?: string; old_path?: string } | null;
      } | null;
    }

    interface GitLabMrDetailApiItem {
      iid: number;
      project_id?: number;
      title?: string;
      state?: string;
      source_branch?: string;
      web_url?: string;
      author?: { username?: string; name?: string };
      references?: { full?: string; short?: string };
    }

    interface DayMrDraft {
      reportDate: string;
      gitlabProjectId: number;
      mrIid: number;
      mrTitle: string;
      actions: Set<'commented' | 'approved'>;
      myComments: string[];
      reviewedFiles: Set<string>;
      occurredAtIso: string;
    }

    const drafts = new Map<string, DayMrDraft>();
    const mrDetailsCache = new Map<string, GitLabMrDetailApiItem>();
    let hadNetworkSuccess = false;
    let hadNetworkError = false;

    const getOrCreateDraft = (
      reportDate: string,
      gitlabProjectId: number,
      mrIid: number,
      occurredAtIso: string,
      fallbackTitle?: string
    ): DayMrDraft => {
      const key = `${reportDate}|${gitlabProjectId}|${mrIid}`;
      let d = drafts.get(key);
      if (!d) {
        d = {
          reportDate,
          gitlabProjectId,
          mrIid,
          mrTitle: fallbackTitle || `MR !${mrIid}`,
          actions: new Set<'commented' | 'approved'>(),
          myComments: [],
          reviewedFiles: new Set<string>(),
          occurredAtIso
        };
        drafts.set(key, d);
      } else {
        if (occurredAtIso > d.occurredAtIso) d.occurredAtIso = occurredAtIso;
        if (fallbackTitle && d.mrTitle === `MR !${mrIid}`) d.mrTitle = fallbackTitle;
      }
      return d;
    };

    const afterDate = shiftIsoDate(options.startDate, -2);
    const beforeDate = shiftIsoDate(options.endDate, 1);

    // 1. Primary source: User Events API (/api/v4/events)
    for (let page = 1; page <= maxPages; page++) {
      try {
        const resp = await fetch(
          `${baseUrl}/api/v4/events?after=${afterDate}&before=${beforeDate}&per_page=100&page=${page}`,
          {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(4_000)
          }
        );
        hadNetworkSuccess = true;
        if (!resp.ok) {
          if (page === 1) hadNetworkError = true;
          break;
        }
        const events = (await resp.json()) as GitLabEventApiItem[];
        if (!Array.isArray(events) || events.length === 0) break;

        for (const ev of events) {
          if (!ev.created_at || !ev.project_id) continue;
          const localIso = toLocalIsoString(new Date(ev.created_at));
          const localDate = localIso.slice(0, 10);
          if (localDate < options.startDate || localDate > options.endDate) continue;

          const actionName = (ev.action_name || '').toLowerCase().trim();
          if (actionName === 'approved' && ev.target_type === 'MergeRequest' && ev.target_iid) {
            const draft = getOrCreateDraft(
              localDate,
              ev.project_id,
              ev.target_iid,
              localIso,
              ev.target_title || undefined
            );
            draft.actions.add('approved');
          } else if (
            actionName === 'commented on' &&
            ev.note &&
            !ev.note.system &&
            ev.note.noteable_type === 'MergeRequest' &&
            ev.note.noteable_iid
          ) {
            const draft = getOrCreateDraft(
              localDate,
              ev.project_id,
              ev.note.noteable_iid,
              localIso,
              ev.target_title || undefined
            );
            draft.actions.add('commented');
            const diffPath = (ev.note.position?.new_path || ev.note.position?.old_path || '')
              .replace(/\\/g, '/')
              .trim();
            if (diffPath) {
              draft.reviewedFiles.add(diffPath);
            }
            const cleanBody = (ev.note.body || '').replace(/\s+/g, ' ').trim().slice(0, 220);
            if (cleanBody) {
              const prefix = diffPath ? `[${path.posix.basename(diffPath)}] ` : '';
              const entry = `${prefix}${cleanBody}`;
              if (!draft.myComments.includes(entry)) {
                draft.myComments.push(entry);
              }
            }
          }
        }

        if (events.length < 100) break;
      } catch {
        hadNetworkError = true;
        break;
      }
    }

    // 2. Complementary approval fallback: MRs approved by current user (in case /events omits 'approved')
    if (currentUsername) {
      try {
        const updatedAfter = `${shiftIsoDate(options.startDate, -1)}T00:00:00Z`;
        const resp = await fetch(
          `${baseUrl}/api/v4/merge_requests?scope=all&approved_by_usernames[]=${encodeURIComponent(currentUsername)}&updated_after=${encodeURIComponent(updatedAfter)}&per_page=20`,
          {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(3_500)
          }
        );
        hadNetworkSuccess = true;
        if (resp.ok) {
          const approvedMrs = (await resp.json()) as GitLabMrDetailApiItem[];
          if (Array.isArray(approvedMrs)) {
            const candidatesToCheck = approvedMrs.filter((mr) => {
              if (!mr.project_id || !mr.iid) return false;
              const mrKey = `${mr.project_id}:${mr.iid}`;
              mrDetailsCache.set(mrKey, mr);
              // Skip if we already recorded an 'approved' event for this MR in drafts
              for (const d of drafts.values()) {
                if (d.gitlabProjectId === mr.project_id && d.mrIid === mr.iid && d.actions.has('approved')) {
                  return false;
                }
              }
              return true;
            });

            await Promise.all(
              candidatesToCheck.slice(0, 12).map(async (mr) => {
                try {
                  const notesResp = await fetch(
                    `${baseUrl}/api/v4/projects/${mr.project_id}/merge_requests/${mr.iid}/notes?per_page=40`,
                    {
                      method: 'GET',
                      headers,
                      signal: AbortSignal.timeout(2_500)
                    }
                  );
                  if (!notesResp.ok) return;
                  const notes = (await notesResp.json()) as Array<{
                    system?: boolean;
                    body?: string;
                    created_at?: string;
                    author?: { username?: string };
                  }>;
                  if (!Array.isArray(notes)) return;
                  for (const n of notes) {
                    if (
                      n.system &&
                      n.created_at &&
                      n.author?.username?.toLowerCase() === currentUsername.toLowerCase() &&
                      /approved this merge request/i.test(n.body || '')
                    ) {
                      const localIso = toLocalIsoString(new Date(n.created_at));
                      const localDate = localIso.slice(0, 10);
                      if (localDate >= options.startDate && localDate <= options.endDate) {
                        const draft = getOrCreateDraft(
                          localDate,
                          mr.project_id!,
                          mr.iid,
                          localIso,
                          mr.title || undefined
                        );
                        draft.actions.add('approved');
                      }
                    }
                  }
                } catch {
                  // ignore individual note fetch error
                }
              })
            );
          }
        }
      } catch {
        // ignore fallback failure
      }
    }

    if (hadNetworkError && !hadNetworkSuccess) {
      this.gitlabUnreachableUntil = Date.now() + 60_000;
      return {
        ok: false,
        createdCount: 0,
        updatedCount: 0,
        totalMrs: 0,
        error: 'GitLab sunucusuna erişilemedi.'
      };
    }

    // 3. Enrich unique (gitlabProjectId, mrIid) metadata in bounded batches
    const uniqueMrKeys = Array.from(
      new Set(Array.from(drafts.values()).map((d) => `${d.gitlabProjectId}:${d.mrIid}`))
    ).filter((k) => !mrDetailsCache.has(k));

    const BATCH_SIZE = 5;
    for (let i = 0; i < Math.min(uniqueMrKeys.length, 40); i += BATCH_SIZE) {
      const batch = uniqueMrKeys.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (mrKey) => {
          const [projIdStr, iidStr] = mrKey.split(':');
          try {
            const resp = await fetch(
              `${baseUrl}/api/v4/projects/${projIdStr}/merge_requests/${iidStr}`,
              {
                method: 'GET',
                headers,
                signal: AbortSignal.timeout(2_500)
              }
            );
            if (resp.ok) {
              const detail = (await resp.json()) as GitLabMrDetailApiItem;
              if (detail && detail.iid) {
                mrDetailsCache.set(mrKey, detail);
              }
            }
          } catch {
            // ignore detail fetch failure; we still have event data
          }
        })
      );
    }

    // 4. Resolve local projects & persist to SQLite
    const localProjects = this.repo.listProjects();
    const localProjectByPath = new Map<string, { id: string; name: string }>();
    for (const p of localProjects) {
      const pPath = extractGitLabProjectPath(p.repositoryUrl);
      if (pPath) {
        localProjectByPath.set(pPath.toLowerCase(), { id: p.id, name: p.name });
      }
    }

    let createdCount = 0;
    let updatedCount = 0;
    let totalMrs = 0;

    for (const draft of drafts.values()) {
      const mrKey = `${draft.gitlabProjectId}:${draft.mrIid}`;
      const detail = mrDetailsCache.get(mrKey);
      const authorUsername = detail?.author?.username?.trim().toLowerCase() || '';

      // Exclude self-authored comment-only MRs (author replying to reviewers is tracked via reviewFixes)
      if (
        currentUsername &&
        authorUsername &&
        authorUsername === currentUsername.toLowerCase() &&
        !draft.actions.has('approved')
      ) {
        continue;
      }

      // Resolve project name & optional local projectId
      let localProjectId: string | null = null;
      let rawProjectName = '';

      const refFull = detail?.references?.full || '';
      const refPathMatch = refFull.match(/^(.+)!\d+$/);
      const webUrlPathMatch = (detail?.web_url || '').match(/^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/\d+/i);
      const gitlabRepoPath = (refPathMatch?.[1] || webUrlPathMatch?.[1] || '').replace(/^\/+|\/+$/g, '');

      if (gitlabRepoPath) {
        const matchedLocal = localProjectByPath.get(gitlabRepoPath.toLowerCase());
        if (matchedLocal) {
          localProjectId = matchedLocal.id;
          rawProjectName = matchedLocal.name;
        } else {
          rawProjectName = gitlabRepoPath.split('/').pop() || gitlabRepoPath;
        }
      }
      const projectName = rawProjectName
        ? formatCorporateProjectName(rawProjectName)
        : `GitLab Proje #${draft.gitlabProjectId}`;

      const item: GitLabReviewedMrItem & { reportDate: string } = {
        reportDate: draft.reportDate,
        projectId: localProjectId,
        gitlabProjectId: draft.gitlabProjectId,
        projectName,
        mrIid: draft.mrIid,
        mrTitle: (detail?.title || draft.mrTitle || `MR !${draft.mrIid}`).trim(),
        mrState: detail?.state || 'opened',
        sourceBranch: detail?.source_branch,
        webUrl: detail?.web_url,
        actions: Array.from(draft.actions),
        myComments: draft.myComments,
        reviewedFiles: Array.from(draft.reviewedFiles),
        occurredAtIso: draft.occurredAtIso
      };

      const res = this.repo.ingestGitLabMrReviewActivity(item);
      if (res.created) createdCount++;
      else if (res.updated) updatedCount++;
      totalMrs++;
    }

    const nowIso = new Date().toISOString();
    this.repo.updateSyncState({
      connector: 'gitlab',
      status: 'connected',
      lastAttemptAt: nowIso,
      lastSuccessAt: nowIso,
      lastError: null,
      recordsCount: totalMrs
    });

    return { ok: true, createdCount, updatedCount, totalMrs };
  }

  /**
   * Manually backfills GitLab reviewer MR activities (comments & approvals) for the past N days (default 30).
   */
  public async syncGitLabReviewsHistory(days = 30): Promise<GitLabSyncReviewsResult> {
    const clampedDays = Math.max(1, Math.min(Math.floor(days || 30), 90));
    const endDate = toLocalIsoString(new Date()).slice(0, 10);
    const startDate = shiftIsoDate(endDate, -(clampedDays - 1));
    this.gitlabUnreachableUntil = 0;

    const res = await this.syncGitLabReviewerActivities({
      startDate,
      endDate,
      maxPages: 10
    });

    if (!res.ok) {
      return {
        ok: false,
        days: clampedDays,
        createdCount: 0,
        updatedCount: 0,
        totalMrs: 0,
        message: res.error || 'GitLab MR senkronizasyonu başarısız oldu.'
      };
    }

    this.gitlabReviewerDaySyncedAt.clear();
    const message =
      res.totalMrs > 0
        ? `Son ${clampedDays} gün için ${res.totalMrs} GitLab MR inceleme/onay kaydı senkronize edildi (${res.createdCount} yeni, ${res.updatedCount} güncellendi).`
        : `Son ${clampedDays} gün içinde reviewer olarak yorum yapılan veya onaylanan GitLab MR bulunmadı.`;

    return {
      ok: true,
      days: clampedDays,
      createdCount: res.createdCount,
      updatedCount: res.updatedCount,
      totalMrs: res.totalMrs,
      message
    };
  }

  /**
   * Queries GitLab REST API v4 (read-only) using the configured Personal Access Token
   * to:
   * 1. Sync reviewer-side MR comments & approvals for `reportDate` into SQLite (`gitlab_mr_review`),
   * 2. Check whether the day's Git commits, working-tree edits, or file changes correspond
   *    to opened Merge Requests and MR code review feedback (Notes / DiffNotes).
   */
  public async resolveGitLabMrReviewsIfConfigured(
    reportDate: string,
    activities: Activity[]
  ): Promise<Record<string, GitLabMrReviewContext>> {
    const result: Record<string, GitLabMrReviewContext> = {};
    const settings = this.repo.getSettings();
    const token = this.getDecryptedToken('gitlab');
    if (!settings.gitlabUrl || !token) return result;

    // 1. Always sync reviewer-side MR activities for reportDate (throttled to 5 min per date)
    const lastReviewerSync = this.gitlabReviewerDaySyncedAt.get(reportDate) ?? 0;
    const shouldSyncReviewer =
      Date.now() >= this.gitlabUnreachableUntil && Date.now() - lastReviewerSync >= 5 * 60_000;
    const reviewerSyncPromise = shouldSyncReviewer
      ? this.syncGitLabReviewerActivities({
          startDate: reportDate,
          endDate: reportDate,
          maxPages: 2
        })
          .then((r) => {
            if (r.ok) this.gitlabReviewerDaySyncedAt.set(reportDate, Date.now());
          })
          .catch(() => undefined)
      : Promise.resolve();

    const baseUrl = settings.gitlabUrl.trim().replace(/\/+$/, '');
    const devActs = activities.filter(
      (a) =>
        (a.sourceType === 'git_commit' ||
          a.sourceType === 'git_working_tree' ||
          a.sourceType === 'file_change') &&
        (!a.occurredAtIso || a.occurredAtIso.slice(0, 10) === reportDate)
    );
    if (devActs.length === 0) {
      await reviewerSyncPromise;
      return result;
    }

    const signature = devActs.map((a) => `${a.id}:${a.occurredAtIso}`).join('|');
    const cached = this.gitlabMrCache.get(reportDate);
    if (cached && cached.signature === signature && Date.now() - cached.timestamp < 5 * 60_000) {
      await reviewerSyncPromise;
      return cached.data;
    }
    if (Date.now() < this.gitlabUnreachableUntil) {
      await reviewerSyncPromise;
      return cached?.data ?? result;
    }

    const allProjects = new Map(this.repo.listProjects().map((p) => [p.id, p]));

    interface ProjectDevTarget {
      projectId: string | null;
      projectName: string;
      repositoryUrl: string | null;
      branches: Set<string>;
      jiraKeys: Set<string>;
      changedFiles: Set<string>;
      latestOccurredIso: string;
    }

    const targetsByProj = new Map<string, ProjectDevTarget>();

    for (const act of devActs) {
      const acceptedLink = (act.links ?? []).find(
        (l) => l.userStatus === 'accepted' && (l.workItemId || l.projectId)
      );
      const projId = act.projectId ?? acceptedLink?.projectId ?? null;
      const projObj = projId ? allProjects.get(projId) : undefined;
      const projName =
        projObj?.name ||
        act.projectName ||
        acceptedLink?.projectName ||
        act.chatOrRepoName ||
        'İlgili Süreç';
      const targetKey = projId || `name:${projName.toLowerCase()}`;

      let target = targetsByProj.get(targetKey);
      if (!target) {
        target = {
          projectId: projId,
          projectName: projName,
          repositoryUrl: projObj?.repositoryUrl ?? null,
          branches: new Set<string>(),
          jiraKeys: new Set<string>(),
          changedFiles: new Set<string>(),
          latestOccurredIso: act.occurredAtIso || `${reportDate}T23:59:59`
        };
        targetsByProj.set(targetKey, target);
      } else if (act.occurredAtIso && act.occurredAtIso > target.latestOccurredIso) {
        target.latestOccurredIso = act.occurredAtIso;
      }

      if (projObj?.currentBranch) {
        target.branches.add(projObj.currentBranch);
      }
      if (acceptedLink?.workItemJiraKey) {
        target.jiraKeys.add(acceptedLink.workItemJiraKey.toUpperCase());
      }
      for (const k of extractJiraKeysFromText(`${act.title} ${act.summary}`)) {
        target.jiraKeys.add(k.toUpperCase());
      }

      for (const ev of act.evidences ?? []) {
        const br = typeof ev.metadata?.branchName === 'string' ? ev.metadata.branchName.trim() : '';
        if (br) {
          target.branches.add(br);
          for (const k of extractJiraKeysFromText(br)) {
            target.jiraKeys.add(k.toUpperCase());
          }
        }
        const cf = ev.metadata?.changedFiles;
        if (Array.isArray(cf)) {
          for (const f of cf) {
            if (typeof f === 'string' && f.trim()) {
              target.changedFiles.add(f.replace(/\\/g, '/').trim());
            }
          }
        }
      }
    }

    const headers = {
      'PRIVATE-TOKEN': token,
      Accept: 'application/json'
    };

    interface GitLabMrApiItem {
      iid: number;
      project_id?: number;
      title?: string;
      description?: string | null;
      state?: string;
      source_branch?: string;
      target_branch?: string;
      created_at?: string;
      updated_at?: string;
      web_url?: string;
      user_notes_count?: number;
    }

    interface GitLabNoteApiItem {
      id?: number;
      body?: string;
      system?: boolean;
      type?: string | null;
      author?: { username?: string; name?: string };
      created_at?: string;
      resolvable?: boolean;
      resolved?: boolean;
      position?: {
        new_path?: string;
        old_path?: string;
      } | null;
    }

    let hadNetworkSuccess = false;
    let hadNetworkError = false;

    await Promise.all(
      Array.from(targetsByProj.values())
        .slice(0, 6)
        .map(async (target) => {
          try {
            const repoPath = extractGitLabProjectPath(target.repositoryUrl);
            let encodedProjectIdentifier = repoPath ? encodeURIComponent(repoPath) : null;
            let mrs: GitLabMrApiItem[] = [];

            if (encodedProjectIdentifier) {
              const mrResp = await fetch(
                `${baseUrl}/api/v4/projects/${encodedProjectIdentifier}/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=15`,
                {
                  method: 'GET',
                  headers,
                  signal: AbortSignal.timeout(2_500)
                }
              );
              hadNetworkSuccess = true;
              if (mrResp.ok) {
                const data = await mrResp.json();
                if (Array.isArray(data)) mrs = data as GitLabMrApiItem[];
              } else {
                encodedProjectIdentifier = null;
              }
            }

            if (!encodedProjectIdentifier) {
              const searchResp = await fetch(
                `${baseUrl}/api/v4/projects?search=${encodeURIComponent(target.projectName)}&per_page=5`,
                {
                  method: 'GET',
                  headers,
                  signal: AbortSignal.timeout(2_500)
                }
              );
              hadNetworkSuccess = true;
              if (searchResp.ok) {
                const foundProjects = (await searchResp.json()) as Array<{
                  id?: number;
                  path?: string;
                  name?: string;
                  path_with_namespace?: string;
                }>;
                if (Array.isArray(foundProjects) && foundProjects.length > 0) {
                  const lowerTarget = target.projectName.toLowerCase();
                  const bestProj =
                    foundProjects.find(
                      (p) =>
                        p.path?.toLowerCase() === lowerTarget ||
                        p.name?.toLowerCase() === lowerTarget
                    ) ?? foundProjects[0];
                  if (bestProj?.id !== undefined) {
                    encodedProjectIdentifier = String(bestProj.id);
                    const mrResp = await fetch(
                      `${baseUrl}/api/v4/projects/${encodedProjectIdentifier}/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=15`,
                      {
                        method: 'GET',
                        headers,
                        signal: AbortSignal.timeout(2_500)
                      }
                    );
                    if (mrResp.ok) {
                      const data = await mrResp.json();
                      if (Array.isArray(data)) mrs = data as GitLabMrApiItem[];
                    }
                  }
                }
              }
            }

            if (mrs.length === 0) return;

            const branchList = Array.from(target.branches);
            const jiraList = Array.from(target.jiraKeys);

            const matchedMrs = mrs.filter((mr) => {
              const srcBranch = (mr.source_branch || '').trim();
              const titleAndBranch = `${mr.title || ''} ${srcBranch} ${mr.description || ''}`.toUpperCase();
              if (
                branchList.some(
                  (b) =>
                    b &&
                    b !== 'main' &&
                    b !== 'master' &&
                    b !== 'uat' &&
                    b !== 'develop' &&
                    srcBranch.toLowerCase() === b.toLowerCase()
                )
              ) {
                return true;
              }
              if (jiraList.some((jk) => titleAndBranch.includes(jk))) {
                return true;
              }
              return false;
            });

            const candidateMrs = matchedMrs.length > 0 ? matchedMrs.slice(0, 2) : mrs.slice(0, 1);

            for (const mr of candidateMrs) {
              const mrProjId = mr.project_id ? String(mr.project_id) : encodedProjectIdentifier!;
              let notes: GitLabNoteApiItem[] = [];
              try {
                const notesResp = await fetch(
                  `${baseUrl}/api/v4/projects/${mrProjId}/merge_requests/${mr.iid}/notes?per_page=40`,
                  {
                    method: 'GET',
                    headers,
                    signal: AbortSignal.timeout(2_500)
                  }
                );
                if (notesResp.ok) {
                  const notesData = await notesResp.json();
                  if (Array.isArray(notesData)) {
                    notes = notesData as GitLabNoteApiItem[];
                  }
                }
              } catch {
                // ignore note fetch error
              }

              const humanNotes = notes.filter((n) => !n.system && typeof n.body === 'string' && n.body.trim().length > 0);
              const reviewedFilesSet = new Set<string>();
              const reviewerNotesList: string[] = [];

              const changedFilesArray = Array.from(target.changedFiles);
              const changedBasenames = new Set(
                changedFilesArray.map((f) => path.posix.basename(f).toLowerCase())
              );

              for (const n of humanNotes) {
                const diffPath = (n.position?.new_path || n.position?.old_path || '').replace(/\\/g, '/').trim();
                if (diffPath) {
                  reviewedFilesSet.add(diffPath);
                }
                const cleanBody = (n.body || '').replace(/\s+/g, ' ').trim().slice(0, 220);
                if (!cleanBody) continue;
                const filePrefix = diffPath ? `[${path.posix.basename(diffPath)}] ` : '';
                const resolvedSuffix = n.resolved ? ' (Çözüldü)' : '';
                const noteEntry = `${filePrefix}${cleanBody}${resolvedSuffix}`;
                if (!reviewerNotesList.includes(noteEntry)) {
                  reviewerNotesList.push(noteEntry);
                }
              }

              const reviewedFiles = Array.from(reviewedFilesSet);
              const touchedReviewedFile = reviewedFiles.some(
                (rf) =>
                  target.changedFiles.has(rf) ||
                  changedBasenames.has(path.posix.basename(rf).toLowerCase())
              );

              const mrCreatedDate = mr.created_at ? mr.created_at.slice(0, 10) : '';
              const isPostMrCreationChange = Boolean(
                (mrCreatedDate && mrCreatedDate < reportDate) ||
                  (mr.created_at && target.latestOccurredIso && mr.created_at < target.latestOccurredIso)
              );

              const isReviewFix =
                humanNotes.length > 0 ||
                touchedReviewedFile ||
                Boolean((mr.user_notes_count ?? 0) > 0) ||
                isPostMrCreationChange;

              const mrContext: GitLabMrReviewContext = {
                projectId: target.projectId,
                projectName: formatCorporateProjectName(target.projectName),
                mrIid: mr.iid,
                mrTitle: (mr.title || `MR !${mr.iid}`).trim(),
                mrState: mr.state || 'opened',
                sourceBranch: mr.source_branch || '',
                webUrl: mr.web_url,
                isReviewFix,
                reviewedFiles,
                reviewerNotes: reviewerNotesList.slice(0, 6)
              };

              // Index by project name, formatted corporate project name, project ID, and Jira keys
              const corpProj = formatCorporateProjectName(target.projectName);
              result[`proj:${corpProj}`] = mrContext;
              result[`proj:${target.projectName}`] = mrContext;
              if (target.projectId) {
                result[`id:${target.projectId}`] = mrContext;
              }
              const mrJiraKeys = new Set<string>([
                ...jiraList,
                ...extractJiraKeysFromText(`${mr.title || ''} ${mr.source_branch || ''}`)
              ]);
              for (const jk of mrJiraKeys) {
                result[`jira:${jk.toUpperCase()}`] = mrContext;
              }

              if (isReviewFix) break;
            }
          } catch {
            hadNetworkError = true;
          }
        })
    );

    await reviewerSyncPromise;

    if (hadNetworkError && !hadNetworkSuccess) {
      this.gitlabUnreachableUntil = Date.now() + 60_000;
    } else {
      this.gitlabMrCache.set(reportDate, { timestamp: Date.now(), signature, data: result });
    }

    return result;
  }
}
