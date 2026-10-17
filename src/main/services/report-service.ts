import type { MesaiRepository } from '../db/repositories';
import {
  AIProvider,
  AnthropicApiProvider,
  buildSanitizedAiPrompt,
  fitItemsToMaxChars,
  GeminiCliProvider,
  LocalRuleProvider,
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

  private getProviderInstance(provider: AIProviderType): AIProvider {
    const settings = this.repo.getSettings();
    switch (provider) {
      case 'gemini_cli':
        return this.geminiProvider;
      case 'openai':
        return new OpenAiApiProvider({
          providerType: 'openai',
          apiKeyResolver: () => this.aiApiKeyResolver?.('openai') ?? null,
          model: settings.aiModel
        });
      case 'anthropic':
        return new AnthropicApiProvider({
          apiKeyResolver: () => this.aiApiKeyResolver?.('anthropic') ?? null,
          model: settings.aiModel
        });
      case 'custom':
        return new OpenAiApiProvider({
          providerType: 'custom',
          apiKeyResolver: () => this.aiApiKeyResolver?.('custom') ?? null,
          model: settings.aiModel,
          customBaseUrl: settings.aiCustomBaseUrl
        });
      case 'local_rule':
      default:
        return this.localProvider;
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

    let effectiveProvider: string = input.provider;
    let draftItems;

    if (input.provider !== 'local_rule') {
      if (!settings.allowRemoteAiSend && !input.userConfirmedRemoteSend) {
        throw new Error(
          'Uzak AI servisine veri gönderimi varsayılan olarak kapalıdır. Lütfen veri önizlemesini onaylayın veya Yerel Kurallı Motoru seçin.'
        );
      }

      try {
        const providerInstance = this.getProviderInstance(input.provider);
        draftItems = await providerInstance.generateReportItems(
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
