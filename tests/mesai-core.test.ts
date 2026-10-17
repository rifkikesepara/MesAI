import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MesaiDatabase } from '../src/main/db/database';
import { MesaiRepository } from '../src/main/db/repositories';
import { resolveZoomTimestamp } from '../src/main/services/timestamp-resolver';
import { MatcherService } from '../src/main/services/matcher-service';
import { GitFileWatcherService, shouldExcludeFilePath } from '../src/main/services/git-file-watcher';
import { GeminiCliProvider } from '../src/main/services/ai-provider';
import { ReportService } from '../src/main/services/report-service';
import { ZoomReaderAdapter } from '../src/main/services/zoom-adapter';
import { IntegrationsService } from '../src/main/services/integrations-service';
import { isNewerVersion, parseSemver } from '../src/main/services/update-service';
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

    // 1. Ingest Zoom chat mentioning BAM-4066 + a call record
    const snap = createSampleSnapshot();
    const zoomIngest = repo.ingestZoomSnapshot(snap);
    for (const actId of zoomIngest.newActivityIds) {
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

    // Find the consolidated BAM-4066 item and verify it links to BOTH Zoom and Git evidences
    const bamItem = report1.items.find((i) => i.jiraKey === 'BAM-4066');
    assert.ok(bamItem, 'Consolidated BAM-4066 report item must exist');
    assert.equal(bamItem.evidenceIds.length, 2, 'Must preserve both Zoom and Git evidence IDs');

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

  it('9. Version comparison, update detection, and autoCheckUpdatesOnStartup setting persistence', () => {
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

    const report = await reportService.generateReport({
      reportDate: '2026-10-17',
      provider: 'openai',
      userConfirmedRemoteSend: true
    });

    // Dummy key will fail remote request and gracefully fall back to local rule
    assert.ok(report.providerUsed.includes('local_rule'), 'Should fall back to local_rule on remote failure');
    assert.ok(report.items.length > 0, 'Report items must not be lost on fallback');

    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});



