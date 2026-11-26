import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MesaiDatabase } from '../src/main/db/database';
import { MesaiRepository } from '../src/main/db/repositories';
import { getTodayLocalDate, resolveZoomTimestamp } from '../src/main/services/timestamp-resolver';
import { MatcherService } from '../src/main/services/matcher-service';
import { GitFileWatcherService, shouldExcludeFilePath } from '../src/main/services/git-file-watcher';
import { GeminiCliProvider, buildSanitizedAiPrompt } from '../src/main/services/ai-provider';
import { correlateZoomCallsForChat } from '../src/main/services/zoom-call-context';
import { ReportService } from '../src/main/services/report-service';
import { ZoomReaderAdapter } from '../src/main/services/zoom-adapter';
import { IntegrationsService } from '../src/main/services/integrations-service';
import { isNewerVersion, parseSemver, UpdateService } from '../src/main/services/update-service';
import type { ZoomChatSnapshot } from '../src/shared/types';

function createSampleSnapshot(overrides?: Partial<ZoomChatSnapshot>): ZoomChatSnapshot {
  return {
    schemaVersion: '1.1',
    status: 'ok',
    capturedAt: '2026-10-16T17:30:00.000+03:00',
    windowTitle: 'Zoom Workplace',
    windowState: 'normal',
    chatName: 'BAM Ekibi',
    chatType: 'Channel',
    sessionId: 'session-bam-123',
    limitations: ['No persistent message ID'],
    messages: [
      {
        indexInDom: 1,
        occurrenceIndexInView: 1,
        fingerprint: 'fp_msg_1',
        uiaRuntimeId: '42.1.100',
        persistentMessageId: null,
        isGroupedFollowUp: false,
        dateGroup: 'Today',
        visibleTimestamp: '16:25',
        sender: 'You',
        senderResolved: 'Rıfkı Kesepara',
        isSentByMe: true,
        messageType: 'text',
        text: 'BAM-4066 geliştirmesini inceliyorum',
        links: ['https://32bitbilgisayar.atlassian.net/browse/BAM-4066'],
        rawAccessibleLabel: 'You, Available, BAM-4066 geliştirmesini inceliyorum, 16:25'
      },
      {
        indexInDom: 2,
        occurrenceIndexInView: 1,
        fingerprint: 'fp_msg_2',
        uiaRuntimeId: '42.1.101',
        persistentMessageId: null,
        isGroupedFollowUp: false,
        dateGroup: 'Today',
        visibleTimestamp: '16:30',
        sender: 'Yasin Kamış',
        senderResolved: 'Yasin Kamış',
        isSentByMe: false,
        messageType: 'call',
        text: null,
        links: [],
        callRecord: {
          direction: 'incoming',
          iconLabel: 'Video Incoming',
          statusText: 'Incoming video call - accepted'
        },
        rawAccessibleLabel: 'Yasin Kamış, Incoming video call, 16:30'
      }
    ],
    ...overrides
  };
}

