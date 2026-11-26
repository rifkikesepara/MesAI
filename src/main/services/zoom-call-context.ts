import type { Activity, ActivityComment, ZoomCallRecordInfo } from '../../shared/types';

export interface ZoomCallStatusInfo {
  isAnswered: boolean;
  mediaType: 'video' | 'audio' | 'unknown';
  direction: 'incoming' | 'outgoing' | 'unknown';
}

export interface CorrelatedZoomCallSession {
  callActivities: Activity[];
  occurredAtIso: string;
  rawTimestampText: string;
  mediaType: 'video' | 'audio' | 'unknown';
  direction: 'incoming' | 'outgoing' | 'unknown';
  preCallMessages: Activity[];
  postCallMessages: Activity[];
  allContextMessages: Activity[];
  userComments: string[];
  evidenceIds: string[];
  contextEvidenceIds: string[];
}

export interface NearbyDevelopmentContext {
  activity: Activity;
  diffMinutes: number;
  projectId: string | null;
  projectName: string | null;
  workItemId: string | null;
  jiraKey: string | null;
}

const UNANSWERED_CALL_REGEX =
  /\b(?:missed|declined|cancell?ed|no\s+answer|unanswered|busy|rejected|cevapsız|cevapsiz|yanıtsız|yanitsiz|reddedildi|iptal|yanıt\s+yok|yanit\s+yok|meşgul|mesgul)\b/i;

const EXCLUSION_COMMENT_REGEX =
  /(?:rapora\s+(?:ekleme|dahil\s+etme|yazma|alma|girmesin)|rapor\s+dışı|raporda\s+(?:gösterme|yer\s+almasın)|hariç\s+tut|haric\s+tut|yoksay|kişisel\s+(?:görüşme|arama|sohbet)|özel\s+görüşme)/i;

export function classifyZoomCallStatus(
  callRecord?: ZoomCallRecordInfo | null,
  fallbackText?: string | null
): ZoomCallStatusInfo {
  const combined = `${callRecord?.statusText ?? ''} ${callRecord?.iconLabel ?? ''} ${fallbackText ?? ''}`.trim();
  const isAnswered = combined.length === 0 ? true : !UNANSWERED_CALL_REGEX.test(combined);

  let mediaType: 'video' | 'audio' | 'unknown' = 'unknown';
  if (/\b(?:video|görüntülü|goruntulu)\b/i.test(combined)) {
    mediaType = 'video';
  } else if (/\b(?:audio|voice|sesli)\b/i.test(combined)) {
    mediaType = 'audio';
  }

  let direction: 'incoming' | 'outgoing' | 'unknown' =
    callRecord?.direction === 'incoming' || callRecord?.direction === 'outgoing'
      ? callRecord.direction
      : 'unknown';
  if (direction === 'unknown') {
    if (/\b(?:incoming|gelen)\b/i.test(combined)) direction = 'incoming';
    else if (/\b(?:outgoing|giden)\b/i.test(combined)) direction = 'outgoing';
  }

  return { isAnswered, mediaType, direction };
}

export function hasUserComments(act: Activity): boolean {
  return Boolean(act.comments && act.comments.some((c) => c.content.trim().length > 0));
}

export function getActivityUserComments(act: Activity): string[] {
  return (act.comments ?? []).map((c) => c.content.trim()).filter(Boolean);
}

export function combineActivityCommentsText(act: Activity): string {
  return getActivityUserComments(act).join(' | ');
}

export function isExclusionActivityComment(comments?: ActivityComment[] | null): boolean {
  if (!comments || comments.length === 0) return false;
  return comments.some((c) => EXCLUSION_COMMENT_REGEX.test(c.content));
}

export function isAnsweredZoomCallActivity(act: Activity): boolean {
  if (act.sourceType !== 'zoom_call') return false;
  const evMeta = (act.evidences ?? [])[0]?.metadata as Record<string, unknown> | undefined;
  if (evMeta && typeof evMeta.callAnswered === 'boolean') {
    return evMeta.callAnswered;
  }
  const callRec = (evMeta?.callRecord as ZoomCallRecordInfo | null | undefined) ?? null;
  return classifyZoomCallStatus(callRec, `${act.title} ${act.summary}`).isAnswered;
}

