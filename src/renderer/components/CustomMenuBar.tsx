import React, { useEffect, useRef, useState } from 'react';
import { MESAI_ICON_DATA_URL } from '../assets/logo';
import type { UpdateState } from '../../shared/types';
import {
  DashboardIcon,
  ProjectsIcon,
  ActivityIcon,
  ReportIcon,
  IntegrationsIcon,
  SettingsIcon,
  PlayIcon,
  PauseIcon,
  RefreshIcon,
  SunIcon,
  MoonIcon,
  LaptopIcon,
  CheckIcon,
  ExternalLinkIcon,
  DownloadIcon,
  MessageSquareIcon,
  GitCommitIcon
} from './Icons';

interface CustomMenuBarProps {
  activeTab: string;
  onNavigateTab: (tab: any) => void;
  isPaused: boolean;
  onTogglePaused: () => void;
  onPollZoom: () => void;
  onPollGit: () => void;
  updateState: UpdateState | null;
  currentTheme: 'light' | 'dark' | 'system';
  onSetTheme: (theme: 'light' | 'dark' | 'system') => void;
}

export const CustomMenuBar: React.FC<CustomMenuBarProps> = ({
  onNavigateTab,
  isPaused,
  onTogglePaused,
  onPollZoom,
  onPollGit,
  updateState,
  currentTheme,
  onSetTheme
}) => {
  const [openMenu, setOpenMenu] = useState<'file' | 'view' | 'tracking' | 'help' | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const menuBarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.mesaiApi.isWindowMaximized().then(setIsMaximized);
    const cleanup = window.mesaiApi.onMaximizeChanged((max) => {
      setIsMaximized(max);
    });
    return () => cleanup?.();
  }, []);

  // Close menus on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    window.addEventListener('mousedown', handleOutsideClick);
    return () => window.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const handleMinimize = () => {
    void window.mesaiApi.minimizeWindow();
  };

  const handleMaximize = async () => {
    const res = await window.mesaiApi.maximizeWindow();
    setIsMaximized(res);
  };

  const handleClose = () => {
    void window.mesaiApi.closeWindow();
  };

  const handleMenuClick = (menu: 'file' | 'view' | 'tracking' | 'help') => {
    setOpenMenu(openMenu === menu ? null : menu);
  };

  const handleAction = (callback: () => void) => {
    setOpenMenu(null);
    callback();
  };

  return (
    <>
      <header
        ref={menuBarRef}
        className="custom-titlebar"
        onDoubleClick={handleMaximize}
      >
        {/* Left Section: Logo, Title & Menus */}
        <div className="titlebar-left">
          <div className="titlebar-brand" onClick={() => handleAction(() => onNavigateTab('dashboard'))}>
            <img
              src={MESAI_ICON_DATA_URL}
              alt="MesAI Logo"
              className="titlebar-logo"
            />
            <span className="titlebar-app-name">MesAI</span>
          </div>

          <nav className="titlebar-nav">
            {/* DOSYA MENÜSÜ */}
            <div className="menu-item-wrapper">
              <button
                type="button"
                className={`menu-trigger ${openMenu === 'file' ? 'active' : ''}`}
                onClick={() => handleMenuClick('file')}
                onMouseEnter={() => { if (openMenu) setOpenMenu('file'); }}
              >
                Dosya
              </button>
              {openMenu === 'file' && (
                <div className="dropdown-menu">
                  <button type="button" className="dropdown-btn" onClick={() => handleAction(() => onNavigateTab('report'))}>
                    <span>📝</span> <span>Günlük Raporu Gör / Dışa Aktar</span>
                  </button>
                  <button type="button" className="dropdown-btn" onClick={() => handleAction(() => onNavigateTab('projects'))}>
                    <span>📁</span> <span>Projeler & Çalışma Alanları</span>
                  </button>
                  <button type="button" className="dropdown-btn" onClick={() => handleAction(() => onNavigateTab('settings'))}>
                    <span>⚙️</span> <span>Uygulama Ayarları</span>
                  </button>
                  <div className="dropdown-divider" />
                  <button type="button" className="dropdown-btn dropdown-btn-danger" onClick={handleClose}>
                    <span>🚪</span> <span>Pencereyi Kapat</span> <span className="shortcut-hint">Alt+F4</span>
                  </button>
                </div>
              )}
            </div>

            {/* GÖRÜNÜM MENÜSÜ */}
            <div className="menu-item-wrapper">
              <button
                type="button"
                className={`menu-trigger ${openMenu === 'view' ? 'active' : ''}`}
                onClick={() => handleMenuClick('view')}
                onMouseEnter={() => { if (openMenu) setOpenMenu('view'); }}
              >
                Görünüm
              </button>
              {openMenu === 'view' && (
                <div className="dropdown-menu">
                  <button type="button" className="dropdown-btn" onClick={() => handleAction(() => onNavigateTab('dashboard'))}>
                    <DashboardIcon size={14} /> <span>Gösterge Paneli</span>
                  </button>
                  <button type="button" className="dropdown-btn" onClick={() => handleAction(() => onNavigateTab('timeline'))}>
                    <ActivityIcon size={14} /> <span>Aktivite Akışı</span>
                  </button>
                  <button type="button" className="dropdown-btn" onClick={() => handleAction(() => onNavigateTab('report'))}>
                    <ReportIcon size={14} /> <span>Günlük Rapor</span>
                  </button>
                  <button type="button" className="dropdown-btn" onClick={() => handleAction(() => onNavigateTab('projects'))}>
                    <ProjectsIcon size={14} /> <span>Projeler</span>
                  </button>
                  <button type="button" className="dropdown-btn" onClick={() => handleAction(() => onNavigateTab('integrations'))}>
                    <IntegrationsIcon size={14} /> <span>Entegrasyonlar</span>
                  </button>
                  <button type="button" className="dropdown-btn" onClick={() => handleAction(() => onNavigateTab('settings'))}>
                    <SettingsIcon size={14} /> <span>Ayarlar</span>
                  </button>
                  <div className="dropdown-divider" />
                  <button type="button" className="dropdown-btn" onClick={() => handleAction(() => onSetTheme('dark'))}>
                    <MoonIcon size={14} /> <span>Koyu Tema (Dark)</span>
                    {currentTheme === 'dark' && <span className="shortcut-hint"><CheckIcon size={12} /></span>}
                  </button>
                  <button type="button" className="dropdown-btn" onClick={() => handleAction(() => onSetTheme('light'))}>
                    <SunIcon size={14} /> <span>Açık Tema (Light)</span>
                    {currentTheme === 'light' && <span className="shortcut-hint"><CheckIcon size={12} /></span>}
                  </button>
                  <button type="button" className="dropdown-btn" onClick={() => handleAction(() => onSetTheme('system'))}>
                    <LaptopIcon size={14} /> <span>Sistem Teması (System)</span>
                    {currentTheme === 'system' && <span className="shortcut-hint"><CheckIcon size={12} /></span>}
                  </button>
                </div>
              )}
            </div>

            {/* TAKİP MENÜSÜ */}
            <div className="menu-item-wrapper">
              <button
                type="button"
                className={`menu-trigger ${openMenu === 'tracking' ? 'active' : ''}`}
                onClick={() => handleMenuClick('tracking')}
                onMouseEnter={() => { if (openMenu) setOpenMenu('tracking'); }}
              >
                Takip
              </button>
              {openMenu === 'tracking' && (
                <div className="dropdown-menu">
                  <button type="button" className="dropdown-btn" onClick={() => handleAction(onPollZoom)}>
                    <MessageSquareIcon size={14} /> <span>Şimdi Zoom Oku</span>
                  </button>
                  <button type="button" className="dropdown-btn" onClick={() => handleAction(onPollGit)}>
                    <GitCommitIcon size={14} /> <span>Şimdi Git & Dosyaları Tara</span>
                  </button>
                  <div className="dropdown-divider" />
                  <button type="button" className="dropdown-btn" onClick={() => handleAction(onTogglePaused)}>
                    {isPaused ? <PlayIcon size={14} /> : <PauseIcon size={14} />}
                    <span>{isPaused ? 'Takibi Devam Ettir' : 'Takibi Duraklat'}</span>
                  </button>
                </div>
              )}
            </div>

            {/* YARDIM MENÜSÜ */}
            <div className="menu-item-wrapper">
              <button
                type="button"
                className={`menu-trigger ${openMenu === 'help' ? 'active' : ''}`}
                onClick={() => handleMenuClick('help')}
                onMouseEnter={() => { if (openMenu) setOpenMenu('help'); }}
              >
                Yardım
              </button>
              {openMenu === 'help' && (
                <div className="dropdown-menu">
                  <button
                    type="button"
                    className="dropdown-btn"
                    onClick={() => handleAction(() => onNavigateTab('settings'))}
                  >
                    <DownloadIcon size={14} /> <span>Güncellemeleri Denetle</span>
                  </button>
                  <button
                    type="button"
                    className="dropdown-btn"
                    onClick={() =>
                      handleAction(() => {
                        window.open('https://github.com/rifkikesepara/MesAI', '_blank');
                      })
                    }
                  >
                    <ExternalLinkIcon size={14} /> <span>GitHub Deposu</span>
                  </button>
                  <div className="dropdown-divider" />
                  <button type="button" className="dropdown-btn" onClick={() => handleAction(() => setShowAbout(true))}>
                    <SettingsIcon size={14} /> <span>MesAI Hakkında</span>
                  </button>
                </div>
              )}
            </div>
          </nav>
        </div>

        {/* Center Section: Drag Title */}
        <div className="titlebar-center">
          <span className="titlebar-doc-title">MesAI — Kanıta Dayalı Günlük Çalışma Raporu</span>
        </div>

        {/* Right Section: Status Indicator, Theme Switcher & Window Controls */}
        <div className="titlebar-right">
          {updateState?.status === 'available' && (
            <button
              type="button"
              className="titlebar-pill titlebar-update-pill"
              onClick={() => onNavigateTab('settings')}
              title="Yeni sürüm mevcut!"
            >
              v{updateState.updateInfo?.version}
            </button>
          )}

          <div
            className={`titlebar-pill ${isPaused ? 'pill-warning' : 'pill-success'}`}
            onClick={onTogglePaused}
            title={isPaused ? 'Takip duraklatıldı. Başlatmak için tıklayın.' : 'Aktivite takibi aktif.'}
          >
            <span>{isPaused ? '⏸ Duraklatıldı' : '● Takip Aktif'}</span>
          </div>

          <button
            type="button"
            className="win-btn"
            style={{ width: '32px', height: '28px', borderRadius: '4px', color: 'var(--text-secondary)' }}
            onClick={() => {
              const next = currentTheme === 'dark' ? 'light' : currentTheme === 'light' ? 'system' : 'dark';
              onSetTheme(next);
            }}
            title={`Tema: ${currentTheme === 'dark' ? 'Koyu' : currentTheme === 'light' ? 'Açık' : 'Sistem'}. Değiştirmek için tıklayın.`}
          >
            {currentTheme === 'dark' && <MoonIcon size={14} />}
            {currentTheme === 'light' && <SunIcon size={14} />}
            {currentTheme === 'system' && <LaptopIcon size={14} />}
          </button>

          <div className="window-controls">
            <button
              type="button"
              className="win-btn win-btn-minimize"
              onClick={handleMinimize}
              title="Simge Durumuna Küçült"
            >
              <svg width="10" height="1" viewBox="0 0 10 1">
                <rect width="10" height="1" fill="currentColor" />
              </svg>
            </button>

            <button
              type="button"
              className="win-btn win-btn-maximize"
              onClick={handleMaximize}
              title={isMaximized ? 'Önceki Boyut' : 'Ekranı Kapla'}
            >
              {isMaximized ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M2.5 1.5H8.5V7.5" stroke="currentColor" strokeWidth="1" />
                  <rect x="1" y="2.5" width="6.5" height="6.5" stroke="currentColor" strokeWidth="1" fill="none" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect x="1" y="1" width="8" height="8" stroke="currentColor" strokeWidth="1" fill="none" />
                </svg>
              )}
            </button>

            <button
              type="button"
              className="win-btn win-btn-close"
              onClick={handleClose}
              title="Kapat"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* Hakkında Modal */}
      {showAbout && (
        <div className="modal-backdrop" onClick={() => setShowAbout(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '420px', textAlign: 'center' }}>
            <img
              src={MESAI_ICON_DATA_URL}
              alt="MesAI Logo"
              style={{ width: '64px', height: '64px', margin: '0 auto 12px auto', display: 'block' }}
            />
            <h3 style={{ margin: '0 0 4px 0', fontSize: '18px' }}>MesAI (DevTrack AI)</h3>
            <div style={{ fontSize: '13px', color: 'var(--accent)', fontWeight: 600, marginBottom: '10px' }}>
              {updateState?.currentVersion ? `Versiyon v${updateState.currentVersion}` : 'MesAI'}
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5, margin: '0 0 16px 0' }}>
              Windows üzerinde gün içindeki Zoom görüşmeleri, Git commit’leri ve dosya aktivitelerini toplayarak kurumsal Türkçe günlük çalışma raporu üreten masaüstü asistanı.
            </p>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
              Geliştirici: <strong>Rıfkı Kesepara</strong>
            </div>
            <button type="button" className="btn btn-primary" onClick={() => setShowAbout(false)} style={{ width: '100%' }}>
              Tamam
            </button>
          </div>
        </div>
      )}
    </>
  );
};
