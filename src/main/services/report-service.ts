import type { MesaiRepository } from '../db/repositories';
import { extractJiraKeys } from './matcher-service';
import {
  AIProvider,
  AnthropicApiProvider,
  buildSanitizedAiPrompt,
  ClaudeCliProvider,
  CodexCliProvider,
  fitItemsToMaxChars,
  GeminiCliProvider,
  LocalRuleProvider,
  OllamaCliProvider,
  OpenAiApiProvider
} from './ai-provider';
import { toLocalIsoString } from './timestamp-resolver';
import type {
  Activity,
  ActivityCategory,
  ActivityStatus,
  AiPreviewPayload,
  AIProviderType,
  AppSettings,
  DailyReport,
  GitLabMrReviewContext,
  ReportProgressLog
} from '../../shared/types';
import { getNowHhmmss } from './ai-provider';

const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  development: 'Yazılım Geliştirme',
  analysis: 'Teknik Analiz & İnceleme',
  technical_discussion: 'Teknik Görüşme & Koordinasyon',
  meeting: 'Toplantı & Görüşmeler',
  research: 'Araştırma & PoC'
};

const STATUS_LABELS: Record<ActivityStatus, string> = {
  completed: 'Tamamlanan İşler',
  in_progress: 'Devam Eden Çalışmalar',
  decision: 'Alınan Kararlar',
  blocker: 'Engeller & Riskler',
  info: 'Bilgilendirme & Notlar'
};

export class ReportService {
  private readonly localProvider = new LocalRuleProvider();
  private readonly geminiProvider: GeminiCliProvider;
  private aiApiKeyResolver?: (provider: 'openai' | 'anthropic' | 'custom') => string | null;
  private jiraIssueSyncer?: (jiraKeys: string[]) => Promise<void>;
  private gitlabMrSyncer?: (reportDate: string, activities: Activity[]) => Promise<Record<string, GitLabMrReviewContext>>;
  private cachedGitLabMrSyncer?: (reportDate: string) => Record<string, GitLabMrReviewContext>;

  constructor(
    private readonly repo: MesaiRepository,
    customGeminiProvider?: GeminiCliProvider
  ) {
    this.geminiProvider = customGeminiProvider ?? new GeminiCliProvider();
  }

  public setAiApiKeyResolver(resolver: (provider: 'openai' | 'anthropic' | 'custom') => string | null): void {
    this.aiApiKeyResolver = resolver;
  }

  public setJiraIssueSyncer(syncer: (jiraKeys: string[]) => Promise<void>): void {
    this.jiraIssueSyncer = syncer;
  }

  public setGitLabMrSyncer(
    syncer: (reportDate: string, activities: Activity[]) => Promise<Record<string, GitLabMrReviewContext>>
  ): void {
    this.gitlabMrSyncer = syncer;
  }

  public setCachedGitLabMrSyncer(
    syncer: (reportDate: string) => Record<string, GitLabMrReviewContext>
  ): void {
    this.cachedGitLabMrSyncer = syncer;
  }

  public getGeminiProvider(): GeminiCliProvider {
    return this.geminiProvider;
  }

  private persistProviderModel(provider: AIProviderType, modelOverride?: string): void {
    const trimmed = modelOverride?.trim();
    if (!trimmed) return;
    const updates: Partial<AppSettings> = { aiModel: trimmed };
    if (provider === 'gemini_cli') {
      updates.aiGeminiModel = trimmed;
    } else if (provider === 'openai') {
      updates.aiOpenaiModel = trimmed;
    } else if (provider === 'anthropic') {
      updates.aiAnthropicModel = trimmed;
    } else if (provider === 'custom') {
      updates.aiCustomModel = trimmed;
    }
    this.repo.updateSettings(updates);
  }

