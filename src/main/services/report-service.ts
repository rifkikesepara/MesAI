import type { MesaiRepository } from '../db/repositories';
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
  ActivityCategory,
  ActivityStatus,
  AiPreviewPayload,
  AIProviderType,
  DailyReport
} from '../../shared/types';

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

  public getGeminiProvider(): GeminiCliProvider {
    return this.geminiProvider;
  }

  public previewAiPayload(reportDate: string, maxChars?: number, providerOverride?: AIProviderType): AiPreviewPayload {
    const settings = this.repo.getSettings();
    const effectiveProvider = providerOverride ?? settings.aiProvider;
    const effectiveMaxChars =
      typeof maxChars === 'number' && maxChars >= 120
        ? Math.floor(maxChars)
        : settings.reportMaxChars ?? 1000;

    // Strictly filter to only activities belonging to reportDate
    const activities = this.repo
      .listActivities({ date: reportDate })
      .filter((a) => a.occurredAtIso && a.occurredAtIso.slice(0, 10) === reportDate);

    const dayJiraKeys = this.repo.extractJiraKeysForDate(reportDate);
    const jiraContextMap = this.repo.getJiraContextMap(dayJiraKeys);

    const sanitizedPromptPreview = buildSanitizedAiPrompt(
      reportDate,
      activities,
      effectiveMaxChars,
      jiraContextMap
    );

    const warnings: string[] = [
      `Yalnızca seçilen tarihe (${reportDate}) ait ${activities.length} aktivite rapora dahil edilir.`,
      `Maksimum karakter sınırı: ${effectiveMaxChars} karakter.`,
      'Mesajlar, kod diff özetleri ve Jira bağlamları <untrusted_evidence_json> bloğu içinde güvenilmeyen kaynak verisi olarak izole edilir.'
    ];
    if (!settings.allowRemoteAiSend && effectiveProvider !== 'local_rule') {
      warnings.push(
        'Ayarlarda "Uzak AI Gönderim İzni" kapalıdır. AI servisine veri gönderimi yapmak için önizleme onayı gereklidir.'
      );
    }

    return {
      reportDate,
      provider: effectiveProvider,
      activityCount: activities.length,
      sanitizedPromptPreview,
      warnings,
      maxChars: effectiveMaxChars
    };
  }

  private getProviderInstance(provider: AIProviderType): { provider: AIProvider; isCli: boolean } {
    const settings = this.repo.getSettings();
    switch (provider) {
      case 'gemini_cli':
        return { provider: this.geminiProvider, isCli: true };
      case 'openai': {
        const useCli =
          settings.aiOpenaiMode === 'cli' ||
          (settings.aiOpenaiMode !== 'api' &&
            (!this.aiApiKeyResolver?.('openai') || Boolean(CodexCliProvider.resolveCodexCliPath())));
        if (useCli && CodexCliProvider.resolveCodexCliPath()) {
          return {
            provider: new CodexCliProvider({ model: settings.aiOpenaiModel || settings.aiModel }),
            isCli: true
          };
        }
        return {
          provider: new OpenAiApiProvider({
            providerType: 'openai',
            apiKeyResolver: () => this.aiApiKeyResolver?.('openai') ?? null,
            model: settings.aiOpenaiModel || settings.aiModel,
            customBaseUrl: settings.aiOpenaiBaseUrl || undefined
          }),
          isCli: false
        };
      }
      case 'anthropic': {
        const useCli =
          settings.aiAnthropicMode === 'cli' ||
          (settings.aiAnthropicMode !== 'api' &&
            (!this.aiApiKeyResolver?.('anthropic') && Boolean(ClaudeCliProvider.resolveClaudeCliPath())));
        if (useCli && ClaudeCliProvider.resolveClaudeCliPath()) {
          return {
            provider: new ClaudeCliProvider({ model: settings.aiAnthropicModel || settings.aiModel }),
            isCli: true
          };
        }
        return {
          provider: new AnthropicApiProvider({
            apiKeyResolver: () => this.aiApiKeyResolver?.('anthropic') ?? null,
            model: settings.aiAnthropicModel || settings.aiModel
          }),
          isCli: false
        };
      }
      case 'custom': {
        const useCli =
          settings.aiCustomMode === 'cli' ||
          (settings.aiCustomMode !== 'api' &&
            !settings.aiCustomBaseUrl &&
            Boolean(OllamaCliProvider.resolveOllamaCliPath()));
        if (useCli && OllamaCliProvider.resolveOllamaCliPath()) {
          return {
            provider: new OllamaCliProvider({ model: settings.aiCustomModel || settings.aiModel }),
            isCli: true
          };
        }
        return {
          provider: new OpenAiApiProvider({
            providerType: 'custom',
            apiKeyResolver: () => this.aiApiKeyResolver?.('custom') ?? null,
            model: settings.aiCustomModel || settings.aiModel,
            customBaseUrl: settings.aiCustomBaseUrl
          }),
          isCli: false
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
    userConfirmedRemoteSend?: boolean;
    maxChars?: number;
    promptOverride?: string;
  }): Promise<DailyReport> {
    if (typeof input.maxChars === 'number' && input.maxChars >= 120) {
      this.repo.updateSettings({ reportMaxChars: Math.floor(input.maxChars) });
    }
    const settings = this.repo.getSettings();
    const effectiveMaxChars =
      typeof input.maxChars === 'number' && input.maxChars >= 120
        ? Math.floor(input.maxChars)
        : settings.reportMaxChars ?? 1000;

    // STRICT DATE GUARD: Only include activities whose occurredAtIso local date matches input.reportDate
    const activities = this.repo
      .listActivities({ date: input.reportDate })
      .filter((a) => a.occurredAtIso && a.occurredAtIso.slice(0, 10) === input.reportDate);

    const dayJiraKeys = this.repo.extractJiraKeysForDate(input.reportDate);
    if (this.jiraIssueSyncer && dayJiraKeys.length > 0) {
      try {
        await this.jiraIssueSyncer(dayJiraKeys);
      } catch {
        // non-blocking
      }
    }
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

    const { provider: providerInstance, isCli } = this.getProviderInstance(input.provider);

    let effectiveProvider: string = input.provider;
    if (input.provider === 'gemini_cli') {
      effectiveProvider = 'gemini_cli (Antigravity CLI / agy)';
    } else if (input.provider === 'openai') {
      effectiveProvider = isCli
        ? `openai (Codex CLI - ${settings.aiOpenaiModel || 'gpt-6.1-sol'})`
        : `openai (API - ${settings.aiOpenaiModel || 'gpt-4o-mini'})`;
    } else if (input.provider === 'anthropic') {
      effectiveProvider = isCli
        ? `anthropic (Claude CLI - ${settings.aiAnthropicModel || 'claude-3-5-sonnet'})`
        : `anthropic (API - ${settings.aiAnthropicModel || 'claude-3-5-sonnet'})`;
    } else if (input.provider === 'custom') {
      effectiveProvider = isCli
        ? `custom (Ollama CLI - ${settings.aiCustomModel || 'llama'})`
        : `custom (API - ${settings.aiCustomModel || 'custom'})`;
    }
    let draftItems;

    if (input.provider !== 'local_rule') {
      if (!settings.allowRemoteAiSend && !input.userConfirmedRemoteSend && !isCli) {
        throw new Error(
          'Uzak AI servisine veri gönderimi varsayılan olarak kapalıdır. Lütfen veri önizlemesini onaylayın veya Yerel Kurallı Motoru seçin.'
        );
      }

      try {
        draftItems = await providerInstance.generateReportItems(
          input.reportDate,
          activities,
          providerBudget,
          undefined,
          jiraContextMap,
          input.promptOverride
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
        draftItems = await this.localProvider.generateReportItems(
          input.reportDate,
          activities,
          providerBudget,
          undefined,
          jiraContextMap
        );
        effectiveProvider = `local_rule (${input.provider} hata sonrası yerel yedek)`;
      }
    } else {
      draftItems = await this.localProvider.generateReportItems(
        input.reportDate,
        activities,
        providerBudget,
        undefined,
        jiraContextMap
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

    return this.repo.saveGeneratedReport({
      reportDate: input.reportDate,
      providerUsed: effectiveProvider,
      generatedItems: fittedItems
    });
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