describe('MesAI Core Verification Suite', () => {
  it('1. Relative timestamps ("Today", "Yesterday", "Wed") resolve with local timezone and preserve original expression', () => {
    // 2026-10-16 is a Friday
    const capturedAt = '2026-10-16T17:30:00.000+03:00';

    const todayRes = resolveZoomTimestamp('Today', '16:25', capturedAt);
    assert.equal(todayRes.rawTimestampText, 'Today 16:25');
    assert.equal(todayRes.resolvedDate, '2026-10-16');
    assert.equal(todayRes.resolvedTimestampIso, '2026-10-16T16:25:00+03:00');
    assert.equal(todayRes.confidence, 'resolved_relative');

    const yesterdayRes = resolveZoomTimestamp('Yesterday', '09:15', capturedAt);
    assert.equal(yesterdayRes.rawTimestampText, 'Yesterday 09:15');
    assert.equal(yesterdayRes.resolvedDate, '2026-10-15');
    assert.equal(yesterdayRes.resolvedTimestampIso, '2026-10-15T09:15:00+03:00');

    // Wednesday before Friday 2026-10-16 is 2026-10-14 (2 days prior)
    const wedRes = resolveZoomTimestamp('Wed', 'Wed 11:55', capturedAt);
    assert.equal(wedRes.rawTimestampText, 'Wed 11:55');
    assert.equal(wedRes.resolvedDate, '2026-10-14');
    assert.equal(wedRes.resolvedTimestampIso, '2026-10-14T11:55:00+03:00');

    // Month-day expressions ("Sep 1, 09:50", "Oct 6, 15:09") must resolve to their actual calendar dates, never today
    const sepRes = resolveZoomTimestamp('Sep 1, 09:50', '09:50', capturedAt);
    assert.equal(sepRes.resolvedDate, '2026-09-01');
    assert.equal(sepRes.resolvedTimestampIso, '2026-09-01T09:50:00+03:00');

    const octRes = resolveZoomTimestamp('Oct 6', '15:09', capturedAt);
    assert.equal(octRes.resolvedDate, '2026-10-06');
    assert.equal(octRes.resolvedTimestampIso, '2026-10-06T15:09:00+03:00');

    // Ambiguous expression without time
    const ambRes = resolveZoomTimestamp('Last Month', '', capturedAt);
    assert.equal(ambRes.confidence, 'ambiguous');
    assert.equal(ambRes.resolvedTimestampIso, null);
    assert.equal(ambRes.rawTimestampText, 'Last Month');
  });

  it('2. Repeated Zoom snapshots do not duplicate messages, while identical texts sent twice are preserved', () => {
    const db = new MesaiDatabase(':memory:');
    const repo = new MesaiRepository(db);

    const snap1 = createSampleSnapshot({
      messages: [
        {
          indexInDom: 1,
          occurrenceIndexInView: 1,
          fingerprint: 'fp_same_1',
          uiaRuntimeId: '42.1.201',
          persistentMessageId: null,
          isGroupedFollowUp: false,
          dateGroup: 'Today',
          visibleTimestamp: '16:40',
          sender: 'Yasin Kamış',
          senderResolved: 'Yasin Kamış',
          isSentByMe: false,
          messageType: 'text',
          text: 'Tamam bakıyorum',
          links: [],
          rawAccessibleLabel: null
        },
        {
          indexInDom: 2,
          occurrenceIndexInView: 2, // Same sender, same minute, same text sent a second time!
          fingerprint: 'fp_same_2',
          uiaRuntimeId: '42.1.202',
          persistentMessageId: null,
          isGroupedFollowUp: true,
          dateGroup: 'Today',
          visibleTimestamp: '16:40',
          sender: 'Yasin Kamış',
          senderResolved: 'Yasin Kamış',
          isSentByMe: false,
          messageType: 'text',
          text: 'Tamam bakıyorum',
          links: [],
          rawAccessibleLabel: null
        }
      ]
    });

    const firstRun = repo.ingestZoomSnapshot(snap1);
    assert.equal(firstRun.newMessagesCount, 2, 'Both distinct occurrences must be saved');

    // Re-ingest the exact same snapshot (even if UIA RuntimeIds changed due to virtual list remount)
    const snap2 = structuredClone(snap1);
    snap2.capturedAt = '2026-10-16T17:31:00.000+03:00';
    snap2.messages[0].uiaRuntimeId = '42.1.999';
    snap2.messages[1].uiaRuntimeId = '42.1.998';

    const secondRun = repo.ingestZoomSnapshot(snap2);
    assert.equal(secondRun.newMessagesCount, 0, 'Repeated snapshot must produce 0 duplicates');
    assert.equal(secondRun.updatedMessagesCount, 2, 'Both records should update last_seen_at');

    const allActs = repo.listActivities({ date: '2026-10-16' });
    assert.equal(allActs.length, 2);
    db.close();
  });

  it('3. Records persist across database restarts and failed Zoom polls do not wipe existing data', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesai-persist-'));
    const dbPath = path.join(tmpDir, 'mesai.sqlite');

    {
      const db1 = new MesaiDatabase(dbPath);
      const repo1 = new MesaiRepository(db1);
      const res = repo1.ingestZoomSnapshot(createSampleSnapshot());
      assert.equal(res.newMessagesCount, 2);
      db1.close();
    }

    // Reopen database simulating application restart
    {
      const db2 = new MesaiDatabase(dbPath);
      const repo2 = new MesaiRepository(db2);

      // Simulate a failed / minimized / closed Zoom snapshot
      const closedSnap = createSampleSnapshot({
        status: 'zoom_not_running',
        errorMessage: 'Zoom kapalı',
        messages: []
      });
      const resClosed = repo2.ingestZoomSnapshot(closedSnap);
      assert.equal(resClosed.newMessagesCount, 0);

      const activities = repo2.listActivities({ date: '2026-10-16' });
      assert.equal(activities.length, 2, 'Previously collected activities must remain intact after restart and closed poll');
      db2.close();
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('4. Protective file filters and uncommitted file activity (BR-01: never marked completed or given fake duration)', () => {
    const globals = ['node_modules', 'target', 'dist', 'build'];
    assert.equal(shouldExcludeFilePath('node_modules/react/index.js', globals, []), true);
    assert.equal(shouldExcludeFilePath('.git/HEAD', globals, []), true);
    assert.equal(shouldExcludeFilePath('.env.local', globals, []), true);
    assert.equal(shouldExcludeFilePath('src/App.tsx.tmp', globals, []), true);
    assert.equal(shouldExcludeFilePath('src/components/Dashboard.tsx', globals, []), false);

    const db = new MesaiDatabase(':memory:');
    const repo = new MesaiRepository(db);
    const matcher = new MatcherService(repo);
    const watcher = new GitFileWatcherService(repo, matcher, 50);

    const proj = repo.upsertDiscoveredProject({
      name: '32Bit-Portal',
      rootPath: 'C:\\Repos\\32Bit',
      currentBranch: 'feature/BAM-4066'
    });

    // Ignored file should not create pending changes
    watcher.handleRawFileEvent(proj, 'node_modules/pkg/index.js');
    watcher.handleRawFileEvent(proj, '.git/index');
    assert.equal(watcher.flushDebouncedFileChanges(proj), null);

    // Valid source file change without commit
    watcher.handleRawFileEvent(proj, 'src/services/OrderService.ts');
    const actId = watcher.flushDebouncedFileChanges(proj);
    assert.ok(actId, 'Uncommitted file change must be recorded');

    const act = repo.getActivityById(actId!);
    assert.ok(act);
    assert.equal(act.status, 'in_progress', 'BR-01: Uncommitted file change must be in_progress, never completed');
    assert.equal(act.durationMinutes, null, 'BR-01: Must not fabricate duration from file changes');

    watcher.stopAllWatchers();
    db.close();
  });

  it('5. Evidence consolidation under same Jira WorkItem, report generation, user edit preservation, re-approval, and AI error fallback', async () => {
    const db = new MesaiDatabase(':memory:');
    const repo = new MesaiRepository(db);
    const matcher = new MatcherService(repo);

    const proj = repo.upsertDiscoveredProject({
      name: 'BAM-Service',
      rootPath: 'C:\\Repos\\BAM-Service',
      currentBranch: 'feature/BAM-4066',
      defaultJiraKeys: ['BAM']
    });

    // 1. Ingest Zoom chat mentioning BAM-4066 + a contextual call record in BAM Ekibi,
    // plus a separate contextless call record in another chat to verify insufficient-evidence safety!
    const snap = createSampleSnapshot();
    const zoomIngest = repo.ingestZoomSnapshot(snap);
    for (const actId of zoomIngest.newActivityIds) {
      matcher.matchActivityById(actId);
    }

    const contextlessCallSnap = createSampleSnapshot({
      chatName: 'Dış Paydaş',
      chatType: 'Direct',
      sessionId: 'session-ext-call',
      messages: [
        {
          indexInDom: 1,
          occurrenceIndexInView: 1,
          fingerprint: 'fp_ext_call_1',
          uiaRuntimeId: '42.9.1',
          persistentMessageId: null,
          isGroupedFollowUp: false,
          dateGroup: 'Today',
          visibleTimestamp: '11:00',
          sender: 'Dış Paydaş',
          senderResolved: 'Dış Paydaş',
          isSentByMe: false,
          messageType: 'call',
          text: null,
          links: [],
          callRecord: {
            direction: 'incoming',
            iconLabel: 'Audio Incoming',
            statusText: 'Incoming audio call - accepted'
          },
          rawAccessibleLabel: 'Dış Paydaş, Incoming audio call, 11:00'
        }
      ]
    });
    const extCallIngest = repo.ingestZoomSnapshot(contextlessCallSnap);
    for (const actId of extCallIngest.newActivityIds) {
      matcher.matchActivityById(actId);
    }

    // 2. Ingest Git commit mentioning BAM-4066
    const gitCommit = repo.ingestGitOrFileActivity({
      projectId: proj.id,
      projectName: proj.name,
      sourceType: 'git_commit',
      dedupKey: 'git:commit:bam:abc12345',
      externalId: 'abc12345',
      branchName: 'feature/BAM-4066',
      occurredAtIso: '2026-10-16T17:10:00+03:00',
      rawTimestampText: '17:10',
      title: 'BAM-Service — Commit abc12345',
      summary: 'BAM-4066: Validasyon kuralları eklendi'
    });
    matcher.matchActivityById(gitCommit.activityId);

    // Verify both Zoom chat and Git commit matched to the same BAM-4066 WorkItem
    const workItems = repo.listWorkItems();
    assert.equal(workItems.length, 1);
    assert.equal(workItems[0].jiraKey, 'BAM-4066');

    // 2b. Also ingest an old commit (2026-10-14) and an old Zoom message (Oct 6) — MUST NOT appear in 2026-10-16 report!
    repo.ingestGitOrFileActivity({
      projectId: proj.id,
      projectName: proj.name,
      sourceType: 'git_commit',
      dedupKey: 'git:commit:bam:old999',
      externalId: 'old999',
      branchName: 'feature/BAM-1111',
      occurredAtIso: '2026-10-14T10:00:00+03:00',
      rawTimestampText: '10:00',
      title: 'BAM-Service — Old Commit',
      summary: 'BAM-1111: Eski tarihli geliştirme'
    });

    // 3. Generate report with simulated failing/malformed AI provider -> must fall back to local_rule without losing data
    repo.updateSettings({ allowRemoteAiSend: true });
    const brokenGemini = new GeminiCliProvider(async () => '{ broken_json: true ');
    const reportService = new ReportService(repo, brokenGemini);

    const report1 = await reportService.generateReport({
      reportDate: '2026-10-16',
      provider: 'gemini_cli',
      userConfirmedRemoteSend: true,
      maxChars: 600
    });

    assert.ok(report1.providerUsed.includes('local_rule'), 'Must fall back to local_rule when AI returns invalid JSON');
    assert.ok(report1.items.length >= 2, 'Should have consolidated BAM-4066 item + call record item');

    // Verify strict date isolation: BAM-1111 from 2026-10-14 must NOT be in 2026-10-16 report or jiraKeys
    assert.ok(report1.jiraKeys?.includes('BAM-4066'), 'Must extract BAM-4066 for 2026-10-16');
    assert.ok(!report1.jiraKeys?.includes('BAM-1111'), 'Must NOT include BAM-1111 from 2026-10-14 in 2026-10-16 report');

    // Verify formattedSummary starts with "- ", has no "[Proje - BAM-4066]" prefix, and fits within maxChars
    assert.ok(report1.formattedSummary?.startsWith('- '), 'Formatted summary must use "- " bullet format');
    assert.ok(!report1.formattedSummary?.includes('[BAM-Service'), 'Must not include noisy bracket prefixes in bullet text');
    assert.ok((report1.formattedSummary?.length ?? 0) <= 600, 'Formatted summary must respect maxChars limit');

    // Find the consolidated BAM-4066 item and verify it links to Git + Zoom chat + contextual Zoom call evidences
    const bamItem = report1.items.find((i) => i.jiraKey === 'BAM-4066');
    assert.ok(bamItem, 'Consolidated BAM-4066 report item must exist');
    assert.equal(
      bamItem.evidenceIds.length,
      3,
      'Must preserve Git commit + Zoom chat + correlated Zoom call evidence IDs'
    );

    for (const evId of bamItem.evidenceIds) {
      const ev = repo.getEvidenceById(evId);
      assert.ok(ev, `Evidence ${evId} must be retrievable from report item`);
    }

    // Verify call record item did NOT fabricate duration or content
    const callItem = report1.items.find((i) => i.category === 'meeting');
    assert.ok(callItem, 'Call record item must exist');
    assert.equal(callItem.isInsufficientEvidence, true, 'Call record without transcript must be flagged as insufficient evidence');
    assert.equal(callItem.durationNote, null, 'Must not fabricate call duration');

    // 4. User edits the BAM-4066 report item and approves the report
    const editedText = 'Ticket Süreci kapsamında validasyon kuralları geliştirildi ve ekip içi doğrulandı.';
    repo.updateReportItem({
      itemId: bamItem.id,
      text: editedText,
      category: bamItem.category,
      itemStatus: 'completed',
      projectId: proj.id
    });

    const approvedReport = repo.approveReport(report1.id, 'Yönetici paylaşımına hazır.');
    assert.equal(approvedReport.status, 'approved');

    // 5. Regenerating the report must NOT overwrite user-edited item, and must transition status to 'needs_reapproval'
    const regenerated = await reportService.generateReport({
      reportDate: '2026-10-16',
      provider: 'local_rule',
      maxChars: 180
    });
    assert.equal(regenerated.status, 'needs_reapproval', 'Approved report must require re-approval after change/regeneration');
    assert.ok((regenerated.formattedSummary?.length ?? 0) <= 180, 'Regenerated report must also respect tight maxChars limit');

    const preservedItem = regenerated.items.find((i) => i.id === bamItem.id);
    assert.ok(preservedItem, 'User-edited item must be preserved across regeneration');
    assert.equal(preservedItem.text, editedText);
    assert.equal(preservedItem.isUserEdited, true);

    db.close();
  });

  it('6. ZoomReaderAdapter prevents concurrent reader processes and integrates with real ZoomChatReader.exe', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesai-zoom-'));
    const db = new MesaiDatabase(':memory:');
    const repo = new MesaiRepository(db);
    const matcher = new MatcherService(repo);
    const adapter = new ZoomReaderAdapter(repo, matcher, { stateDir: tmpDir });

    let exePath = adapter.resolveExecutablePath();
    if (!fs.existsSync(exePath)) {
      const { execSync } = await import('node:child_process');
      execSync('dotnet build readers/ZoomChatReader/ZoomChatReader.csproj -c Release', {
        stdio: 'pipe'
      });
      exePath = adapter.resolveExecutablePath();
    }
    assert.ok(fs.existsSync(exePath), `ZoomChatReader.exe must exist at ${exePath}`);

    // Trigger two concurrent polls simultaneously; one must execute and the other must be blocked by the single-flight lock
    const [r1, r2] = await Promise.all([adapter.pollOnce(), adapter.pollOnce()]);
    const blocked = [r1, r2].find((r) => r.error?.includes('eşzamanlı ikinci süreç engellendi'));
    assert.ok(blocked, 'Second concurrent pollOnce call must be blocked by single-instance lock');

    adapter.stop();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('7. Credentials are never stored in plaintext SQLite and unconfigured Jira/Jenkins report not_configured', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesai-sec-'));
    const db = new MesaiDatabase(':memory:');
    const repo = new MesaiRepository(db);
    const matcher = new MatcherService(repo);
    const zoom = new ZoomReaderAdapter(repo, matcher, { stateDir: tmpDir });
    const git = new GitFileWatcherService(repo, matcher);
    const rep = new ReportService(repo);

    const mockDpapi = {
      encrypt: (plain: string) => Buffer.from(`ENC:${plain}`, 'utf8').toString('base64'),
      decrypt: (cipher: string) => Buffer.from(cipher, 'base64').toString('utf8').replace(/^ENC:/, '')
    };

    const integrations = new IntegrationsService(repo, zoom, git, rep, {
      userDataDir: tmpDir,
      secretProvider: mockDpapi
    });

    const initialHealth = await integrations.getHealthSummary();
    assert.equal(initialHealth.jira.status, 'not_configured');
    assert.equal(initialHealth.gitlab.status, 'not_configured');
    assert.equal(initialHealth.jenkins.status, 'not_configured');

    integrations.saveIntegrationCredential({
      service: 'jira',
      url: 'https://32bitbilgisayar.atlassian.net',
      usernameOrEmail: 'rifki@example.com',
      token: 'SUPER_SECRET_JIRA_TOKEN_123'
    });

    // Verify token is NOT in SQLite settings table
    const rawSettingsRows = JSON.stringify(db.db.prepare('SELECT * FROM settings').all());
    assert.equal(
      rawSettingsRows.includes('SUPER_SECRET_JIRA_TOKEN_123'),
      false,
      'Plaintext API token must never be written to SQLite'
    );

    // Verify status is 'untested' until real connection test succeeds
    const afterSaveHealth = await integrations.getHealthSummary();
    assert.equal(afterSaveHealth.jira.status, 'untested');

    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('8. Evaluates group vs 1-on-1 Zoom chats separately, ignores pure greetings, and produces high-effort Jira/codeDiff prose', async () => {
    const db = new MesaiDatabase(':memory:');
    const repo = new MesaiRepository(db);
    const matcher = new MatcherService(repo);
    const rep = new ReportService(repo);

    const proj = repo.upsertDiscoveredProject({
      name: 'ticket',
      rootPath: 'C:\\Repos\\32Bit\\ticket',
      currentBranch: 'feature/BAM-4076',
      defaultJiraKeys: ['BAM']
    });

    // 1. Ingest Jira-linked commit with rich codeDiff
    const commitRes = repo.ingestGitOrFileActivity({
      projectId: proj.id,
      projectName: proj.name,
      sourceType: 'git_commit',
      dedupKey: 'git:commit:ticket:02a6b6a',
      externalId: '02a6b6a',
      branchName: 'feature/BAM-4076',
      occurredAtIso: '2026-10-16T09:05:00+03:00',
      rawTimestampText: '09:05',
      title: 'ticket — Commit 02a6b6a',
      summary: 'BAM-4076',
      changedFiles: [
        'src/components/LogFiles/index.jsx',
        'src/components/LogFiles/LogFilesContent.jsx',
        'src/pages/TicketEntry/validation.jsx'
      ],
      codeDiff:
        'FILE: src/components/LogFiles/index.jsx\n+ const productId = readOnly ? values?.product?.id : values?.product;\n+ BasicTooltip title={formik.errors.logFiles}\nFILE: src/pages/TicketEntry/validation.jsx\n+ logFiles: yup.object().nullable()'
    });
    matcher.matchActivityById(commitRes.activityId);

    // 2. Ingest a Group channel chat, a 1-on-1 technical DM, and a greeting-only 1-on-1 DM
    repo.ingestZoomSnapshot(
      createSampleSnapshot({
        chatName: 'BAM FE Standartları Hk.',
        chatType: 'Channel',
        messages: [
          {
            indexInDom: 1,
            occurrenceIndexInView: 1,
            fingerprint: 'fp_grp_std_1',
            uiaRuntimeId: '42.1.201',
            persistentMessageId: null,
            isGroupedFollowUp: false,
            dateGroup: 'Today',
            visibleTimestamp: '11:20',
            sender: 'Yasin Kamış',
            senderResolved: 'Yasin Kamış',
            isSentByMe: false,
            messageType: 'text',
            text: 'gönderi paylaş panelinde emoji ve bağlantı ikonları ile bildirim scroll durumu',
            links: [],
            rawAccessibleLabel: 'gönderi paylaş panelinde emoji ve bağlantı ikonları'
          }
        ]
      })
    );

    repo.ingestZoomSnapshot(
      createSampleSnapshot({
        chatName: 'Enes Ünlüer',
        chatType: 'Direct',
        messages: [
          {
            indexInDom: 1,
            occurrenceIndexInView: 1,
            fingerprint: 'fp_dm_enes_1',
            uiaRuntimeId: '42.1.202',
            persistentMessageId: null,
            isGroupedFollowUp: false,
            dateGroup: 'Today',
            visibleTimestamp: '14:15',
            sender: 'You',
            senderResolved: 'Rıfkı Kesepara',
            isSentByMe: true,
            messageType: 'text',
            text: 'multi-pod ortamında websocket bağlantısı kopuyor, nginx sticky session ayarını kontrol edelim',
            links: [],
            rawAccessibleLabel: 'multi-pod ortamında websocket bağlantısı kopuyor'
          }
        ]
      })
    );

    repo.ingestZoomSnapshot(
      createSampleSnapshot({
        chatName: 'Bahar Gülşe',
        chatType: 'Direct',
        messages: [
          {
            indexInDom: 1,
            occurrenceIndexInView: 1,
            fingerprint: 'fp_dm_bahar_1',
            uiaRuntimeId: '42.1.203',
            persistentMessageId: null,
            isGroupedFollowUp: false,
            dateGroup: 'Today',
            visibleTimestamp: '16:00',
            sender: 'You',
            senderResolved: 'Rıfkı Kesepara',
            isSentByMe: true,
            messageType: 'text',
            text: 'Abla selam',
            links: [],
            rawAccessibleLabel: 'Abla selam'
          }
        ]
      })
    );

    const report = await rep.generateReport({
      reportDate: '2026-10-16',
      provider: 'local_rule',
      maxChars: 1500
    });

    // Must have 3 distinct items: 1 high-effort BAM-4076 development item, 1 group chat item, 1 Enes DM item (greeting-only Bahar DM ignored)
    assert.equal(report.items.length, 3, 'Should keep group chat and 1-on-1 technical DM separate while ignoring greeting-only DM');
    const devItem = report.items.find((i) => i.category === 'development');
    assert.ok(devItem, 'Development item must exist');
    assert.ok(
      devItem.text.includes('LogFiles') && devItem.text.includes('BasicTooltip'),
      'Development item must reflect detailed codeDiff analysis (LogFiles, BasicTooltip, nullable validation)'
    );

    db.close();
  });

  it('9. Version comparison, update detection, and autoCheckUpdatesOnStartup setting persistence', async () => {
    // 1. Semver parsing
    assert.deepEqual(parseSemver('1.0.0'), [1, 0, 0]);
    assert.deepEqual(parseSemver('v1.2.34-beta.1'), [1, 2, 34]);
    assert.deepEqual(parseSemver('v2.0'), [2, 0, 0]);

    // 2. Newer version detection
    assert.equal(isNewerVersion('v1.0.1', '1.0.0'), true);
    assert.equal(isNewerVersion('1.1.0', '1.0.9'), true);
    assert.equal(isNewerVersion('2.0.0', '1.99.99'), true);
    assert.equal(isNewerVersion('v1.0.0', '1.0.0'), false);
    assert.equal(isNewerVersion('0.9.9', '1.0.0'), false);
    assert.equal(isNewerVersion('v1.0.0', 'v1.0.1'), false);

    // 3. Settings persistence in SQLite
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesai-updater-test-'));
    const db = new MesaiDatabase(path.join(tmpDir, 'test.sqlite'));
    const repo = new MesaiRepository(db);

    const initialSettings = repo.getSettings();
    assert.equal(
      initialSettings.autoCheckUpdatesOnStartup,
      true,
      'autoCheckUpdatesOnStartup should default to true'
    );

    const updated = repo.updateSettings({ autoCheckUpdatesOnStartup: false });
    assert.equal(updated.autoCheckUpdatesOnStartup, false);

    const reloaded = repo.getSettings();
    assert.equal(reloaded.autoCheckUpdatesOnStartup, false);

    // 4. UpdateService resolves package.json version and falls back when api.github.com returns 403
    const origFetch = globalThis.fetch;
    try {
      const updater = new UpdateService(() => null);
      assert.notEqual(updater.getState().currentVersion, '0.0.0', 'currentVersion must resolve from package.json');

      globalThis.fetch = (async (input: string | URL | Request) => {
        const u = String(input);
        if (u.includes('api.github.com')) {
          return new Response('rate limit exceeded', { status: 403, statusText: 'Forbidden' });
        }
        if (u.endsWith('/releases/latest')) {
          return new Response(JSON.stringify({ tag_name: 'v9.9.9' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (u.endsWith('/latest.yml')) {
          return new Response("version: 9.9.9\npath: MesAI-Setup-9.9.9.exe\nreleaseDate: '2026-11-08T12:00:00.000Z'\n", {
            status: 200
          });
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch;

      const state = await updater.checkForUpdates();
      assert.equal(state.status, 'available');
      assert.equal(state.updateInfo?.version, '9.9.9');
      assert.ok(state.updateInfo?.downloadUrl?.endsWith('MesAI-Setup-9.9.9.exe'));
    } finally {
      globalThis.fetch = origFetch;
    }

    db.close();
  });

  it('10. AI integration credentials encryption via secretProvider, OpenAI/Claude/Custom API configuration and health report', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesai-ai-test-'));
    const db = new MesaiDatabase(path.join(tmpDir, 'test.sqlite'));
    const repo = new MesaiRepository(db);
    const mockSecretProvider = {
      encrypt: (s: string) => Buffer.from(s, 'utf8').toString('base64'),
      decrypt: (b: string) => Buffer.from(b, 'base64').toString('utf8')
    };

    const matcher = new MatcherService(repo);
    const zoomAdapter = new ZoomReaderAdapter(repo, matcher, { stateDir: tmpDir });
    const gitWatcher = new GitFileWatcherService(repo, matcher);
    const reportService = new ReportService(repo);

    const integrations = new IntegrationsService(repo, zoomAdapter, gitWatcher, reportService, {
      userDataDir: tmpDir,
      secretProvider: mockSecretProvider
    });

    // 1. Initial health before configuration
    let health = await integrations.getHealthSummary();
    assert.equal(health.ai.openaiConfigured, false);
    assert.equal(health.ai.anthropicConfigured, false);
    assert.equal(health.ai.customConfigured, false);

    // 2. Save OpenAI credentials
    integrations.saveAiCredential({
      provider: 'openai',
      apiKey: 'sk-test-openai-12345',
      model: 'gpt-4o'
    });

    // Verify API key is NOT stored in plain text in sqlite
    const rawSqlite = fs.readFileSync(path.join(tmpDir, 'test.sqlite'), 'utf8');
    assert.ok(!rawSqlite.includes('sk-test-openai-12345'), 'OpenAI API key must never be in plain text in SQLite');

    // Verify key was decrypted properly via secretProvider
    assert.equal(integrations.getDecryptedAiToken('openai'), 'sk-test-openai-12345');

    // 3. Save Anthropic credentials
    integrations.saveAiCredential({
      provider: 'anthropic',
      apiKey: 'sk-ant-test-99999',
      model: 'claude-3-5-sonnet-20241022'
    });
    assert.equal(integrations.getDecryptedAiToken('anthropic'), 'sk-ant-test-99999');

    // 4. Save Custom endpoint
    integrations.saveAiCredential({
      provider: 'custom',
      apiKey: 'ollama-key',
      model: 'deepseek-chat',
      customBaseUrl: 'http://localhost:11434/v1'
    });
    assert.equal(integrations.getDecryptedAiToken('custom'), 'ollama-key');

    // 5. Health summary reflects configured state
    health = await integrations.getHealthSummary();
    assert.equal(health.ai.openaiConfigured, true);
    assert.equal(health.ai.anthropicConfigured, true);
    assert.equal(health.ai.customConfigured, true);
    assert.equal(health.ai.customBaseUrl, 'http://localhost:11434/v1');

    // 6. Test connection with invalid endpoint / dummy key should return graceful error, not crash
    const testRes = await integrations.testAiConnection('custom');
    assert.equal(typeof testRes.ok, 'boolean');
    assert.equal(typeof testRes.message, 'string');

    // 7. Verify reportService falls back safely to local_rule when remote AI fails
    repo.updateSettings({ aiProvider: 'openai', allowRemoteAiSend: true });
    repo.addManualNote({
      projectId: null,
      category: 'development',
      status: 'completed',
      title: 'AI Entegrasyon Geliştirmesi',
      summary: 'OpenAI, Anthropic ve Özel LLM entegrasyonu tamamlandı.'
    });

    const todayDate = getTodayLocalDate();
    const report = await reportService.generateReport({
      reportDate: todayDate,
      provider: 'openai',
      userConfirmedRemoteSend: true
    });

    // Dummy key will fail remote request and gracefully fall back to local rule
    assert.ok(report.providerUsed.includes('local_rule'), 'Should fall back to local_rule on remote failure');
    assert.ok(report.items.length > 0, 'Report items must not be lost on fallback');

    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('11. untrusted_evidence_json is never truncated mid-JSON and promptOverride is honored', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesai-prompt-test-'));
    const db = new MesaiDatabase(path.join(tmpDir, 'test.db'));
    const repo = new MesaiRepository(db);

    const today = getTodayLocalDate();

    // Create 40 activities to simulate a large work day
    for (let i = 0; i < 40; i++) {
      repo.addManualNote({
        projectId: null,
        category: 'development',
        status: 'completed',
        title: `Görev ${i} Kapsamlı Mimari Geliştirme ve Test`,
        summary: `Bileşen ${i} üzerinde kapsamlı refactoring gerçekleştirildi. LogFiles, InfiniteGrid ve BAM veri modelleri güncellendi. Kod diff detayı: function test${i}() { console.log("detaylı diff içeriği ${i}"); }`
      });
    }

    const activities = repo.listActivities({});
    const prompt = buildSanitizedAiPrompt(today, activities, 1000);
    assert.ok(
      prompt.includes('Maksimum Karakter Sınırı: 1000 karakter'),
      'Prompt must include exact user maxChars limit (1000)'
    );

    const prompt750 = buildSanitizedAiPrompt(today, activities, 750);
    assert.ok(
      prompt750.includes('Maksimum Karakter Sınırı: 750 karakter'),
      'Prompt must include exact user maxChars limit (750)'
    );

    // 1. untrusted_evidence_json tags must exist and match
    const openTag = '<untrusted_evidence_json>';
    const closeTag = '</untrusted_evidence_json>';
    const lastOpenIndex = prompt.lastIndexOf(openTag);
    const lastCloseIndex = prompt.lastIndexOf(closeTag);
    assert.ok(lastOpenIndex !== -1, 'Opening tag must exist');
    assert.ok(lastCloseIndex !== -1, 'Closing tag must exist and never be sliced off');
    assert.ok(lastCloseIndex > lastOpenIndex, 'Closing tag must come after opening tag');

    const jsonStr = prompt.slice(lastOpenIndex + openTag.length, lastCloseIndex).trim();
    let parsed: any;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(jsonStr);
    }, 'Evidence JSON inside <untrusted_evidence_json> must be 100% valid parseable JSON');
    assert.ok(parsed && typeof parsed === 'object', 'Parsed evidence payload must be an object');

    // 2. promptOverride is forwarded and honored by provider
    let receivedPrompt = '';
    const mockProvider = new GeminiCliProvider(async (p: string) => {
      receivedPrompt = p;
      return JSON.stringify({
        items: [
          {
            workItemId: null,
            projectId: null,
            category: 'development',
            itemStatus: 'completed',
            text: 'Özel prompt ile üretilen madde.',
            isInsufficientEvidence: false,
            insufficientReason: null,
            evidenceIds: []
          }
        ]
      });
    });

    const reportService = new ReportService(repo, mockProvider);

    const customUserPrompt = 'KULLANICI TARAFINDAN ÖZELLEŞTİRİLMİŞ PROMPT: Raporu buna göre üret.';
    const customReport = await reportService.generateReport({
      reportDate: today,
      provider: 'gemini_cli',
      userConfirmedRemoteSend: true,
      promptOverride: customUserPrompt
    });

    assert.equal(receivedPrompt, customUserPrompt, 'Provider must receive the user promptOverride verbatim');
    assert.ok(customReport.items.some((item) => item.text.includes('Özel prompt ile üretilen madde')));

    // 3. When promptOverride is not provided, generateReport passes exact maxChars into AI prompt
    await reportService.generateReport({
      reportDate: today,
      provider: 'gemini_cli',
      userConfirmedRemoteSend: true,
      maxChars: 650
    });
    assert.ok(
      receivedPrompt.includes('Maksimum Karakter Sınırı: 650 karakter'),
      'AI provider must receive exact maxChars (650) in generated prompt'
    );

    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('12. Jira keys in reports are extracted strictly from Git activities and never from Zoom chats', () => {
    const db = new MesaiDatabase(':memory:');
    const repo = new MesaiRepository(db);
    const matcher = new MatcherService(repo);

    const proj = repo.upsertDiscoveredProject({
      name: 'Portal-Service',
      rootPath: 'C:\\Repos\\Portal-Service',
      currentBranch: 'main',
      defaultJiraKeys: ['PORTAL']
    });

    // 1. Zoom chat mentions ZOOM-9999
    const zoomAct = repo.ingestZoomSnapshot({
      schemaVersion: '1.1',
      status: 'ok',
      capturedAt: '2026-10-19T10:00:00.000+03:00',
      windowTitle: 'Zoom Workplace',
      windowState: 'normal',
      chatName: 'Dev Ekibi',
      chatType: 'Channel',
      sessionId: 'session-zoom-key-test',
      limitations: [],
      messages: [
        {
          indexInDom: 1,
          occurrenceIndexInView: 1,
          fingerprint: 'fp_zoom_key_test',
          uiaRuntimeId: '99.1.1',
          persistentMessageId: null,
          isGroupedFollowUp: false,
          dateGroup: 'Today',
          visibleTimestamp: '10:00',
          sender: 'Teammate',
          senderResolved: 'Teammate',
          isSentByMe: false,
          messageType: 'text',
          text: 'ZOOM-9999 nolu bulguyu incelediniz mi?',
          links: ['https://jira.corp/browse/ZOOM-9999'],
          rawAccessibleLabel: 'ZOOM-9999 nolu bulguyu incelediniz mi?'
        }
      ]
    });
    for (const actId of zoomAct.newActivityIds) {
      matcher.matchActivityById(actId);
    }

    // 2. Git commit mentions COMMIT-1234
    const commitAct = repo.ingestGitOrFileActivity({
      projectId: proj.id,
      projectName: proj.name,
      sourceType: 'git_commit',
      dedupKey: 'git:commit:portal:1234',
      externalId: 'portal1234',
      branchName: 'feature/COMMIT-1234',
      occurredAtIso: '2026-10-19T11:00:00+03:00',
      rawTimestampText: '11:00',
      title: 'Portal-Service — Commit portal1234',
      summary: 'COMMIT-1234: Yetkilendirme servisi düzeltildi'
    });
    matcher.matchActivityById(commitAct.activityId);

    // 3. Extract Jira keys for 2026-10-19
    const extractedKeys = repo.extractJiraKeysForDate('2026-10-19');

    assert.ok(extractedKeys.includes('COMMIT-1234'), 'COMMIT-1234 from git commit must be extracted');
    assert.ok(!extractedKeys.includes('ZOOM-9999'), 'ZOOM-9999 from Zoom chat must NEVER be extracted');

    db.close();
  });

  it('13. GitLab Integration: credential storage via DPAPI, connection verification, and MR review fix detection in report prose', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesai-gitlab-test-'));
    const db = new MesaiDatabase(':memory:');
    const repo = new MesaiRepository(db);
    const zoom = new ZoomReaderAdapter(repo, new MatcherService(repo));
    const git = new GitFileWatcherService(repo, new MatcherService(repo));
    const rep = new ReportService(repo);

    const mockDpapi = {
      encrypt: (plain: string) => Buffer.from(`ENC:${plain}`, 'utf8').toString('base64'),
      decrypt: (cipher: string) => Buffer.from(cipher, 'base64').toString('utf8').replace(/^ENC:/, '')
    };

    const integrations = new IntegrationsService(repo, zoom, git, rep, {
      userDataDir: tmpDir,
      secretProvider: mockDpapi
    });

    // 1. Initially not_configured
    let health = await integrations.getHealthSummary();
    assert.equal(health.gitlab.status, 'not_configured');
    assert.equal(health.gitlab.configured, false);

    // 2. Save credentials
    integrations.saveIntegrationCredential({
      service: 'gitlab',
      url: 'https://gitlab.example.com',
      usernameOrEmail: 'rifkik',
      token: 'glpat-SECRET12345'
    });

    health = await integrations.getHealthSummary();
    assert.equal(health.gitlab.configured, true);
    assert.equal(health.gitlab.status, 'untested');

    // Verify token is NOT written in plaintext to SQLite
    const settingsRows = JSON.stringify(db.db.prepare('SELECT * FROM settings').all());
    assert.equal(settingsRows.includes('glpat-SECRET12345'), false);

    // 3. Test connection (mock global fetch)
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url: any, init: any) => {
        if (String(url).includes('/api/v4/user')) {
          assert.equal(init?.headers?.['PRIVATE-TOKEN'], 'glpat-SECRET12345');
          return new Response(JSON.stringify({ id: 42, username: 'rifkik', name: 'Rıfkı Kesepara' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response('Not found', { status: 404 });
      };

      const testResult = await integrations.testConnection('gitlab');
      assert.equal(testResult.ok, true);
      assert.ok(testResult.message.includes('Rıfkı Kesepara'));

      health = await integrations.getHealthSummary();
      assert.equal(health.gitlab.status, 'connected');
    } finally {
      globalThis.fetch = originalFetch;
    }

    // 4. Verify GitLab REST API MR review fix detection (both AI prompt preview and local report prose)
    // even when the local git activity message does NOT explicitly say "review"
    const proj = repo.upsertDiscoveredProject({
      name: 'CustomPortal',
      rootPath: 'C:\\Repos\\CustomPortal',
      repositoryUrl: 'https://gitlab.example.com/corp/custom-portal.git',
      currentBranch: 'feature/PORTAL-500'
    });

    const wtReviewFix = repo.ingestGitOrFileActivity({
      projectId: proj.id,
      projectName: proj.name,
      sourceType: 'git_working_tree',
      dedupKey: 'git:wt:portal:500',
      externalId: 'wt500',
      branchName: 'feature/PORTAL-500',
      occurredAtIso: '2026-10-19T15:00:00+03:00',
      rawTimestampText: '15:00',
      title: 'CustomPortal — Çalışma Ağacı (feature/PORTAL-500)',
      summary: 'Değişen dosyalar: src/services/auth.ts, src/validators/input.ts',
      changedFiles: ['src/services/auth.ts', 'src/validators/input.ts'],
      codeDiff: 'diff --git a/src/services/auth.ts b/src/services/auth.ts\n+if (!token) throw new Error("Token eksik");'
    });
    new MatcherService(repo).matchActivityById(wtReviewFix.activityId);

    const originalFetch2 = globalThis.fetch;
    try {
      globalThis.fetch = async (url: any) => {
        const u = String(url);
        if (u.includes('/merge_requests/88/notes')) {
          return new Response(
            JSON.stringify([
              {
                id: 901,
                body: 'added 1 commit',
                system: true,
                author: { username: 'rifkik', name: 'Rıfkı Kesepara' }
              },
              {
                id: 902,
                body: 'Token doğrulama katmanında null-check ve hata mesajı iyileştirilmeli.',
                system: false,
                type: 'DiffNote',
                author: { username: 'reviewer1', name: 'Kıdemli İncelemeci' },
                position: {
                  new_path: 'src/services/auth.ts',
                  old_path: 'src/services/auth.ts'
                }
              }
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (u.includes('/merge_requests')) {
          return new Response(
            JSON.stringify([
              {
                iid: 88,
                title: 'PORTAL-500: Yetkilendirme modülü geliştirmesi',
                state: 'opened',
                source_branch: 'feature/PORTAL-500',
                web_url: 'https://gitlab.example.com/corp/custom-portal/-/merge_requests/88'
              }
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('Not found', { status: 404 });
      };

      // Verify AI preview payload includes gitlabMrReview context and selected model
      const preview = await rep.previewAiPayload('2026-10-19', 1000, 'gemini_cli', 'gemini-3.8-flash-high');
      assert.equal(preview.model, 'gemini-3.8-flash-high');
      assert.equal(repo.getSettings().aiGeminiModel, 'gemini-3.8-flash-high');
      assert.ok(
        preview.sanitizedPromptPreview.includes('"mrIid": 88') &&
          preview.sanitizedPromptPreview.includes('"isReviewFix": true'),
        'AI prompt preview must embed GitLab MR !88 review fix context inside <untrusted_evidence_json>'
      );

      const generatedReport = await rep.generateReport({
        reportDate: '2026-10-19',
        provider: 'local_rule'
      });

      const portalItem = generatedReport.items.find((i) => i.projectId === proj.id);
      assert.ok(portalItem, 'Report item for CustomPortal must exist');
      assert.ok(
        portalItem.text.includes('!88') && portalItem.text.includes('code review geri bildirimleri'),
        `Report item must mention GitLab MR !88 review fix, got: ${portalItem.text}`
      );
    } finally {
      globalThis.fetch = originalFetch2;
    }

    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('14. Jira API Assignee Verification: Filters unassigned Zoom tickets while keeping tickets where user is assignee (currently or in changelog history)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesai-jira-assignee-test-'));
    const db = new MesaiDatabase(':memory:');
    const repo = new MesaiRepository(db);
    const zoom = new ZoomReaderAdapter(repo, new MatcherService(repo));
    const git = new GitFileWatcherService(repo, new MatcherService(repo));
    const rep = new ReportService(repo);

    const mockDpapi = {
      encrypt: (plain: string) => Buffer.from(`ENC:${plain}`, 'utf8').toString('base64'),
      decrypt: (cipher: string) => Buffer.from(cipher, 'base64').toString('utf8').replace(/^ENC:/, '')
    };

    const integrations = new IntegrationsService(repo, zoom, git, rep, {
      userDataDir: tmpDir,
      secretProvider: mockDpapi
    });

    // Configure Jira
    integrations.saveIntegrationCredential({
      service: 'jira',
      url: 'https://jira.company.com',
      usernameOrEmail: 'test.user@company.com',
      token: 'jira-secret-api-token'
    });

    // Mock fetch for Jira API
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('/rest/api/2/myself')) {
          return new Response(
            JSON.stringify({
              name: 'test.user',
              displayName: 'Test User',
              emailAddress: 'test.user@company.com',
              accountId: 'acc-12345'
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (urlStr.includes('/rest/api/2/issue/BAM-100')) {
          // BAM-100: User is currently assigned
          return new Response(
            JSON.stringify({
              key: 'BAM-100',
              fields: {
                summary: 'Giriş ekranı tasarımı',
                status: { name: 'In Progress' },
                assignee: {
                  displayName: 'Test User',
                  emailAddress: 'test.user@company.com'
                }
              },
              changelog: { histories: [] }
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (urlStr.includes('/rest/api/2/issue/BAM-200')) {
          // BAM-200: User was past assignee in changelog history
          return new Response(
            JSON.stringify({
              key: 'BAM-200',
              fields: {
                summary: 'Yetki modülü refactor',
                status: { name: 'Closed' },
                assignee: {
                  displayName: 'Other Teammate',
                  emailAddress: 'other@company.com'
                }
              },
              changelog: {
                histories: [
                  {
                    items: [
                      {
                        field: 'assignee',
                        from: 'third.party',
                        fromString: 'Third Party',
                        to: 'test.user',
                        toString: 'Test User'
                      }
                    ]
                  }
                ]
              }
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (urlStr.includes('/rest/api/2/issue/BAM-300')) {
          // BAM-300: User was NEVER assignee
          return new Response(
            JSON.stringify({
              key: 'BAM-300',
              fields: {
                summary: 'Raporlama servisi hatası',
                status: { name: 'Open' },
                assignee: {
                  displayName: 'Other Teammate',
                  emailAddress: 'other@company.com'
                }
              },
              changelog: {
                histories: [
                  {
                    items: [
                      {
                        field: 'assignee',
                        from: 'teammate1',
                        fromString: 'Teammate 1',
                        to: 'teammate2',
                        toString: 'Teammate 2'
                      }
                    ]
                  }
                ]
              }
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response('Not found', { status: 404 });
      };

      // Ingest Zoom chats that mention BAM-100, BAM-200, and BAM-300
      repo.ingestZoomSnapshot(
        createSampleSnapshot({
          chatName: 'Frontend Ekibi',
          capturedAt: '2026-10-24T10:00:00.000+03:00',
          messages: [
            {
              indexInDom: 1,
              occurrenceIndexInView: 1,
              fingerprint: 'fp_zoom_bam_100',
              uiaRuntimeId: '100.1',
              persistentMessageId: null,
              isGroupedFollowUp: false,
              dateGroup: 'Today',
              visibleTimestamp: '10:00',
              sender: 'Teammate A',
              senderResolved: 'Teammate A',
              isSentByMe: false,
              messageType: 'text',
              text: 'BAM-100 biletindeki gereksinimleri güncelledim.',
              links: ['https://jira.company.com/browse/BAM-100'],
              rawAccessibleLabel: 'BAM-100 biletindeki gereksinimleri güncelledim.'
            },
            {
              indexInDom: 2,
              occurrenceIndexInView: 2,
              fingerprint: 'fp_zoom_bam_200',
              uiaRuntimeId: '100.2',
              persistentMessageId: null,
              isGroupedFollowUp: false,
              dateGroup: 'Today',
              visibleTimestamp: '10:15',
              sender: 'Teammate B',
              senderResolved: 'Teammate B',
              isSentByMe: false,
              messageType: 'text',
              text: 'BAM-200 refactor işi ne durumdaydı?',
              links: ['https://jira.company.com/browse/BAM-200'],
              rawAccessibleLabel: 'BAM-200 refactor işi ne durumdaydı?'
            },
            {
              indexInDom: 3,
              occurrenceIndexInView: 3,
              fingerprint: 'fp_zoom_bam_300',
              uiaRuntimeId: '100.3',
              persistentMessageId: null,
              isGroupedFollowUp: false,
              dateGroup: 'Today',
              visibleTimestamp: '10:30',
              sender: 'Teammate C',
              senderResolved: 'Teammate C',
              isSentByMe: false,
              messageType: 'text',
              text: 'BAM-300 nolu raporlama hatasına kim bakacak?',
              links: ['https://jira.company.com/browse/BAM-300'],
              rawAccessibleLabel: 'BAM-300 nolu raporlama hatasına kim bakacak?'
            }
          ]
        })
      );

      // Run Jira sync via integrations service
      await integrations.syncJiraIssuesIfConfigured(['BAM-100', 'BAM-200', 'BAM-300']);

      // Check is_user_assignee in DB
      assert.equal(repo.isUserAssigneeForJiraKey('BAM-100'), true, 'BAM-100 (current assignee) must be verified');
      assert.equal(repo.isUserAssigneeForJiraKey('BAM-200'), true, 'BAM-200 (history assignee) must be verified');
      assert.equal(repo.isUserAssigneeForJiraKey('BAM-300'), false, 'BAM-300 (never assignee) must be false');

      // Generate report and check extracted Jira keys
      const report = await rep.generateReport({
        reportDate: '2026-10-24',
        provider: 'local_rule'
      });

      const extractedKeys = report.jiraKeys ?? repo.extractJiraKeysForDate('2026-10-24', report.items);

      assert.ok(extractedKeys.includes('BAM-100'), 'BAM-100 must be in report jira keys');
      assert.ok(extractedKeys.includes('BAM-200'), 'BAM-200 must be in report jira keys');
      assert.ok(!extractedKeys.includes('BAM-300'), 'BAM-300 (not assigned to user) must NEVER be in report jira keys');

      // 5. User removes BAM-100 from report
      const updatedReport = repo.removeReportJiraKey('2026-10-24', 'BAM-100');
      assert.ok(!updatedReport.jiraKeys?.includes('BAM-100'), 'BAM-100 must be removed from report.jiraKeys');
      assert.ok(updatedReport.jiraKeys?.includes('BAM-200'), 'BAM-200 must remain in report.jiraKeys');
      assert.ok(updatedReport.excludedJiraKeys?.includes('BAM-100'), 'BAM-100 must be in excludedJiraKeys');

      // 6. User resets removed Jira keys
      const resetReport = repo.resetReportJiraKeys('2026-10-24');
      assert.ok(resetReport.jiraKeys?.includes('BAM-100'), 'BAM-100 must be restored');
      assert.ok(resetReport.jiraKeys?.includes('BAM-200'), 'BAM-200 must be present');
      assert.equal(resetReport.excludedJiraKeys?.length, 0, 'excludedJiraKeys must be empty');
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('15. Battery & DB optimizations: settings cache isolation, commit diff deduplication, and foreign-key indexes', () => {
    const db = new MesaiDatabase(':memory:');
    const repo = new MesaiRepository(db);

    // 1. Verify Migration v4 indexes exist
    const indexes = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    assert.ok(
      indexNames.includes('idx_evidences_source_record_id'),
      'Migration v4 idx_evidences_source_record_id must exist'
    );
    assert.ok(
      indexNames.includes('idx_activity_links_work_item_id'),
      'Migration v4 idx_activity_links_work_item_id must exist'
    );

    // 2. Verify settings cache returns fresh clones and invalidates on updateSettings
    const s1 = repo.getSettings();
    s1.globalExclusions.push('mutated_in_memory_only');
    const s2 = repo.getSettings();
    assert.ok(
      !s2.globalExclusions.includes('mutated_in_memory_only'),
      'Mutating returned settings array must not corrupt internal cache'
    );

    repo.updateSettings({ zoomPollIntervalSeconds: 45 });
    assert.equal(repo.getSettings().zoomPollIntervalSeconds, 45);

    // 3. Verify hasCommitWithDiff deduplication check
    const proj = repo.upsertDiscoveredProject({
      name: 'OptTest',
      rootPath: 'C:\\Repos\\OptTest',
      currentBranch: 'main'
    });
    const dedupKey = `git:commit:${proj.id}:deadbeef1234`;
    assert.equal(repo.hasCommitWithDiff(dedupKey, true), false);

    // Ingest commit without diff first -> expectsDiff=true should still return false so backfill works
    repo.ingestGitOrFileActivity({
      projectId: proj.id,
      projectName: proj.name,
      sourceType: 'git_commit',
      dedupKey,
      externalId: 'deadbeef',
      branchName: 'main',
      occurredAtIso: '2026-10-25T10:00:00+03:00',
      rawTimestampText: '10:00',
      title: 'OptTest — Commit deadbeef',
      summary: 'Initial commit without diff',
      changedFiles: ['src/index.ts'],
      codeDiff: null
    });
    assert.equal(repo.hasCommitWithDiff(dedupKey, false), true);
    assert.equal(
      repo.hasCommitWithDiff(dedupKey, true),
      false,
      'Commit missing codeDiff must allow backfill'
    );

    // Backfill codeDiff -> now hasCommitWithDiff(dedupKey, true) must return true
    repo.ingestGitOrFileActivity({
      projectId: proj.id,
      projectName: proj.name,
      sourceType: 'git_commit',
      dedupKey,
      externalId: 'deadbeef',
      branchName: 'main',
      occurredAtIso: '2026-10-25T10:00:00+03:00',
      rawTimestampText: '10:00',
      title: 'OptTest — Commit deadbeef',
      summary: 'Initial commit without diff',
      changedFiles: ['src/index.ts'],
      codeDiff: 'FILE: src/index.ts\n+ console.log(1);'
    });
    assert.equal(repo.hasCommitWithDiff(dedupKey, true), true);

    db.close();
  });

  it('16. Zoom timestamp edge cases: overnight stale Today divider, thread weekday/yesterday priority, pre-Today backfill, and retroactive DB repair', () => {
    // 1. Overnight stale "Today" divider polled at 08:11 AM with yesterday's 17:44 message -> must resolve to Yesterday
    const morningCapture = '2026-11-11T08:11:58.027+03:00'; // Wednesday
    const staleToday = resolveZoomTimestamp('Today', '17:44', morningCapture);
    assert.equal(staleToday.resolvedDate, '2026-11-10');
    assert.equal(staleToday.resolvedTimestampIso, '2026-11-10T17:44:00+03:00');
    assert.equal(staleToday.rawTimestampText, 'Yesterday 17:44');

    // 2. Thread message under "Today" divider carrying its own weekday ("Mon 16:30") or "Yesterday, 17:16"
    const threadMon = resolveZoomTimestamp('Today', 'Mon 16:30', '2026-11-11T10:28:10.691+03:00');
    assert.equal(threadMon.resolvedDate, '2026-11-09');
    assert.equal(threadMon.resolvedTimestampIso, '2026-11-09T16:30:00+03:00');
    assert.equal(threadMon.rawTimestampText, 'Mon 16:30');

    const threadYesterday = resolveZoomTimestamp('Today', 'Yesterday, 17:16', '2026-11-11T10:28:10.691+03:00');
    assert.equal(threadYesterday.resolvedDate, '2026-11-10');
    assert.equal(threadYesterday.resolvedTimestampIso, '2026-11-10T17:16:00+03:00');
    assert.equal(threadYesterday.rawTimestampText, 'Yesterday, 17:16');

    // 3. Pre-"Today" null dateGroup backfill + cross-day dedupKey stability
    const db = new MesaiDatabase(':memory:');
    const repo = new MesaiRepository(db);

    const snapPoll1 = createSampleSnapshot({
      chatName: 'LSEG IT HELP DESK DEMO',
      sessionId: 'sess-lseg',
      capturedAt: '2026-11-11T08:11:58.027+03:00',
      messages: [
        {
          indexInDom: 1,
          occurrenceIndexInView: 1,
          fingerprint: 'fp_pre_today',
          uiaRuntimeId: '1.1',
          persistentMessageId: null,
          isGroupedFollowUp: false,
          dateGroup: null, // Above the "Today" divider in virtual list
          visibleTimestamp: '07:50',
          sender: 'Teammate',
          senderResolved: 'Teammate',
          isSentByMe: false,
          messageType: 'text',
          text: 'Dün sabahki mesaj',
          links: [],
          rawAccessibleLabel: null
        },
        {
          indexInDom: 2,
          occurrenceIndexInView: 1,
          fingerprint: 'fp_stale_today',
          uiaRuntimeId: '1.2',
          persistentMessageId: null,
          isGroupedFollowUp: false,
          dateGroup: 'Today', // Stale overnight divider before Zoom refreshed
          visibleTimestamp: '17:44',
          sender: 'You',
          senderResolved: 'Rıfkı Kesepara',
          isSentByMe: true,
          messageType: 'text',
          text: 'Eline sağlık abi',
          links: [],
          rawAccessibleLabel: null
        }
      ]
    });

    const r1 = repo.ingestZoomSnapshot(snapPoll1);
    assert.equal(r1.newMessagesCount, 2);

    // 38 seconds later Zoom refreshes DOM to "Yesterday" / "Yesterday, 17:44" -> must NOT duplicate
    const snapPoll2 = createSampleSnapshot({
      chatName: 'LSEG IT HELP DESK DEMO',
      sessionId: 'sess-lseg',
      capturedAt: '2026-11-11T08:12:35.989+03:00',
      messages: [
        {
          indexInDom: 1,
          occurrenceIndexInView: 1,
          fingerprint: 'fp_refreshed_yesterday',
          uiaRuntimeId: '1.99',
          persistentMessageId: null,
          isGroupedFollowUp: false,
          dateGroup: 'Yesterday',
          visibleTimestamp: 'Yesterday, 17:44',
          sender: 'You',
          senderResolved: 'Rıfkı Kesepara',
          isSentByMe: true,
          messageType: 'text',
          text: 'Eline sağlık abi',
          links: [],
          rawAccessibleLabel: null
        }
      ]
    });

    const r2 = repo.ingestZoomSnapshot(snapPoll2);
    assert.equal(r2.newMessagesCount, 0, 'Refreshed Yesterday label must match canonical dedupKey without duplicating');
    assert.equal(repo.listActivities({ date: '2026-11-11' }).length, 0, 'Neither yesterday message may appear on 2026-11-11');
    assert.equal(repo.listActivities({ date: '2026-11-10' }).length, 2, 'Both messages must be on 2026-11-10');

    db.close();
  });

  it('GitLab Reviewer MR Sync (30-day backfill + daily report): persists gitlab_mr_review Timeline rows, deduplicates updates, isolates teammates Jira keys, and includes MR numbers in reports even with zero local git/zoom activities', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesai-gitlab-reviewer-test-'));
    const db = new MesaiDatabase(':memory:');
    const repo = new MesaiRepository(db);
    const zoom = new ZoomReaderAdapter(repo, new MatcherService(repo));
    const git = new GitFileWatcherService(repo, new MatcherService(repo));
    const rep = new ReportService(repo);

    const mockDpapi = {
      encrypt: (plain: string) => Buffer.from(`ENC:${plain}`, 'utf8').toString('base64'),
      decrypt: (cipher: string) => Buffer.from(cipher, 'base64').toString('utf8').replace(/^ENC:/, '')
    };

    const integrations = new IntegrationsService(repo, zoom, git, rep, {
      userDataDir: tmpDir,
      secretProvider: mockDpapi
    });

    integrations.saveIntegrationCredential({
      service: 'gitlab',
      url: 'https://gitlab.example.com',
      usernameOrEmail: 'rifkik',
      token: 'glpat-REVIEWER-TEST'
    });

    const localProj = repo.upsertDiscoveredProject({
      name: 'CustomPortal',
      rootPath: 'C:\\Repos\\CustomPortal',
      repositoryUrl: 'https://gitlab.example.com/corp/custom-portal.git'
    });

    const todayStr = getTodayLocalDate();
    const todayCommentIso = `${todayStr}T10:15:00+03:00`;
    const todayApproveIso = `${todayStr}T11:30:00+03:00`;
    const todayFallbackApproveIso = `${todayStr}T14:20:00+03:00`;

    let includeSecondComment = false;
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url: any) => {
        const u = String(url);
        if (u.includes('/api/v4/events')) {
          const events: any[] = [
            // 1. Reviewer DiffNote comment on teammate's MR !142
            {
              id: 1,
              project_id: 101,
              action_name: 'commented on',
              target_type: 'DiffNote',
              target_title: 'TEAM-999: Login form validasyonu',
              created_at: todayCommentIso,
              note: {
                id: 501,
                body: 'Null check eklenmeli ve hata mesajı i18n üzerinden okunmalı.',
                system: false,
                noteable_type: 'MergeRequest',
                noteable_iid: 142,
                position: { new_path: 'src/components/LoginForm.tsx' }
              }
            },
            // 2. Reviewer approval on teammate's MR !142
            {
              id: 2,
              project_id: 101,
              action_name: 'approved',
              target_type: 'MergeRequest',
              target_iid: 142,
              target_title: 'TEAM-999: Login form validasyonu',
              created_at: todayApproveIso
            },
            // 3. Author commenting on OWN MR !99 -> must be excluded from reviewer activities
            {
              id: 3,
              project_id: 101,
              action_name: 'commented on',
              target_type: 'DiscussionNote',
              target_title: 'PORTAL-10: Kendi MR cevabım',
              created_at: todayCommentIso,
              note: {
                id: 502,
                body: 'Düzelttim, tekrar bakabilir misin?',
                system: false,
                noteable_type: 'MergeRequest',
                noteable_iid: 99
              }
            }
          ];
          if (includeSecondComment) {
            events.push({
              id: 4,
              project_id: 101,
              action_name: 'commented on',
              target_type: 'Note',
              target_title: 'TEAM-999: Login form validasyonu',
              created_at: `${todayStr}T15:05:00+03:00`,
              note: {
                id: 503,
                body: 'Eline sağlık, son revizyon uygun görünüyor.',
                system: false,
                noteable_type: 'MergeRequest',
                noteable_iid: 142
              }
            });
          }
          return new Response(JSON.stringify(events), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Fallback approved_by_usernames[] catches MR !150 (not in /events)
        if (u.includes('/api/v4/merge_requests') && u.includes('approved_by_usernames')) {
          return new Response(
            JSON.stringify([
              {
                iid: 150,
                project_id: 202,
                title: 'OTHER-77: Shared lib buton güncellemesi',
                state: 'merged',
                source_branch: 'feature/OTHER-77',
                web_url: 'https://gitlab.example.com/corp/bam-shared-lib/-/merge_requests/150',
                author: { username: 'teammate2', name: 'Ekip Arkadaşı' },
                references: { full: 'corp/bam-shared-lib!150' }
              }
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (u.includes('/projects/202/merge_requests/150/notes')) {
          return new Response(
            JSON.stringify([
              {
                id: 701,
                system: true,
                body: 'approved this merge request',
                created_at: todayFallbackApproveIso,
                author: { username: 'rifkik' }
              }
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (u.includes('/projects/101/merge_requests/142')) {
          return new Response(
            JSON.stringify({
              iid: 142,
              project_id: 101,
              title: 'TEAM-999: Login form validasyonu',
              state: 'opened',
              source_branch: 'feature/TEAM-999',
              web_url: 'https://gitlab.example.com/corp/custom-portal/-/merge_requests/142',
              author: { username: 'teammate1', name: 'Ekip Arkadaşı 1' },
              references: { full: 'corp/custom-portal!142' }
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (u.includes('/projects/101/merge_requests/99')) {
          return new Response(
            JSON.stringify({
              iid: 99,
              project_id: 101,
              title: 'PORTAL-10: Kendi MR cevabım',
              state: 'opened',
              source_branch: 'feature/PORTAL-10',
              web_url: 'https://gitlab.example.com/corp/custom-portal/-/merge_requests/99',
              author: { username: 'rifkik', name: 'Rıfkı Kesepara' },
              references: { full: 'corp/custom-portal!99' }
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response('Not found', { status: 404 });
      };

      // 1. Run 30-day backfill sync
      const syncRes = await integrations.syncGitLabReviewsHistory(30);
      assert.equal(syncRes.ok, true);
      assert.equal(syncRes.totalMrs, 2, 'Should sync MR !142 and fallback MR !150 (excluding own MR !99)');
      assert.equal(syncRes.createdCount, 2);

      // Verify Timeline activities persisted as separate rows with sourceType = 'gitlab_mr_review'
      const timelineMrs = repo.listActivities({ date: todayStr, sourceType: 'gitlab_mr_review' });
      assert.equal(timelineMrs.length, 2);
      const mr142Act = timelineMrs.find((a) => a.title.includes('!142'));
      const mr150Act = timelineMrs.find((a) => a.title.includes('!150'));
      assert.ok(mr142Act, 'MR !142 must appear as a Timeline row');
      assert.equal(mr142Act.projectId, localProj.id, 'MR !142 must link to matched local project');
      assert.ok(mr142Act.title.includes('İnceleme & Onay'));
      assert.ok(mr150Act, 'Fallback-approved MR !150 must appear as a Timeline row');
      assert.ok(mr150Act.title.includes('Onaylandı'));
      assert.equal(
        timelineMrs.some((a) => a.title.includes('!99')),
        false,
        'Self-authored MR !99 comment must NOT be persisted as reviewer activity'
      );

      // 2. Re-sync with an extra comment on !142 -> must update existing row, NOT duplicate
      includeSecondComment = true;
      const syncRes2 = await integrations.syncGitLabReviewsHistory(30);
      assert.equal(syncRes2.createdCount, 0);
      assert.equal(syncRes2.updatedCount, 1);
      assert.equal(repo.listActivities({ date: todayStr, sourceType: 'gitlab_mr_review' }).length, 2);

      // 3. Teammates' Jira keys (TEAM-999, OTHER-77) must NOT leak into user's Jira keys
      const extractedJira = repo.extractJiraKeysForDate(todayStr);
      assert.equal(extractedJira.includes('TEAM-999'), false);
      assert.equal(extractedJira.includes('OTHER-77'), false);

      // 4. Daily report preview & local_rule generation with ZERO local git/zoom activities
      const preview = await rep.previewAiPayload(todayStr, 1000, 'gemini_cli');
      assert.ok(
        preview.sanitizedPromptPreview.includes('"reviewedMergeRequests"') &&
          preview.sanitizedPromptPreview.includes('"!142"') &&
          preview.sanitizedPromptPreview.includes('"!150"'),
        'AI prompt preview must include reviewedMergeRequests with !142 and !150'
      );

      const report = await rep.generateReport({
        reportDate: todayStr,
        provider: 'local_rule'
      });
      assert.ok(report.items.length >= 1, 'Daily report must generate reviewer MR item even without git/zoom activities');
      const reviewItem = report.items.find((i) => i.category === 'analysis');
      assert.ok(reviewItem, 'Reviewer MR report item must have category analysis');
      assert.ok(
        reviewItem.text.includes('!142') && reviewItem.text.includes('!150'),
        `Report prose must share MR numbers !142 and !150, got: ${reviewItem.text}`
      );
      assert.ok(reviewItem.evidenceIds.length >= 2, 'Report item must preserve real evidenceIds from persisted MR rows');
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('18. Zoom voice/video call context inference: [-90m / -240m] + [+30m] temporal window, >60m gap isolation, missed call filtering, and ±90m Git suggestion', async () => {
    const db = new MesaiDatabase(':memory:');
    const repo = new MesaiRepository(db);
    const matcher = new MatcherService(repo);
    const rep = new ReportService(repo);

    // 1. Seda Kaya DM:
    // - 09:10 unrelated morning topic (>4h silence before 14:00 call -> must be excluded from call context)
    // - 13:50 technical issue before call
    // - 13:58 "Müsait misin sesli bakalım mı?" coordination filler
    // - 14:00 answered video call
    // - 14:18 post-call decision note (+18m -> must be included in call context)
    const sedaIngest = repo.ingestZoomSnapshot(
      createSampleSnapshot({
        chatName: 'Seda Kaya',
        chatType: 'Direct',
        sessionId: 'sess-seda-call',
        capturedAt: '2026-10-28T15:00:00.000+03:00',
        messages: [
          {
            indexInDom: 1,
            occurrenceIndexInView: 1,
            fingerprint: 'fp_seda_morning',
            uiaRuntimeId: '50.1',
            persistentMessageId: null,
            isGroupedFollowUp: false,
            dateGroup: 'Today',
            visibleTimestamp: '09:10',
            sender: 'Seda Kaya',
            senderResolved: 'Seda Kaya',
            isSentByMe: false,
            messageType: 'text',
            text: 'Eğitim portalı ikon hizalamasını dün tamamlamıştık',
            links: [],
            rawAccessibleLabel: null
          },
          {
            indexInDom: 2,
            occurrenceIndexInView: 1,
            fingerprint: 'fp_seda_pre',
            uiaRuntimeId: '50.2',
            persistentMessageId: null,
            isGroupedFollowUp: false,
            dateGroup: 'Today',
            visibleTimestamp: '13:50',
            sender: 'Seda Kaya',
            senderResolved: 'Seda Kaya',
            isSentByMe: false,
            messageType: 'text',
            text: 'fatura-kesim-sureci ekranında KDV yuvarlama servisi 500 hatası veriyor',
            links: [],
            rawAccessibleLabel: null
          },
          {
            indexInDom: 3,
            occurrenceIndexInView: 1,
            fingerprint: 'fp_seda_coord',
            uiaRuntimeId: '50.3',
            persistentMessageId: null,
            isGroupedFollowUp: true,
            dateGroup: 'Today',
            visibleTimestamp: '13:58',
            sender: 'You',
            senderResolved: 'Rıfkı Kesepara',
            isSentByMe: true,
            messageType: 'text',
            text: 'sesli bakalım mı?',
            links: [],
            rawAccessibleLabel: null
          },
          {
            indexInDom: 4,
            occurrenceIndexInView: 1,
            fingerprint: 'fp_seda_call',
            uiaRuntimeId: '50.4',
            persistentMessageId: null,
            isGroupedFollowUp: false,
            dateGroup: 'Today',
            visibleTimestamp: '14:00',
            sender: 'Seda Kaya',
            senderResolved: 'Seda Kaya',
            isSentByMe: false,
            messageType: 'call',
            text: null,
            links: [],
            callRecord: {
              direction: 'incoming',
              iconLabel: 'Video Incoming',
              statusText: 'Incoming video call - accepted'
            },
            rawAccessibleLabel: null
          },
          {
            indexInDom: 5,
            occurrenceIndexInView: 1,
            fingerprint: 'fp_seda_post',
            uiaRuntimeId: '50.5',
            persistentMessageId: null,
            isGroupedFollowUp: false,
            dateGroup: 'Today',
            visibleTimestamp: '14:18',
            sender: 'You',
            senderResolved: 'Rıfkı Kesepara',
            isSentByMe: true,
            messageType: 'text',
            text: 'BigDecimal ölçeğini 4 haneye çekerek yuvarlama kararını netleştirdik',
            links: [],
            rawAccessibleLabel: null
          }
        ]
      })
    );
    for (const id of sedaIngest.newActivityIds) matcher.matchActivityById(id);

    // 2. Mert Demir DM: Missed call + Declined call -> must be ignored completely!
    const mertIngest = repo.ingestZoomSnapshot(
      createSampleSnapshot({
        chatName: 'Mert Demir',
        chatType: 'Direct',
        sessionId: 'sess-mert-missed',
        capturedAt: '2026-10-28T15:00:00.000+03:00',
        messages: [
          {
            indexInDom: 1,
            occurrenceIndexInView: 1,
            fingerprint: 'fp_mert_missed',
            uiaRuntimeId: '60.1',
            persistentMessageId: null,
            isGroupedFollowUp: false,
            dateGroup: 'Today',
            visibleTimestamp: '12:10',
            sender: 'Mert Demir',
            senderResolved: 'Mert Demir',
            isSentByMe: false,
            messageType: 'call',
            text: null,
            links: [],
            callRecord: {
              direction: 'incoming',
              iconLabel: 'Audio Incoming',
              statusText: 'Missed audio call'
            },
            rawAccessibleLabel: null
          },
          {
            indexInDom: 2,
            occurrenceIndexInView: 1,
            fingerprint: 'fp_mert_declined',
            uiaRuntimeId: '60.2',
            persistentMessageId: null,
            isGroupedFollowUp: false,
            dateGroup: 'Today',
            visibleTimestamp: '12:15',
            sender: 'Mert Demir',
            senderResolved: 'Mert Demir',
            isSentByMe: false,
            messageType: 'call',
            text: null,
            links: [],
            callRecord: {
              direction: 'outgoing',
              iconLabel: 'Video Outgoing',
              statusText: 'Call declined'
            },
            rawAccessibleLabel: null
          }
        ]
      })
    );
    for (const id of mertIngest.newActivityIds) matcher.matchActivityById(id);

    // 3. Canan Arslan DM: Extended [-240m] fallback when near window only has "Müsait misin?"
    const cananIngest = repo.ingestZoomSnapshot(
      createSampleSnapshot({
        chatName: 'Canan Arslan',
        chatType: 'Direct',
        sessionId: 'sess-canan-ext',
        capturedAt: '2026-10-28T15:00:00.000+03:00',
        messages: [
          {
            indexInDom: 1,
            occurrenceIndexInView: 1,
            fingerprint: 'fp_canan_topic',
            uiaRuntimeId: '70.1',
            persistentMessageId: null,
            isGroupedFollowUp: false,
            dateGroup: 'Today',
            visibleTimestamp: '10:20',
            sender: 'Canan Arslan',
            senderResolved: 'Canan Arslan',
            isSentByMe: false,
            messageType: 'text',
            text: 'multi-pod ortamında websocket bağlantısı kopuyor, nginx sticky session bakalım',
            links: [],
            rawAccessibleLabel: null
          },
          {
            indexInDom: 2,
            occurrenceIndexInView: 1,
            fingerprint: 'fp_canan_avail',
            uiaRuntimeId: '70.2',
            persistentMessageId: null,
            isGroupedFollowUp: false,
            dateGroup: 'Today',
            visibleTimestamp: '12:45',
            sender: 'Canan Arslan',
            senderResolved: 'Canan Arslan',
            isSentByMe: false,
            messageType: 'text',
            text: 'Müsait misin?',
            links: [],
            rawAccessibleLabel: null
          },
          {
            indexInDom: 3,
            occurrenceIndexInView: 1,
            fingerprint: 'fp_canan_call',
            uiaRuntimeId: '70.3',
            persistentMessageId: null,
            isGroupedFollowUp: false,
            dateGroup: 'Today',
            visibleTimestamp: '12:47',
            sender: 'You',
            senderResolved: 'Rıfkı Kesepara',
            isSentByMe: true,
            messageType: 'call',
            text: null,
            links: [],
            callRecord: {
              direction: 'outgoing',
              iconLabel: 'Audio Outgoing',
              statusText: 'Outgoing audio call - answered'
            },
            rawAccessibleLabel: null
          }
        ]
      })
    );
    for (const id of cananIngest.newActivityIds) matcher.matchActivityById(id);

    // Verify correlateZoomCallsForChat directly on Seda Kaya's room
    const sedaActs = repo.listActivities({ date: '2026-10-28', chatOrRepoName: 'Seda Kaya' });
    const sedaCalls = sedaActs.filter((a) => a.sourceType === 'zoom_call');
    const sedaChats = sedaActs.filter((a) => a.sourceType === 'zoom_chat');
    const sedaSessions = correlateZoomCallsForChat(sedaCalls, sedaChats);
    assert.equal(sedaSessions.length, 1);
    assert.equal(
      sedaSessions[0].preCallMessages.length,
      1,
      'Must capture 13:50 pre-call message while excluding 09:10 (>60m gap) and 13:58 coordination filler'
    );
    assert.ok(sedaSessions[0].preCallMessages[0].summary.includes('KDV yuvarlama'));
    assert.equal(sedaSessions[0].postCallMessages.length, 1, 'Must capture +18m post-call follow-up message');
    assert.ok(sedaSessions[0].postCallMessages[0].summary.includes('BigDecimal'));

    // Verify AI prompt structure embeds calls with pre/post context and excludes missed calls
    const allDayActs = repo.listActivities({ date: '2026-10-28' });
    const prompt = buildSanitizedAiPrompt('2026-10-28', allDayActs, 1500);
    assert.ok(!prompt.includes('Mert Demir'), 'Missed/declined calls must be excluded from AI prompt');
    assert.ok(prompt.includes('"preCallContextMessages"'), 'AI prompt must embed preCallContextMessages');
    assert.ok(prompt.includes('"postCallFollowUpMessages"'), 'AI prompt must embed postCallFollowUpMessages');

    // Verify LocalRuleProvider produces 2 contextual meeting items (Seda + Canan) and 0 generic/missed items
    const report = await rep.generateReport({
      reportDate: '2026-10-28',
      provider: 'local_rule',
      maxChars: 1500
    });
    assert.equal(report.items.length, 2, 'Must produce 1 merged meeting item per contextual call conversation and ignore missed calls');

    const sedaItem = report.items.find((i) => i.text.includes('KDV yuvarlama') || i.text.includes('Fatura Kesim Süreci'));
    assert.ok(sedaItem, `Seda video call item must describe Fatura Kesim / KDV topic, got: ${JSON.stringify(report.items.map((x) => x.text))}`);
    assert.equal(sedaItem.category, 'meeting');
    assert.equal(sedaItem.isInsufficientEvidence, false, 'Call with chat context must NOT be flagged as insufficient evidence');
    assert.ok(sedaItem.text.includes('görüntülü'), 'Video call item must mention video meeting');

    const cananItem = report.items.find((i) => i.text.includes('WebSocket'));
    assert.ok(cananItem, 'Canan audio call item must infer WebSocket topic via -240m fallback');
    assert.equal(cananItem.category, 'meeting');
    assert.equal(cananItem.isInsufficientEvidence, false);
    assert.ok(cananItem.text.includes('sesli'), 'Audio call item must mention audio meeting');

    db.close();
  });

  it('19. Activity comments CRUD, re-approval trigger, and comment-driven AI & local report evaluation (including exclusion directive)', async () => {
    const db = new MesaiDatabase(':memory:');
    const repo = new MesaiRepository(db);
    const matcher = new MatcherService(repo);
    const rep = new ReportService(repo);

    const proj = repo.upsertDiscoveredProject({
      name: 'custom-portal',
      rootPath: 'C:\\Repos\\custom-portal',
      currentBranch: 'feature/BAM-4090',
      defaultJiraKeys: ['BAM']
    });

    // 1. Ingest a vague commit ("fix"), a contextless Zoom call, and an off-topic Zoom chat
    const vagueCommit = repo.ingestGitOrFileActivity({
      projectId: proj.id,
      projectName: proj.name,
      sourceType: 'git_commit',
      dedupKey: 'git:commit:cp:vague1',
      externalId: 'vague1',
      branchName: 'feature/BAM-4090',
      occurredAtIso: '2026-10-29T10:15:00+03:00',
      rawTimestampText: '10:15',
      title: 'custom-portal — Commit vague1',
      summary: 'fix'
    });
    matcher.matchActivityById(vagueCommit.activityId);

    const zoomBatch = repo.ingestZoomSnapshot(
      createSampleSnapshot({
        chatName: 'Ahmet Yılmaz',
        chatType: 'Direct',
        sessionId: 'sess-ahmet-comment',
        capturedAt: '2026-10-29T16:00:00.000+03:00',
        messages: [
          {
            indexInDom: 1,
            occurrenceIndexInView: 1,
            fingerprint: 'fp_ahmet_call_only',
            uiaRuntimeId: '80.1',
            persistentMessageId: null,
            isGroupedFollowUp: false,
            dateGroup: 'Today',
            visibleTimestamp: '14:30',
            sender: 'Ahmet Yılmaz',
            senderResolved: 'Ahmet Yılmaz',
            isSentByMe: false,
            messageType: 'call',
            text: null,
            links: [],
            callRecord: {
              direction: 'incoming',
              iconLabel: 'Video Incoming',
              statusText: 'Incoming video call - accepted'
            },
            rawAccessibleLabel: null
          }
        ]
      })
    );
    const callActId = zoomBatch.newActivityIds[0];
    matcher.matchActivityById(callActId);

    const personalChatBatch = repo.ingestZoomSnapshot(
      createSampleSnapshot({
        chatName: 'Sosyal Sohbet',
        chatType: 'Direct',
        sessionId: 'sess-social',
        capturedAt: '2026-10-29T16:05:00.000+03:00',
        messages: [
          {
            indexInDom: 1,
            occurrenceIndexInView: 1,
            fingerprint: 'fp_social_1',
            uiaRuntimeId: '81.1',
            persistentMessageId: null,
            isGroupedFollowUp: false,
            dateGroup: 'Today',
            visibleTimestamp: '15:00',
            sender: 'Arkadaş',
            senderResolved: 'Arkadaş',
            isSentByMe: false,
            messageType: 'text',
            text: 'Akşam halı saha maçı kadrosunu netleştirelim',
            links: [],
            rawAccessibleLabel: null
          }
        ]
      })
    );
    const socialActId = personalChatBatch.newActivityIds[0];

    // 2. Generate & approve initial report before comments -> call item has isInsufficientEvidence = true
    const initialReport = await rep.generateReport({
      reportDate: '2026-10-29',
      provider: 'local_rule',
      maxChars: 1500
    });
    const initialCallItem = initialReport.items.find((i) => i.category === 'meeting');
    assert.ok(initialCallItem);
    assert.equal(initialCallItem.isInsufficientEvidence, true);

    const approved = repo.approveReport(initialReport.id);
    assert.equal(approved.status, 'approved');

    // 3. Add user comments onto the call, vague commit, and personal chat
    const commentedCall = repo.addActivityComment(
      callActId,
      'Taslak açıklama'
    );
    assert.equal(commentedCall.comments?.length, 1);

    // Adding a comment on an approved report's date must transition report status to 'needs_reapproval'
    assert.equal(repo.getDailyReport('2026-10-29')?.status, 'needs_reapproval');

    // Update the comment with rich technical & Jira context
    const updatedCall = repo.updateActivityComment(
      commentedCall.comments![0].id,
      'Bu görüşmede BAM-4095 kapsamında Fatura Kesim Süreci KDV yuvarlama hatasını inceledik ve BigDecimal ölçeğini 4 haneye çekmeye karar verdik'
    );
    matcher.matchActivityById(updatedCall.id);
    assert.ok(
      updatedCall.comments?.[0].content.includes('BAM-4095'),
      'Updated activity comment must persist in SQLite'
    );

    // Add explanation comment to vague "fix" commit
    repo.addActivityComment(
      vagueCommit.activityId,
      'Token yenileme yarış durumu (race condition) için mutex kilidi eklendi'
    );
    matcher.matchActivityById(vagueCommit.activityId);

    // Add exclusion directive comment to off-topic chat
    const excludedSocial = repo.addActivityComment(socialActId, 'Rapora ekleme, kişisel görüşme');
    assert.equal(excludedSocial.comments?.length, 1);

    // 4. Verify AI prompt includes userComments and excludes the "Rapora ekleme" activity
    const refreshedActs = repo.listActivities({ date: '2026-10-29' });
    const prompt = buildSanitizedAiPrompt('2026-10-29', refreshedActs, 1500);
    assert.ok(prompt.includes('BigDecimal ölçeğini 4 haneye'), 'AI prompt must surface call userComments');
    assert.ok(prompt.includes('mutex kilidi eklendi'), 'AI prompt must surface commit userComments');
    assert.ok(!prompt.includes('halı saha'), 'Excluded activity must be omitted from AI prompt');

    // 5. Regenerate report with local_rule -> must reflect user comments and exclude social chat
    const finalReport = await rep.generateReport({
      reportDate: '2026-10-29',
      provider: 'local_rule',
      maxChars: 1500
    });

    assert.ok(
      !finalReport.formattedSummary?.includes('halı saha'),
      'Excluded activity must not appear in generated report'
    );
    assert.ok(
      finalReport.jiraKeys?.includes('BAM-4095'),
      'Jira key authored by user in activity comment must be included in report Jira keys'
    );

    const devItem = finalReport.items.find(
      (i) => i.category === 'development' && i.text.includes('mutex kilidi')
    );
    assert.ok(
      devItem,
      `Development item must reflect user comment on vague commit, got: ${JSON.stringify(finalReport.items.map((x) => x.text))}`
    );

    const meetingOrMergedBam4095 = finalReport.items.find((i) => i.text.includes('BigDecimal'));
    assert.ok(
      meetingOrMergedBam4095,
      `Call item must reflect user comment (BigDecimal / KDV yuvarlama), got: ${JSON.stringify(finalReport.items.map((x) => x.text))}`
    );
    assert.equal(
      meetingOrMergedBam4095.isInsufficientEvidence,
      false,
      'Call explained by user comment must have isInsufficientEvidence = false'
    );

    // 6. Verify deleteActivityComment removes comment cleanly
    const afterDelete = repo.deleteActivityComment(excludedSocial.comments![0].id);
    assert.equal(afterDelete.comments?.length, 0);

    db.close();
  });
});