  public async previewAiPayload(
    reportDate: string,
    maxChars?: number,
    providerOverride?: AIProviderType,
    modelOverride?: string,
    fastLocal = false
  ): Promise<AiPreviewPayload> {
    if (typeof maxChars === 'number' && maxChars >= 120) {
      this.repo.updateSettings({ reportMaxChars: Math.floor(maxChars) });
    }
    const initialSettings = this.repo.getSettings();
    const effectiveProvider = providerOverride ?? initialSettings.aiProvider;
    this.persistProviderModel(effectiveProvider, modelOverride);
    const settings = this.repo.getSettings();
    const effectiveMaxChars =
      typeof maxChars === 'number' && maxChars >= 120
        ? Math.floor(maxChars)
        : settings.reportMaxChars ?? 1000;

    // Strictly filter to only activities belonging to reportDate
    const activities = this.repo
      .listActivities({ date: reportDate })
      .filter((a) => a.occurredAtIso && a.occurredAtIso.slice(0, 10) === reportDate);

    let gitlabMrContextMap: Record<string, GitLabMrReviewContext> = this.cachedGitLabMrSyncer
      ? this.cachedGitLabMrSyncer(reportDate)
      : {};

    if (!fastLocal) {
      // Sync candidate Jira keys and GitLab MR reviews in parallel with a strict 2.5s timeout cap
      const candidateJiraKeys = new Set<string>();
      for (const act of activities) {
        for (const k of extractJiraKeys(act.title + ' ' + act.summary)) candidateJiraKeys.add(k);
        for (const ev of act.evidences ?? []) {
          for (const k of extractJiraKeys(ev.title + ' ' + ev.snippet + ' ' + (ev.externalRef ?? '') + ' ' + ev.links.join(' '))) {
            candidateJiraKeys.add(k);
          }
        }
      }
      const jiraPromise =
        this.jiraIssueSyncer && candidateJiraKeys.size > 0
          ? this.jiraIssueSyncer(Array.from(candidateJiraKeys)).catch(() => undefined)
          : Promise.resolve();
      const gitlabPromise =
        this.gitlabMrSyncer && activities.length > 0
          ? this.gitlabMrSyncer(reportDate, activities)
              .then((res) => {
                gitlabMrContextMap = res;
              })
              .catch(() => undefined)
          : Promise.resolve();

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([jiraPromise, gitlabPromise]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 2_500);
            timer.unref?.();
          })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    const dayJiraKeys = this.repo.extractJiraKeysForDate(reportDate);
    const jiraContextMap = this.repo.getJiraContextMap(dayJiraKeys);

    const sanitizedPromptPreview = buildSanitizedAiPrompt(
      reportDate,
      activities,
      effectiveMaxChars,
      jiraContextMap,
      gitlabMrContextMap
    );

    const { modelUsed } = this.getProviderInstance(effectiveProvider, modelOverride);

    const warnings: string[] = [
      `Yalnızca seçilen tarihe (${reportDate}) ait ${activities.length} aktivite rapora dahil edilir.`,
      `Maksimum karakter sınırı: ${effectiveMaxChars} karakter.`,
      'Mesajlar, kod diff özetleri, Jira ve GitLab MR review bağlamları <untrusted_evidence_json> bloğu içinde güvenilmeyen kaynak verisi olarak izole edilir.'
    ];
    if (!settings.allowRemoteAiSend && effectiveProvider !== 'local_rule') {
      warnings.push(
        'Ayarlarda "Uzak AI Gönderim İzni" kapalıdır. AI servisine veri gönderimi yapmak için önizleme onayı gereklidir.'
      );
    }

