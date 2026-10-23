import React, { useEffect, useRef, useState } from 'react';
import type { ReportProgressLog, ReportProgressStep } from '../../shared/types';
import { SparklesIcon, TerminalIcon, CheckIcon } from './Icons';
import { SkeletonReport } from './Skeleton';

export interface AgentLogStreamConsoleProps {
  logs: ReportProgressLog[];
  provider: string;
  reportDate: string;
  streamChunk?: string;
}

const STEP_LABELS: Record<ReportProgressStep, string> = {
  init: 'Başlatılıyor',
  gathering: 'Aktiviteler',
  context: 'Bağlam & Jira',
  prompt_prep: 'Prompt Hazırlığı',
  ai_call: 'AI Çağrısı',
  streaming: 'Çıktı Akışı',
  fallback: 'Yerel Motor Yedekleme',
  validating: 'Doğrulama',
  saving: 'Kaydediliyor',
  complete: 'Tamamlandı',
  error: 'Hata'
};

export const AgentLogStreamConsole: React.FC<AgentLogStreamConsoleProps> = ({
  logs,
  provider,
  reportDate,
  streamChunk
}) => {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const terminalContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (terminalContainerRef.current) {
      terminalContainerRef.current.scrollTop = terminalContainerRef.current.scrollHeight;
    }
  }, [logs.length, streamChunk]);

  const currentLog = logs[logs.length - 1];
  const currentStep: ReportProgressStep = currentLog?.step ?? 'init';

  // Map to 4 primary visual pipeline phases
  const getPhaseStatus = (phase: 1 | 2 | 3 | 4): 'pending' | 'active' | 'done' => {
    if (currentStep === 'complete') return 'done';
    if (phase === 1) {
      if (['init', 'gathering'].includes(currentStep)) return 'active';
      return 'done';
    }
    if (phase === 2) {
      if (['init', 'gathering'].includes(currentStep)) return 'pending';
      if (['context', 'prompt_prep'].includes(currentStep)) return 'active';
      return 'done';
    }
    if (phase === 3) {
      if (['init', 'gathering', 'context', 'prompt_prep'].includes(currentStep)) return 'pending';
      if (['ai_call', 'streaming', 'fallback'].includes(currentStep)) return 'active';
      return 'done';
    }
    if (phase === 4) {
      if (['validating', 'saving'].includes(currentStep)) return 'active';
      if (currentStep === 'complete') return 'done';
      return 'pending';
    }
    return 'pending';
  };

  const formatElapsed = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  return (
    <div style={{ marginBottom: '16px' }}>
      <div className="agent-console-card">
        {/* Header */}
        <div className="agent-console-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="agent-pulse-dot" />
            <span style={{ fontWeight: 600, fontSize: '13px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <SparklesIcon size={14} style={{ color: 'var(--accent)' }} />
              <span>AI Ajanı Çalışıyor</span>
            </span>
            <span className="badge badge-neutral" style={{ fontSize: '11.5px' }}>
              {provider}
            </span>
            <span className="badge badge-info" style={{ fontSize: '11.5px' }}>
              {reportDate}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Aşama: <strong style={{ color: 'var(--text-primary)' }}>{STEP_LABELS[currentStep] ?? currentStep}</strong>
            </span>
            <span
              className="badge"
              style={{
                background: 'var(--bg-input)',
                fontFamily: 'monospace',
                fontSize: '12px',
                border: '1px solid var(--border-color)'
              }}
            >
              ⏱ {formatElapsed(elapsedSeconds)}
            </span>
          </div>
        </div>

        {/* Step Tracker Pipeline */}
        <div className="agent-step-pipeline">
          <div className={`agent-step-item ${getPhaseStatus(1)}`}>
            <span className="step-num">{getPhaseStatus(1) === 'done' ? <CheckIcon size={10} /> : '1'}</span>
            <span>Aktiviteler</span>
          </div>
          <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>➔</span>

          <div className={`agent-step-item ${getPhaseStatus(2)}`}>
            <span className="step-num">{getPhaseStatus(2) === 'done' ? <CheckIcon size={10} /> : '2'}</span>
            <span>Bağlam & Jira</span>
          </div>
          <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>➔</span>

          <div className={`agent-step-item ${getPhaseStatus(3)}`}>
            <span className="step-num">{getPhaseStatus(3) === 'done' ? <CheckIcon size={10} /> : '3'}</span>
            <span>AI Çıkarımı</span>
          </div>
          <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>➔</span>

          <div className={`agent-step-item ${getPhaseStatus(4)}`}>
            <span className="step-num">{getPhaseStatus(4) === 'done' ? <CheckIcon size={10} /> : '4'}</span>
            <span>Doğrulama & Kayıt</span>
          </div>
        </div>

        {/* Live Terminal Log Stream */}
        <div className="agent-terminal-window" ref={terminalContainerRef}>
          {logs.length === 0 ? (
            <div style={{ color: 'var(--text-muted)' }}>
              [00:00:00] Rapor oluşturma süreci başlatılıyor...
            </div>
          ) : (
            logs.map((log, index) => (
              <div key={index} className="agent-terminal-line">
                <span className="term-time">[{log.timestamp}]</span>
                <span className={`term-tag term-tag-${log.step}`}>
                  {STEP_LABELS[log.step] ?? log.step}
                </span>
                <span style={{ flex: 1 }}>{log.message}</span>
              </div>
            ))
          )}
        </div>

        {/* Streaming text preview box if tokens/chunks are streaming */}
        {streamChunk && (
          <div className="agent-stream-preview">
            <span style={{ color: 'var(--text-muted)', marginRight: '6px' }}>&gt; Canlı Model Çıktısı:</span>
            <span>{streamChunk}</span>
            <span className="agent-cursor-blink" />
          </div>
        )}
      </div>

      {/* Subtle skeleton below to anchor page layout */}
      <SkeletonReport />
    </div>
  );
};