/**
 * Determines whether a zoom_call activity should participate in matching & report generation.
 * Excluded comments suppress it; explicit user comments rescue even missed/dropped calls;
 * otherwise only answered calls are reportable.
 */
export function isReportableZoomCallActivity(act: Activity): boolean {
  if (act.sourceType !== 'zoom_call') return false;
  if (isExclusionActivityComment(act.comments)) return false;
  if (hasUserComments(act)) return true;
  return isAnsweredZoomCallActivity(act);
}

export function getZoomCallActivityMediaType(act: Activity): 'video' | 'audio' | 'unknown' {
  const evMeta = (act.evidences ?? [])[0]?.metadata as Record<string, unknown> | undefined;
  if (evMeta?.mediaType === 'video' || evMeta?.mediaType === 'audio') {
    return evMeta.mediaType;
  }
  const callRec = (evMeta?.callRecord as ZoomCallRecordInfo | null | undefined) ?? null;
  return classifyZoomCallStatus(callRec, `${act.title} ${act.summary}`).mediaType;
}

export function getZoomCallActivityDirection(act: Activity): 'incoming' | 'outgoing' | 'unknown' {
  const evMeta = (act.evidences ?? [])[0]?.metadata as Record<string, unknown> | undefined;
  const callRec = (evMeta?.callRecord as ZoomCallRecordInfo | null | undefined) ?? null;
  return classifyZoomCallStatus(callRec, `${act.title} ${act.summary}`).direction;
}

/**
 * Identifies pure greetings, availability checks, and call-initiation chatter ("sesli bakalım mı", "arayayım mı")
 * so temporal context resolution looks past coordination filler to capture the real technical subject.
 */