    return {
      reportDate,
      provider: effectiveProvider,
      model: modelUsed,
      activityCount: activities.length,
      sanitizedPromptPreview,
      warnings,
      maxChars: effectiveMaxChars
    };
  }

  private getProviderInstance(
    provider: AIProviderType,
    modelOverride?: string
  ): { provider: AIProvider; isCli: boolean; modelUsed?: string } {
    const settings = this.repo.getSettings();
    const override = modelOverride?.trim() || undefined;
    switch (provider) {
      case 'gemini_cli': {
        const modelUsed = override || settings.aiGeminiModel || 'gemini-4-argon-medium';
        this.geminiProvider.setModel(modelUsed);
        return { provider: this.geminiProvider, isCli: true, modelUsed };
      }
      case 'openai': {
        const modelUsed = override || settings.aiOpenaiModel || settings.aiModel || 'gpt-4o-mini';
        const useCli =
          settings.aiOpenaiMode === 'cli' ||
          (settings.aiOpenaiMode !== 'api' &&
            (!this.aiApiKeyResolver?.('openai') || Boolean(CodexCliProvider.resolveCodexCliPath())));
        if (useCli && CodexCliProvider.resolveCodexCliPath()) {
          return {
            provider: new CodexCliProvider({ model: modelUsed }),
            isCli: true,
            modelUsed
          };
        }
        return {
          provider: new OpenAiApiProvider({
            providerType: 'openai',
            apiKeyResolver: () => this.aiApiKeyResolver?.('openai') ?? null,
            model: modelUsed,
            customBaseUrl: settings.aiOpenaiBaseUrl || undefined
          }),
          isCli: false,
          modelUsed
        };
      }
      case 'anthropic': {
        const modelUsed = override || settings.aiAnthropicModel || settings.aiModel || 'claude-3-5-sonnet-20241022';
        const useCli =
          settings.aiAnthropicMode === 'cli' ||
          (settings.aiAnthropicMode !== 'api' &&
            (!this.aiApiKeyResolver?.('anthropic') && Boolean(ClaudeCliProvider.resolveClaudeCliPath())));
        if (useCli && ClaudeCliProvider.resolveClaudeCliPath()) {
          return {
            provider: new ClaudeCliProvider({ model: modelUsed }),
            isCli: true,
            modelUsed
          };
        }
        return {
          provider: new AnthropicApiProvider({
            apiKeyResolver: () => this.aiApiKeyResolver?.('anthropic') ?? null,
            model: modelUsed
          }),
          isCli: false,
          modelUsed
        };
      }
      case 'custom': {
        const modelUsed = override || settings.aiCustomModel || settings.aiModel || 'llama3.2';
        const useCli =
          settings.aiCustomMode === 'cli' ||
          (settings.aiCustomMode !== 'api' &&
            !settings.aiCustomBaseUrl &&
            Boolean(OllamaCliProvider.resolveOllamaCliPath()));
        if (useCli && OllamaCliProvider.resolveOllamaCliPath()) {
          return {
            provider: new OllamaCliProvider({ model: modelUsed }),
            isCli: true,
            modelUsed
          };
        }
        return {
          provider: new OpenAiApiProvider({
            providerType: 'custom',
            apiKeyResolver: () => this.aiApiKeyResolver?.('custom') ?? null,
            model: modelUsed,
            customBaseUrl: settings.aiCustomBaseUrl
          }),
          isCli: false,
          modelUsed
        };
      }
      case 'local_rule':
      default:
        return { provider: this.localProvider, isCli: false };
    }
  }

  /**
   * Generates a daily report strictly from activities of `input.reportDate`,
   * enforces `maxChars`, preserves user edits (is_user_edited = 1),
   * and safely falls back to LocalRuleProvider if external AI fails.
   */
  public async generateReport(input: {
    reportDate: string;
    provider: AIProviderType;
    model?: string;
    userConfirmedRemoteSend?: boolean;
    maxChars?: number;
    promptOverride?: string;
    onProgress?: (log: ReportProgressLog) => void;
  }): Promise<DailyReport> {
    if (typeof input.maxChars === 'number' && input.maxChars >= 120) {
      this.repo.updateSettings({ reportMaxChars: Math.floor(input.maxChars) });
    }
    this.persistProviderModel(input.provider, input.model);
    const settings = this.repo.getSettings();
    const effectiveMaxChars =
      typeof input.maxChars === 'number' && input.maxChars >= 120
        ? Math.floor(input.maxChars)
        : settings.reportMaxChars ?? 1000;

    // STRICT DATE GUARD: Only include activities whose occurredAtIso local date matches input.reportDate
    const activities = this.repo
      .listActivities({ date: input.reportDate })
      .filter((a) => a.occurredAtIso && a.occurredAtIso.slice(0, 10) === input.reportDate);

    // Collect candidate Jira keys from this date's activities (git, zoom, notes) to sync & verify assignee with Jira
    const candidateJiraKeys = new Set<string>();
    for (const act of activities) {
      for (const k of extractJiraKeys(act.title + ' ' + act.summary)) candidateJiraKeys.add(k);
      for (const ev of act.evidences ?? []) {
        for (const k of extractJiraKeys(ev.title + ' ' + ev.snippet + ' ' + (ev.externalRef ?? '') + ' ' + ev.links.join(' '))) {
          candidateJiraKeys.add(k);
        }
      }
    }

    let gitlabMrContextMap: Record<string, GitLabMrReviewContext> = this.cachedGitLabMrSyncer
      ? this.cachedGitLabMrSyncer(input.reportDate)
      : {};
    const jiraSyncPromise =
      this.jiraIssueSyncer && candidateJiraKeys.size > 0
        ? this.jiraIssueSyncer(Array.from(candidateJiraKeys)).catch(() => undefined)
        : Promise.resolve();
    const gitlabSyncPromise =
      this.gitlabMrSyncer && activities.length > 0
        ? this.gitlabMrSyncer(input.reportDate, activities)
            .then((res) => {
              gitlabMrContextMap = res;
            })
            .catch(() => undefined)
        : Promise.resolve();

    let syncTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([jiraSyncPromise, gitlabSyncPromise]),
        new Promise<void>((resolve) => {
          syncTimer = setTimeout(resolve, 3_000);
          syncTimer.unref?.();
        })
      ]);
    } finally {
      if (syncTimer) clearTimeout(syncTimer);
    }

    const dayJiraKeys = this.repo.extractJiraKeysForDate(input.reportDate);
    const jiraContextMap = this.repo.getJiraContextMap(dayJiraKeys);

    const attemptAt = toLocalIsoString(new Date());

    // Account for existing user-edited items' character length so total stays <= effectiveMaxChars
    const existingReport = this.repo.getDailyReport(input.reportDate);
    const userEditedItems = existingReport?.items.filter((i) => i.isUserEdited) ?? [];
    const userEditedChars =
      userEditedItems.length > 0
        ? userEditedItems.map((i) => `- ${i.text.replace(/^[-•*]\s*/, '')}`).join('\n').length + 1
        : 0;
    const remainingBudget = Math.max(0, effectiveMaxChars - userEditedChars);
    const providerBudget = Math.max(120, remainingBudget);

    const { provider: providerInstance, isCli, modelUsed } = this.getProviderInstance(input.provider, input.model);

    input.onProgress?.({
      timestamp: getNowHhmmss(),
      step: 'init',
      message: `Rapor oluşturma başlatıldı (${input.reportDate}). Sağlayıcı: ${input.provider}${modelUsed ? ` (${modelUsed})` : ''}`
    });
    input.onProgress?.({
      timestamp: getNowHhmmss(),
      step: 'gathering',
      message: `Günün aktiviteleri filtrelendi (${activities.length} aktivite bulundu).`
    });
    if (dayJiraKeys.length > 0) {
      input.onProgress?.({
        timestamp: getNowHhmmss(),
        step: 'context',
        message: `${dayJiraKeys.length} adet Jira iş anahtarı bağlamı çözümlendi (${dayJiraKeys.join(', ')}).`
      });
    }
    const mrReviewCount = new Set(
      Object.values(gitlabMrContextMap)
        .filter((m) => m.isReviewFix)
        .map((m) => `${m.projectId}:!${m.mrIid}`)
    ).size;
    if (mrReviewCount > 0) {
      input.onProgress?.({
        timestamp: getNowHhmmss(),
        step: 'context',
        message: `GitLab API üzerinden ${mrReviewCount} adet MR review düzeltmesi tespit edildi.`
      });
    }
    input.onProgress?.({
      timestamp: getNowHhmmss(),
      step: 'prompt_prep',
      message: `Karakter bütçesi hesaplandı (Maks: ${effectiveMaxChars}, AI Bütçesi: ${providerBudget}).`
    });

    let effectiveProvider: string = input.provider;
    if (input.provider === 'gemini_cli') {
      effectiveProvider = `gemini_cli (Antigravity CLI / agy - ${modelUsed || 'gemini-4-argon-medium'})`;
    } else if (input.provider === 'openai') {
      effectiveProvider = isCli
        ? `openai (Codex CLI - ${modelUsed || 'gpt-6.1-sol'})`
        : `openai (API - ${modelUsed || 'gpt-4o-mini'})`;
    } else if (input.provider === 'anthropic') {
      effectiveProvider = isCli
        ? `anthropic (Claude CLI - ${modelUsed || 'claude-3-5-sonnet'})`
        : `anthropic (API - ${modelUsed || 'claude-3-5-sonnet'})`;
    } else if (input.provider === 'custom') {
      effectiveProvider = isCli
        ? `custom (Ollama CLI - ${modelUsed || 'llama'})`
        : `custom (API - ${modelUsed || 'custom'})`;
    }
    let draftItems;

    if (input.provider !== 'local_rule') {
      if (!settings.allowRemoteAiSend && !input.userConfirmedRemoteSend && !isCli) {
        throw new Error(
          'Uzak AI servisine veri gönderimi varsayılan olarak kapalıdır. Lütfen veri önizlemesini onaylayın veya Yerel Kurallı Motoru seçin.'
        );
      }

      try {
        input.onProgress?.({
          timestamp: getNowHhmmss(),
          step: 'ai_call',
          message: `${effectiveProvider} modeline bağlanılıyor... Yanıt bekleniyor.`
        });
        draftItems = await providerInstance.generateReportItems(
          input.reportDate,
          activities,
          providerBudget,
          undefined,
          jiraContextMap,
          input.promptOverride,
          input.onProgress,
          gitlabMrContextMap
        );
        this.repo.updateSyncState({
          connector: 'ai_provider',
          status: 'ok',
          lastAttemptAt: attemptAt,
          lastSuccessAt: attemptAt,
          lastError: null,
          recordsCount: draftItems.length
        });
      } catch (aiErr) {
        const errMsg = (aiErr as Error).message;
        this.repo.updateSyncState({
          connector: 'ai_provider',
          status: 'fallback_local',
          lastAttemptAt: attemptAt,
          lastError: `${input.provider} başarısız oldu, yerel kurallı motora geçildi: ${errMsg}`
        });
        input.onProgress?.({
          timestamp: getNowHhmmss(),
          step: 'fallback',
          message: `${input.provider} hatası: ${errMsg.slice(0, 100)}. Yerel kurallı motora geçiliyor...`
        });
        draftItems = await this.localProvider.generateReportItems(
          input.reportDate,
          activities,
          providerBudget,
          undefined,
          jiraContextMap,
          undefined,
          input.onProgress,
          gitlabMrContextMap
        );
        effectiveProvider = `local_rule (${input.provider} hata sonrası yerel yedek)`;
      }
    } else {
      draftItems = await this.localProvider.generateReportItems(
        input.reportDate,
        activities,
        providerBudget,
        undefined,
        jiraContextMap,
        undefined,
        input.onProgress,
        gitlabMrContextMap
      );
      this.repo.updateSyncState({
        connector: 'ai_provider',
        status: 'ok',
        lastAttemptAt: attemptAt,
        lastSuccessAt: attemptAt,
        lastError: null,
        recordsCount: draftItems.length
      });
    }

    const coveredEvidenceIds = new Set<string>(
      userEditedItems.flatMap((i) => i.evidenceIds)
    );
    const uncoveredDraftItems =
      userEditedItems.length > 0
        ? draftItems.filter(
            (gen) =>
              gen.evidenceIds.length === 0 ||
              gen.evidenceIds.some((eid) => !coveredEvidenceIds.has(eid))
          )
        : draftItems;

    const fittedItems =
      userEditedItems.length > 0 && remainingBudget < 20
        ? []
        : fitItemsToMaxChars(
            uncoveredDraftItems,
            userEditedItems.length > 0 ? remainingBudget : effectiveMaxChars
          );

    input.onProgress?.({
      timestamp: getNowHhmmss(),
      step: 'saving',
      message: `Rapor veritabanına taslak olarak kaydediliyor (${fittedItems.length} madde)...`
    });
    const savedReport = this.repo.saveGeneratedReport({
      reportDate: input.reportDate,
      providerUsed: effectiveProvider,
      generatedItems: fittedItems
    });
    input.onProgress?.({
      timestamp: getNowHhmmss(),
      step: 'complete',
      message: 'Günlük çalışma raporu başarıyla oluşturuldu.'
    });
    return savedReport;
  }

  public formatReportContent(report: DailyReport, format: 'md' | 'txt' | 'csv'): string {
    const jiraKeys =
      report.jiraKeys ?? this.repo.extractJiraKeysForDate(report.reportDate, report.items);

    if (format === 'csv') {
      const header = 'Tarih,Proje,IsAnahtari,Kategori,Durum,MaddeMetni,KanitSayisi,OnayDurumu';
      const rows = report.items.map((item) => {
        const cols = [
          report.reportDate,
          item.projectName ?? 'Genel',
          item.jiraKey ?? jiraKeys.join(' '),
          CATEGORY_LABELS[item.category] ?? item.category,
          STATUS_LABELS[item.itemStatus] ?? item.itemStatus,
          item.text.replace(/"/g, '""'),
          String(item.evidenceIds.length),
          report.status
        ];
        return cols.map((c) => `"${c}"`).join(',');
      });
      return [header, ...rows].join('\r\n');
    }

    const bulletLines = report.items.map(
      (i) => `- ${i.text.replace(/^[-•*]\s*/, '').trim()}`
    );

    if (format === 'txt') {
      const lines: string[] = [
        ...bulletLines,
        '',
        `Jira Numaraları: ${jiraKeys.length > 0 ? jiraKeys.join(', ') : 'Yok'}`
      ];
      return lines.join('\r\n');
    }

    // Default: Markdown ('md')
    const md: string[] = [
      `# Günlük Çalışma Raporu — ${report.reportDate}`,
      '',
      '## Sisteme Yüklenecek Rapor Özeti',
      '',
      ...bulletLines,
      '',
      '## Raporda Kullanılan Jira Numaraları',
      '',
      jiraKeys.length > 0 ? jiraKeys.map((k) => `- \`${k}\``).join('\n') : '_Jira numarası bulunmadı._',
      ''
    ];

    return md.join('\n');
  }
}
