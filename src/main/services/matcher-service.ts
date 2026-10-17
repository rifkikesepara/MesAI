import type { MesaiRepository } from '../db/repositories';
import type { Activity, Project } from '../../shared/types';

const JIRA_KEY_REGEX = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;

export function extractJiraKeys(text: string): string[] {
  const keys = new Set<string>();
  const matches = text.matchAll(JIRA_KEY_REGEX);
  for (const m of matches) {
    keys.add(m[1].toUpperCase());
  }
  return Array.from(keys);
}

export class MatcherService {
  constructor(private readonly repo: MesaiRepository) {}

  public matchActivityById(activityId: string): void {
    const act = this.repo.getActivityById(activityId);
    if (!act) return;
    this.matchActivity(act);
  }

  public matchActivity(act: Activity): void {
    const projects = this.repo.listProjects().filter((p) => p.enabled);
    const evidences = act.evidences ?? this.repo.getEvidencesForActivity(act.id);

    const combinedTextParts = [
      act.title,
      act.summary,
      act.chatOrRepoName ?? '',
      ...evidences.flatMap((e) => [
        e.title,
        e.snippet,
        e.externalRef ?? '',
        ...e.links,
        String(e.metadata?.branchName ?? '')
      ])
    ];
    const combinedText = combinedTextParts.join(' ');
    const jiraKeys = extractJiraKeys(combinedText);

    // 1. Deterministic Match: Explicit Jira Key in message/link/branch/commit
    if (jiraKeys.length > 0) {
      for (const jiraKey of jiraKeys) {
        const prefix = jiraKey.split('-')[0];
        const matchedProject =
          projects.find((p) =>
            p.jiraProjectKeys.some((k) => k.toUpperCase() === prefix)
          ) ??
          (act.projectId ? projects.find((p) => p.id === act.projectId) : null) ??
          null;

        const workItem = this.repo.upsertWorkItem({
          jiraKey,
          projectId: matchedProject?.id ?? act.projectId ?? null,
          title: `${jiraKey} İşi`,
          description: `Otomatik tespit edilen iş anahtarı: ${jiraKey}`
        });

        const hasAtlassianLink = evidences.some((e) =>
          e.links.some((l) => l.toLowerCase().includes(jiraKey.toLowerCase()))
        );
        const branchName = String(evidences[0]?.metadata?.branchName ?? '');
        const inBranch = branchName.toUpperCase().includes(jiraKey);

        const reason = hasAtlassianLink
          ? `Jira bağlantısı ve iş anahtarı (${jiraKey})`
          : inBranch
            ? `Git branch adı iş anahtarı içeriyor (${jiraKey})`
            : `Metin/commit içinde açık Jira iş anahtarı (${jiraKey})`;

        this.repo.upsertActivityLink({
          activityId: act.id,
          workItemId: workItem.id,
          projectId: workItem.projectId ?? matchedProject?.id ?? null,
          matchReason: reason,
          matchType: 'deterministic',
          confidence: 0.95,
          userStatus: 'accepted'
        });
      }
      return;
    }

    // 2. Deterministic Match: User-configured Chat Name -> Project mapping
    if (act.chatOrRepoName) {
      const chatLower = act.chatOrRepoName.toLowerCase().trim();
      const chatMatchedProject = projects.find((p) =>
        p.mappedChatNames.some((cn) => cn.toLowerCase().trim() === chatLower)
      );
      if (chatMatchedProject) {
        this.repo.upsertActivityLink({
          activityId: act.id,
          workItemId: null,
          projectId: chatMatchedProject.id,
          matchReason: `Kullanıcı tanımlı sohbet-proje eşleşmesi (${act.chatOrRepoName} -> ${chatMatchedProject.name})`,
          matchType: 'deterministic',
          confidence: 0.9,
          userStatus: 'accepted'
        });
        return;
      }
    }

    // 3. Deterministic Match: Explicit Project Name mentioned in text
    if (!act.projectId) {
      const lowerSummary = `${act.title} ${act.summary}`.toLowerCase();
      for (const proj of projects) {
        if (proj.name.length >= 3 && lowerSummary.includes(proj.name.toLowerCase())) {
          this.repo.upsertActivityLink({
            activityId: act.id,
            workItemId: null,
            projectId: proj.id,
            matchReason: `Metin içinde açık proje adı geçti (${proj.name})`,
            matchType: 'deterministic',
            confidence: 0.85,
            userStatus: 'accepted'
          });
          return;
        }
      }
    }

    // 4. Suggested Match (heuristic): Temporal proximity or keyword overlap with another active project/workItem on the same day
    this.createSuggestedMatches(act, projects);
  }