export function isPureGreetingOrCallCoordination(text: string): boolean {
  const raw = (text ?? '').trim();
  if (!raw) return true;
  // Never discard messages containing explicit Jira keys or URLs
  if (/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/.test(raw) || /https?:\/\//i.test(raw)) {
    return false;
  }

  const clean = raw
    .toLowerCase()
    .replace(/[.,!?'"():;-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return true;
  if (clean.length > 68) return false;

  const patterns = [
    /^(?:abla\s+|abi\s+|hocam\s+|arkadaşlar\s+)?(?:selam|selamlar|merhaba|merhabalar|günaydın|iyi\s+çalışmalar|kolay\s+gelsin|iyi\s+akşamlar)(?:\s+abla|\s+abi|\s+hocam|\s+arkadaşlar)?$/,
    /^(?:abla\s+|abi\s+|hocam\s+)?(?:müsait\s+misin|müsait\s+misiniz|müsaitim|uygun\s+musun|bakabilir\s+misin|vaktin\s+var\s+mı|bir\s+bakabilir\s+misin)(?:\s+abla|\s+abi|\s+hocam)?$/,
    /^(?:tamamdır|tamam|ok|okey|olur|teşekkürler|teşekkür\s+ederim|eline\s+sağlık|emeğine\s+sağlık|süper|harika|görüşürüz)$/,
    /^(?:bir\s+|hızlıca\s+|2\s*dk\s+|5\s*dk\s+)?(?:arayayım\s+mı|arayabilir\s+miyim|arayabilir\s+misin|sesli\s+bakalım\s+mı|görüntülü\s+bakalım\s+mı|zoom\s+açalım\s+mı|toplantı\s+açalım\s+mı|konuşalım\s+mı|aradım|arıyorum|geliyorum|geçiyorum|müsait\s+olunca\s+ara)$/
  ];
  return patterns.some((rx) => rx.test(clean));
}

function parseIsoMs(iso: string | null | undefined): number {
  if (!iso) return NaN;
  return Date.parse(iso);
}

/**
 * Correlates answered Zoom calls in a single conversation with surrounding technical chat messages:
 * 1) Near pre-call window (-90 min, bounded by <=60 min consecutive message gaps to isolate earlier topics)
 * 2) Extended pre-call fallback (-240 min) when near window only had greetings/call-setup or silence
 * 3) Immediate post-call follow-up window (+30 min) for links/decisions shared during or right after the call
 */
export function correlateZoomCallsForChat(
  rawCallActs: Activity[],
  rawChatActs: Activity[],
  options?: {
    nearPreWindowMin?: number;
    maxPreWindowMin?: number;
    sessionGapMin?: number;
    postWindowMin?: number;
    mergeCallGapMin?: number;
  }
): CorrelatedZoomCallSession[] {
  const nearPreWindowMin = options?.nearPreWindowMin ?? 90;
  const maxPreWindowMin = options?.maxPreWindowMin ?? 240;
  const sessionGapMin = options?.sessionGapMin ?? 60;
  const postWindowMin = options?.postWindowMin ?? 30;
  const mergeCallGapMin = options?.mergeCallGapMin ?? 45;

  const reportableCalls = rawCallActs
    .filter((c) => isReportableZoomCallActivity(c))
    .slice()
    .sort((a, b) => (a.occurredAtIso || a.createdAt).localeCompare(b.occurredAtIso || b.createdAt));

  if (reportableCalls.length === 0) return [];

  // Group closely spaced calls in the same chat (e.g. audio -> video switch or reconnect within 45 min)
  const callGroups: Activity[][] = [];
  for (const call of reportableCalls) {
    const lastGroup = callGroups[callGroups.length - 1];
    if (!lastGroup) {
      callGroups.push([call]);
      continue;
    }
    const prevCall = lastGroup[lastGroup.length - 1];
    const prevMs = parseIsoMs(prevCall.occurredAtIso);
    const currMs = parseIsoMs(call.occurredAtIso);
    const gapMin =
      !Number.isNaN(prevMs) && !Number.isNaN(currMs) ? Math.abs(currMs - prevMs) / 60_000 : 999;
    if (gapMin <= mergeCallGapMin) {
      lastGroup.push(call);
    } else {
      callGroups.push([call]);
    }
  }

  const meaningfulChats = rawChatActs
    .filter((m) => {
      if (isExclusionActivityComment(m.comments)) return false;
      if (hasUserComments(m)) return true;
      const hasLinks = (m.evidences ?? []).some((e) => (e.links ?? []).length > 0);
      if (hasLinks) return true;
      return !isPureGreetingOrCallCoordination(m.summary);
    })
    .slice()
    .sort((a, b) => (a.occurredAtIso || a.createdAt).localeCompare(b.occurredAtIso || b.createdAt));

  const sessions: CorrelatedZoomCallSession[] = [];

  for (let gIdx = 0; gIdx < callGroups.length; gIdx++) {
    const grp = callGroups[gIdx];
    const firstCall = grp[0];
    const lastCall = grp[grp.length - 1];
    const firstMs = parseIsoMs(firstCall.occurredAtIso);
    const lastMs = parseIsoMs(lastCall.occurredAtIso);
    const nextGroupFirstMs =
      gIdx + 1 < callGroups.length ? parseIsoMs(callGroups[gIdx + 1][0].occurredAtIso) : NaN;

    let preCallMessages: Activity[] = [];
    let postCallMessages: Activity[] = [];

    if (!Number.isNaN(firstMs) && !Number.isNaN(lastMs)) {
      const preCandidates = meaningfulChats.filter((m) => {
        const mMs = parseIsoMs(m.occurredAtIso);
        if (Number.isNaN(mMs)) return false;
        if (mMs > lastMs) return false;
        const minsBefore = (firstMs - mMs) / 60_000;
        return minsBefore <= maxPreWindowMin;
      });

      if (preCandidates.length > 0) {
        const latestPre = preCandidates[preCandidates.length - 1];
        const latestPreMs = parseIsoMs(latestPre.occurredAtIso);
        const latestDeltaMin = (firstMs - latestPreMs) / 60_000;

        // Whether latestPre is within nearPreWindowMin (<=90m) or fallback maxPreWindowMin (<=240m),
        // walk backwards collecting the contiguous discussion thread until a >sessionGapMin silence is hit.
        if (latestDeltaMin <= nearPreWindowMin || latestDeltaMin <= maxPreWindowMin) {
          const cluster: Activity[] = [latestPre];
          let anchorMs = latestPreMs;
          for (let i = preCandidates.length - 2; i >= 0; i--) {
            const cand = preCandidates[i];
            const candMs = parseIsoMs(cand.occurredAtIso);
            const gap = (anchorMs - candMs) / 60_000;
            if (gap <= sessionGapMin) {
              cluster.push(cand);
              anchorMs = candMs;
            } else {
              break;
            }
          }
          preCallMessages = cluster.reverse();
        }
      }

      postCallMessages = meaningfulChats.filter((m) => {
        const mMs = parseIsoMs(m.occurredAtIso);
        if (Number.isNaN(mMs) || mMs <= lastMs) return false;
        if (!Number.isNaN(nextGroupFirstMs) && mMs >= nextGroupFirstMs) return false;
        return (mMs - lastMs) / 60_000 <= postWindowMin;
      });
    } else {
      // Ambiguous timestamp fallback: use same-chat meaningful messages on the same day
      preCallMessages = meaningfulChats;
    }

    const seenIds = new Set<string>();
    const allContextMessages: Activity[] = [];
    for (const m of [...preCallMessages, ...postCallMessages]) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        allContextMessages.push(m);
      }
    }

    const mediaTypes = grp.map((c) => getZoomCallActivityMediaType(c));
    const mediaType: 'video' | 'audio' | 'unknown' = mediaTypes.includes('video')
      ? 'video'
      : mediaTypes.includes('audio')
        ? 'audio'
        : 'unknown';

    const directions = grp.map((c) => getZoomCallActivityDirection(c));
    const direction = directions.find((d) => d !== 'unknown') ?? 'unknown';

    const userComments = Array.from(
      new Set([
        ...grp.flatMap((c) => getActivityUserComments(c)),
        ...allContextMessages.flatMap((m) => getActivityUserComments(m))
      ])
    );

    const evidenceIds = Array.from(
      new Set(grp.flatMap((c) => (c.evidences ?? []).map((e) => e.id)))
    );
    const contextEvidenceIds = Array.from(
      new Set(allContextMessages.flatMap((m) => (m.evidences ?? []).map((e) => e.id)))
    );

    sessions.push({
      callActivities: grp,
      occurredAtIso: firstCall.occurredAtIso,
      rawTimestampText: firstCall.rawTimestampText,
      mediaType,
      direction,
      preCallMessages,
      postCallMessages,
      allContextMessages,
      userComments,
      evidenceIds,
      contextEvidenceIds
    });
  }

  return sessions;
}

