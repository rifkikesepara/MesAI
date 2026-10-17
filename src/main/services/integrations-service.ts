import fs from 'node:fs';
import path from 'node:path';
import type { MesaiRepository } from '../db/repositories';
import type { ZoomReaderAdapter } from './zoom-adapter';
import type { GitFileWatcherService } from './git-file-watcher';
import type { ReportService } from './report-service';
import { OpenAiApiProvider, AnthropicApiProvider } from './ai-provider';
import type { AppSettings, IntegrationHealth, ZoomReaderStatus } from '../../shared/types';

export interface SecretProvider {
  encrypt(plainText: string): string;
  decrypt(cipherBase64: string): string;
}

export class IntegrationsService {
  private readonly secretsFilePath: string;
  private readonly secretProvider: SecretProvider;

  constructor(
    private readonly repo: MesaiRepository,
    private readonly zoomAdapter: ZoomReaderAdapter,
    private readonly gitWatcher: GitFileWatcherService,
    private readonly reportService: ReportService,
    options?: { userDataDir?: string; secretProvider?: SecretProvider }
  ) {
    const dir = options?.userDataDir ?? process.cwd();
    this.secretsFilePath = path.join(dir, 'mesai_credentials.dpapi.json');
    this.secretProvider = options?.secretProvider ?? this.createDefaultSecretProvider();
    this.reportService.setJiraIssueSyncer((keys) => this.syncJiraIssuesIfConfigured(keys));
    this.reportService.setAiApiKeyResolver((prov) => this.getDecryptedAiToken(prov));
  }

  private createDefaultSecretProvider(): SecretProvider {
    return {
      encrypt: (plainText: string) => {
        try {
          // Dynamically require electron safeStorage when running inside Electron Main
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { safeStorage } = require('electron');
          if (safeStorage && safeStorage.isEncryptionAvailable()) {
            return safeStorage.encryptString(plainText).toString('base64');
          }
        } catch {
          // Not in Electron main process
        }
        throw new Error('OS güvenli şifreleme (DPAPI safeStorage) bu çalışma ortamında kullanılamıyor.');
      },
      decrypt: (cipherBase64: string) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { safeStorage } = require('electron');
        if (safeStorage && safeStorage.isEncryptionAvailable()) {
          return safeStorage.decryptString(Buffer.from(cipherBase64, 'base64'));
        }
        throw new Error('OS güvenli şifreleme (DPAPI safeStorage) çözülemedi.');
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
   * Saves Jira or Jenkins URL/username in settings and encrypts the token via OS DPAPI (never plaintext in SQLite).
   */
  public saveIntegrationCredential(input: {
    service: 'jira' | 'jenkins';
    url: string;
    usernameOrEmail: string;
    token: string;
  }): void {
    const cleanUrl = input.url.trim().replace(/\/+$/, '');
    const cleanUser = input.usernameOrEmail.trim();

    if (input.service === 'jira') {
      this.repo.updateSettings({ jiraUrl: cleanUrl, jiraEmail: cleanUser });
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

  public hasEncryptedToken(service: 'jira' | 'jenkins'): boolean {
    const store = this.readEncryptedStore();
    return Boolean(store[`${service}_token`]);
  }

  private getDecryptedToken(service: 'jira' | 'jenkins'): string | null {
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
    provider: 'openai' | 'anthropic' | 'custom';
    apiKey: string;
    model?: string;
    customBaseUrl?: string;
  }): void {
    const store = this.readEncryptedStore();
    const cleanKey = input.apiKey.trim();
    if (cleanKey) {
      store[`${input.provider}_token`] = this.secretProvider.encrypt(cleanKey);
      this.writeEncryptedStore(store);
    } else if (input.apiKey === '') {
      delete store[`${input.provider}_token`];
      this.writeEncryptedStore(store);
    }

    const updates: Partial<AppSettings> = {};
    if (input.model !== undefined) {
      updates.aiModel = input.model.trim();
    }
    if (input.customBaseUrl !== undefined) {
      updates.aiCustomBaseUrl = input.customBaseUrl.trim();
    }
    if (Object.keys(updates).length > 0) {
      this.repo.updateSettings(updates);
    }
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
    if (provider === 'openai') {
      const p = new OpenAiApiProvider({
        providerType: 'openai',
        apiKeyResolver: () => this.getDecryptedAiToken('openai'),
        model: settings.aiModel
      });
      return p.testConnection();
    } else if (provider === 'anthropic') {
      const p = new AnthropicApiProvider({
        apiKeyResolver: () => this.getDecryptedAiToken('anthropic'),
        model: settings.aiModel
      });
      return p.testConnection();
    } else {
      const p = new OpenAiApiProvider({
        providerType: 'custom',
        apiKeyResolver: () => this.getDecryptedAiToken('custom'),
        model: settings.aiModel,
        customBaseUrl: settings.aiCustomBaseUrl
      });
      return p.testConnection();
    }
  }

  /**
   * Performs a real, read-only connection test against Jira or Jenkins.
   * Never reports "connected" unless an actual HTTP 200 response is verified.
   */
  public async testConnection(service: 'jira' | 'jenkins'): Promise<{ ok: boolean; message: string }> {
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
    const jenkinsSync = this.repo.getSyncState('jenkins');

    const exePath = this.zoomAdapter.resolveExecutablePath();
    const exeExists = fs.existsSync(exePath);
    const gitVersion = await this.gitWatcher.getGitVersion();
    const geminiHealth = await this.reportService.getGeminiProvider().checkHealth();
    const enabledProjects = this.repo.listProjects().filter((p) => p.enabled).length;

    const jiraConfigured = Boolean(settings.jiraUrl && settings.jiraEmail && this.hasEncryptedToken('jira'));
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
        openaiConfigured,
        openaiModel: settings.aiModel || 'gpt-4o-mini',
        anthropicConfigured,
        anthropicModel: settings.aiModel || 'claude-3-5-sonnet-20241022',
        customConfigured,
        customBaseUrl: settings.aiCustomBaseUrl || '',
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

  /**
   * Fetches read-only issue summary & description from Jira REST API for the given keys
   * when Jira credentials are configured, storing them in local `work_items`.
   */
  public async syncJiraIssuesIfConfigured(jiraKeys: string[]): Promise<void> {
    if (!jiraKeys || jiraKeys.length === 0) return;
    const settings = this.repo.getSettings();
    const token = this.getDecryptedToken('jira');
    if (!settings.jiraUrl || !settings.jiraEmail || !token) return;

    const auth = Buffer.from(`${settings.jiraEmail}:${token}`, 'utf8').toString('base64');
    const uniqueKeys = Array.from(new Set(jiraKeys.map((k) => k.trim().toUpperCase()).filter(Boolean)));

    for (const key of uniqueKeys) {
      try {
        const resp = await fetch(
          `${settings.jiraUrl}/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,description,status`,
          {
            method: 'GET',
            headers: {
              Authorization: `Basic ${auth}`,
              Accept: 'application/json'
            },
            signal: AbortSignal.timeout(5_000)
          }
        );
        if (!resp.ok) continue;

        const data = (await resp.json()) as {
          fields?: {
            summary?: string;
            description?: unknown;
            status?: { name?: string };
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

        if (summary || descriptionText) {
          this.repo.upsertWorkItem({
            jiraKey: key,
            projectId: null,
            title: summary || 'Otomatik tespit edilen iş anahtarı',
            description: descriptionText,
            status: statusName
          });
        }
      } catch {
        // Ignore network/timeout errors for individual issues so report generation never fails
      }
    }
  }
}