  private createSuggestedMatches(act: Activity, projects: Project[]): void {
    const actDate = act.occurredAtIso.slice(0, 10);
    const sameDayActivities = this.repo
      .listActivities({ date: actDate })
      .filter((other) => other.id !== act.id);

    const actTimeMs = Date.parse(act.occurredAtIso);
    const actWords = this.extractSignificantWords(`${act.title} ${act.summary}`);

    for (const other of sameDayActivities) {
      const otherLinks = other.links ?? [];
      const acceptedLink = otherLinks.find((l) => l.userStatus === 'accepted' && (l.workItemId || l.projectId));
      const candidateProjectId = other.projectId ?? acceptedLink?.projectId ?? null;
      const candidateWorkItemId = acceptedLink?.workItemId ?? null;

      if (!candidateProjectId && !candidateWorkItemId) continue;

      const otherTimeMs = Date.parse(other.occurredAtIso);
      const diffMinutes =
        !Number.isNaN(actTimeMs) && !Number.isNaN(otherTimeMs)
          ? Math.abs(actTimeMs - otherTimeMs) / 60_000
          : 999;

      const otherWords = this.extractSignificantWords(`${other.title} ${other.summary}`);
      const sharedWords = actWords.filter((w) => otherWords.includes(w));

      if (sharedWords.length >= 1 && diffMinutes <= 180) {
        this.repo.upsertActivityLink({
          activityId: act.id,
          workItemId: candidateWorkItemId,
          projectId: candidateProjectId,
          matchReason: `Öneri: Zaman yakınlığı (${Math.round(diffMinutes)} dk) ve ortak terim (${sharedWords.slice(0, 3).join(', ')})`,
          matchType: 'suggested',
          confidence: 0.65,
          userStatus: 'pending'
        });
        return;
      } else if (diffMinutes <= 30 && act.sourceType.startsWith('zoom_') && other.sourceType.startsWith('git_')) {
        const proj = projects.find((p) => p.id === candidateProjectId);
        this.repo.upsertActivityLink({
          activityId: act.id,
          workItemId: candidateWorkItemId,
          projectId: candidateProjectId,
          matchReason: `Öneri: ${proj?.name ?? 'Proje'} geliştirme aktivitesi ile yakın zamanlı (${Math.round(diffMinutes)} dk) görüşme`,
          matchType: 'suggested',
          confidence: 0.55,
          userStatus: 'pending'
        });
        return;
      }
    }
  }

  private extractSignificantWords(text: string): string[] {
    const stopWords = new Set([
      'bir', 'bu', 've', 'ile', 'için', 'de', 'da', 'mi', 'mı', 'mu', 'mü',
      'var', 'yok', 'gibi', 'daha', 'çok', 'ama', 'fakat', 'veya', 'ya',
      'ben', 'sen', 'biz', 'siz', 'onlar', 'olarak', 'olan', 'oldu', 'olur',
      'selam', 'merhaba', 'tamam', 'okey', 'evet', 'hayır', 'zoom', 'chat',
      'the', 'and', 'for', 'with', 'from', 'that', 'this', 'commit', 'branch'
    ]);
    return Array.from(
      new Set(
        text
          .toLowerCase()
          .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
          .split(/\s+/)
          .filter((w) => w.length >= 4 && !stopWords.has(w))
      )
    );
  }
}