export function findNearbyDevelopmentContext(
  callAct: Activity,
  allActivities: Activity[],
  maxDiffMinutes = 90
): NearbyDevelopmentContext | null {
  const callMs = parseIsoMs(callAct.occurredAtIso);
  if (Number.isNaN(callMs)) return null;

  let best: NearbyDevelopmentContext | null = null;

  for (const other of allActivities) {
    if (other.id === callAct.id) continue;
    if (isExclusionActivityComment(other.comments)) continue;
    const isDev =
      other.sourceType === 'git_commit' ||
      other.sourceType === 'git_working_tree' ||
      other.sourceType === 'file_change';
    if (!isDev) continue;

    const otherMs = parseIsoMs(other.occurredAtIso);
    if (Number.isNaN(otherMs)) continue;
    const diffMinutes = Math.abs(callMs - otherMs) / 60_000;
    if (diffMinutes > maxDiffMinutes) continue;

    const acceptedLink = (other.links ?? []).find(
      (l) => l.userStatus === 'accepted' && (l.workItemId || l.projectId)
    );
    const projectId = other.projectId ?? acceptedLink?.projectId ?? null;
    const projectName = other.projectName ?? acceptedLink?.projectName ?? other.chatOrRepoName ?? null;
    const workItemId = acceptedLink?.workItemId ?? null;
    const jiraKey = acceptedLink?.workItemJiraKey ?? null;

    if (!projectId && !projectName && !workItemId) continue;

    if (!best || diffMinutes < best.diffMinutes) {
      best = {
        activity: other,
        diffMinutes,
        projectId,
        projectName,
        workItemId,
        jiraKey
      };
    }
  }

  return best;
}
