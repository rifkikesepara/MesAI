import React, { useEffect, useState } from "react";
import type {
  AppSettings,
  IntegrationHealth,
  UpdateState,
} from "../../shared/types";
import { ZOOM_STATUS_LABELS } from "./DashboardAndProjectsView";
import { MESAI_ICON_DATA_URL } from "../assets/logo";
import {
  RefreshIcon,
  DownloadIcon,
  SparklesIcon,
  TrashIcon,
  CheckIcon,
  SunIcon,
  MoonIcon,
  LaptopIcon,
  AntigravityIcon,
  OpenAiIcon,
  AnthropicIcon,
  OllamaIcon,
  TerminalIcon,
} from "../components/Icons";
import { SkeletonIntegrations, SkeletonSettings } from "../components/Skeleton";

export const IntegrationsView: React.FC<{
  onPollZoom: () => Promise<void>;
  onPollGit: () => Promise<void>;
}> = ({ onPollZoom, onPollGit }) => {
  const [health, setHealth] = useState<IntegrationHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [jiraUrl, setJiraUrl] = useState("");
  const [jiraEmail, setJiraEmail] = useState("");
  const [jiraToken, setJiraToken] = useState("");

  const [jenkinsUrl, setJenkinsUrl] = useState("");
  const [jenkinsUser, setJenkinsUser] = useState("");
  const [jenkinsToken, setJenkinsToken] = useState("");

  const [activeAiTab, setActiveAiTab] = useState<
    "gemini" | "openai" | "anthropic" | "custom"
  >("gemini");

  const [geminiModel, setGeminiModel] = useState("");
  const [geminiModelsList, setGeminiModelsList] = useState<string[]>([
    "gemini-4-argon-medium",
    "gemini-4-argon-high",
    "gemini-4-argon-low",
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
    "claude-sonnet-5-5-medium",
    "claude-opus-5-5-medium",
    "gpt-oss-120b-medium",
  ]);
  const [loadingGeminiModels, setLoadingGeminiModels] = useState(false);

  const [openaiKey, setOpenaiKey] = useState("");
  const [openaiModel, setOpenaiModel] = useState("");
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState("");
  const [openaiMode, setOpenaiMode] = useState<"auto" | "cli" | "api">("auto");
  const [openaiModelsList, setOpenaiModelsList] = useState<string[]>([]);
  const [loadingOpenaiModels, setLoadingOpenaiModels] = useState(false);
  const [showManualOpenaiModel, setShowManualOpenaiModel] = useState(false);
  const [manualModelInput, setManualModelInput] = useState("");

  const [anthropicKey, setAnthropicKey] = useState("");
  const [anthropicModel, setAnthropicModel] = useState("");
  const [anthropicMode, setAnthropicMode] = useState<"auto" | "cli" | "api">(
    "auto",
  );
  const [anthropicModelsList, setAnthropicModelsList] = useState<string[]>([]);
  const [loadingAnthropicModels, setLoadingAnthropicModels] = useState(false);

  const [customKey, setCustomKey] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customMode, setCustomMode] = useState<"auto" | "cli" | "api">("auto");
  const [customModelsList, setCustomModelsList] = useState<string[]>([]);
  const [loadingCustomModels, setLoadingCustomModels] = useState(false);

  const [installingCli, setInstallingCli] = useState<
    "gemini" | "openai" | "anthropic" | "custom" | null
  >(null);
  const [authingCli, setAuthingCli] = useState<
    "gemini" | "openai" | "anthropic" | "custom" | null
  >(null);

  const handleInstallCli = async (
    provider: "gemini" | "openai" | "anthropic" | "custom",
  ) => {
    setInstallingCli(provider);
    const label =
      provider === "gemini"
        ? "Antigravity / Gemini (@google/gemini-cli)"
        : provider === "openai"
          ? "OpenAI Codex (@openai/codex)"
          : provider === "anthropic"
            ? "Anthropic Claude (@anthropic-ai/claude-code)"
            : "Ollama (winget)";
    setFeedback(`${label} paketi kuruluyor, lütfen bekleyin (10-60 sn)...`);
    try {
      const res = await window.mesaiApi.installCli(provider);
      if (res.ok) {
        setFeedback(`✓ ${res.message}`);
        await loadHealth();
      } else {
        setFeedback(`✕ ${res.message}`);
      }
    } catch (err) {
      setFeedback(`Kurulum hatası: ${(err as Error).message}`);
    } finally {
      setInstallingCli(null);
    }
  };

  const handleAuthCli = async (
    provider: "gemini" | "openai" | "anthropic" | "custom",
  ) => {
    setAuthingCli(provider);
    try {
      const res = await window.mesaiApi.authCli(provider);
      if (res.ok) {
        setFeedback(`✓ ${res.message}`);
      } else {
        setFeedback(`✕ ${res.message}`);
      }
    } catch (err) {
      setFeedback(`Giriş başlatma hatası: ${(err as Error).message}`);
    } finally {
      setAuthingCli(null);
    }
  };

  const fetchModelsFor = async (
    provider: "openai" | "anthropic" | "custom",
    keyOverride?: string,
    urlOverride?: string,
  ) => {
    if (provider === "openai") {
      const keyToUse =
        keyOverride !== undefined ? keyOverride.trim() : openaiKey.trim();
      const urlToUse =
        urlOverride !== undefined ? urlOverride.trim() : openaiBaseUrl.trim();
      setLoadingOpenaiModels(true);
      try {
        const res = await window.mesaiApi.fetchAiModels({
          provider: "openai",
          apiKey: keyToUse || undefined,
          customBaseUrl: urlToUse || undefined,
        });
        if (res.ok && res.models && res.models.length > 0) {
          setOpenaiModelsList(res.models);
          setOpenaiModel((prev) =>
            prev && (res.models.includes(prev) || prev === "6.1sol")
              ? prev
              : res.models.find((m) => m === "gpt-4o-mini") || res.models[0],
          );
        }
      } catch {
        // non-blocking
      } finally {
        setLoadingOpenaiModels(false);
      }
    } else if (provider === "anthropic") {
      const keyToUse =
        keyOverride !== undefined ? keyOverride.trim() : anthropicKey.trim();
      setLoadingAnthropicModels(true);
      try {
        const res = await window.mesaiApi.fetchAiModels({
          provider: "anthropic",
          apiKey: keyToUse || undefined,
        });
        if (res.ok && res.models && res.models.length > 0) {
          setAnthropicModelsList(res.models);
          setAnthropicModel((prev) =>
            prev && res.models.includes(prev)
              ? prev
              : res.models.find((m) => m.includes("sonnet")) || res.models[0],
          );
        }
      } catch {
        // non-blocking
      } finally {
        setLoadingAnthropicModels(false);
      }
    } else if (provider === "custom") {
      const keyToUse =
        keyOverride !== undefined ? keyOverride.trim() : customKey.trim();
      const urlToUse =
        urlOverride !== undefined ? urlOverride.trim() : customBaseUrl.trim();
      setLoadingCustomModels(true);
      try {
        const res = await window.mesaiApi.fetchAiModels({
          provider: "custom",
          apiKey: keyToUse || undefined,
          customBaseUrl: urlToUse || undefined,
        });
        if (res.ok && res.models && res.models.length > 0) {
          setCustomModelsList(res.models);
          setCustomModel((prev) =>
            prev && res.models.includes(prev) ? prev : res.models[0],
          );
        }
      } catch {
        // non-blocking
      } finally {
        setLoadingCustomModels(false);
      }
    }
  };

  const loadHealth = async () => {
    setLoading(true);
    try {
      const h = await window.mesaiApi.getIntegrationsHealth();
      setHealth(h);
      setJiraUrl(h.jira.url || "");
      setJenkinsUrl(h.jenkins.url || "");
      setOpenaiModel(h.ai.openaiModel || "gpt-4o-mini");
      setOpenaiBaseUrl(h.ai.openaiBaseUrl || "");
      setOpenaiMode(
        h.ai.openaiMode || (h.ai.openaiCliInstalled ? "cli" : "auto"),
      );
      setAnthropicModel(h.ai.anthropicModel || "claude-3-5-sonnet-20241022");
      setAnthropicMode(
        h.ai.anthropicMode || (h.ai.anthropicCliInstalled ? "cli" : "auto"),
      );
      setCustomBaseUrl(h.ai.customBaseUrl || "");
      setCustomModel(h.ai.customModel || "gpt-4o-mini");
      setCustomMode(
        h.ai.customMode || (h.ai.customCliInstalled ? "cli" : "auto"),
      );

      if (h.ai.openaiConfigured || h.ai.openaiCliInstalled) {
        void fetchModelsFor("openai", undefined, h.ai.openaiBaseUrl);
      }
      if (h.ai.anthropicConfigured || h.ai.anthropicCliInstalled) {
        void fetchModelsFor("anthropic");
      }
      if (h.ai.customConfigured || h.ai.customCliInstalled) {
        void fetchModelsFor("custom", undefined, h.ai.customBaseUrl);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadHealth();
  }, []);

  const handleSaveJira = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await window.mesaiApi.saveIntegrationSecret({
        service: "jira",
        url: jiraUrl,
        usernameOrEmail: jiraEmail,
        token: jiraToken,
      });
      setJiraToken("");
      setFeedback(
        "Jira bilgileri OS DPAPI (safeStorage) ile şifrelenerek kaydedildi.",
      );
      await loadHealth();
    } catch (err) {
      setFeedback(`Hata: ${(err as Error).message}`);
    }
  };

  const handleTestJira = async () => {
    setFeedback("Jira bağlantısı test ediliyor...");
    const res = await window.mesaiApi.testIntegrationConnection("jira");
    setFeedback(res.message);
    await loadHealth();
  };

  const handleSaveJenkins = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await window.mesaiApi.saveIntegrationSecret({
        service: "jenkins",
        url: jenkinsUrl,
        usernameOrEmail: jenkinsUser,
        token: jenkinsToken,
      });
      setJenkinsToken("");
      setFeedback(
        "Jenkins bilgileri OS DPAPI (safeStorage) ile şifrelenerek kaydedildi.",
      );
      await loadHealth();
    } catch (err) {
      setFeedback(`Hata: ${(err as Error).message}`);
    }
  };

  const handleTestJenkins = async () => {
    setFeedback("Jenkins bağlantısı test ediliyor...");
    const res = await window.mesaiApi.testIntegrationConnection("jenkins");
    setFeedback(res.message);
    await loadHealth();
  };

  const handleSaveOpenAi = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    try {
      await window.mesaiApi.saveAiApiKey({
        provider: "openai",
        apiKey: openaiKey || undefined,
        model: openaiModel,
        customBaseUrl: openaiBaseUrl || undefined,
        mode: openaiMode,
      });
      setOpenaiKey("");
      setFeedback("OpenAI ayarları başarıyla kaydedildi.");
      await loadHealth();
    } catch (err) {
      setFeedback(`Hata: ${(err as Error).message}`);
    }
  };

  const handleTestOpenAi = async () => {
    setFeedback("OpenAI bağlantısı test ediliyor...");
    const res = await window.mesaiApi.testAiConnection("openai");
    setFeedback(res.message);
    await loadHealth();
  };

  const handleSaveAnthropic = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    try {
      await window.mesaiApi.saveAiApiKey({
        provider: "anthropic",
        apiKey: anthropicKey || undefined,
        model: anthropicModel,
        mode: anthropicMode,
      });
      setAnthropicKey("");
      setFeedback("Anthropic Claude ayarları başarıyla kaydedildi.");
      await loadHealth();
    } catch (err) {
      setFeedback(`Hata: ${(err as Error).message}`);
    }
  };

  const handleTestAnthropic = async () => {
    setFeedback("Anthropic Claude bağlantısı test ediliyor...");
    const res = await window.mesaiApi.testAiConnection("anthropic");
    setFeedback(res.message);
    await loadHealth();
  };

  const handleSaveCustom = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    try {
      await window.mesaiApi.saveAiApiKey({
        provider: "custom",
        apiKey: customKey || undefined,
        model: customModel,
        customBaseUrl,
        mode: customMode,
      });
      setCustomKey("");
      setFeedback("Özel AI ayarları başarıyla kaydedildi.");
      await loadHealth();
    } catch (err) {
      setFeedback(`Hata: ${(err as Error).message}`);
    }
  };

  const handleTestCustom = async () => {
    setFeedback("Özel AI API bağlantısı test ediliyor...");
    const res = await window.mesaiApi.testAiConnection("custom");
    setFeedback(res.message);
    await loadHealth();
  };

  if (loading && !health) {
    return <SkeletonIntegrations />;
  }

  if (!health) {
    return (
      <div className="card">
        <button className="btn btn-primary" onClick={loadHealth}>
          Yeniden Dene
        </button>
      </div>
    );
  }

  const zoomStatus =
    ZOOM_STATUS_LABELS[health.zoom.status] ?? ZOOM_STATUS_LABELS.idle;

  return (
    <div>
      {feedback && <div className="alert-banner">{feedback}</div>}

      <div className="grid-2">
        {/* 1. Zoom Local UIA Reader */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">1. Yerel Zoom Team Chat UIA Okuyucu</h3>
            <span className={`badge ${zoomStatus.badge}`}>
              {zoomStatus.text}
            </span>
          </div>
          <div style={{ fontSize: "13px", display: "grid", gap: "6px" }}>
            <div>
              <strong>Yürütülebilir Dosya:</strong>{" "}
              <code>{health.zoom.executablePath}</code> (
              {health.zoom.executableExists ? "Mevcut ✓" : "Bulunamadı ✕"})
            </div>
            <div>
              <strong>Açık Sohbet:</strong>{" "}
              {health.zoom.activeChatName || "Yok"} (Pencere:{" "}
              {health.zoom.windowState || "bilinmiyor"})
            </div>
            <div>
              <strong>Son Başarılı Okuma:</strong>{" "}
              {health.zoom.lastSuccessAt || "Henüz yok"}
            </div>
            <div>
              <strong>Toplam Kayıt:</strong> {health.zoom.recordsCount}
            </div>
            {health.zoom.lastError && (
              <div style={{ color: "#fca5a5" }}>
                <strong>Durum Mesajı:</strong> {health.zoom.lastError}
              </div>
            )}
            <div style={{ marginTop: "8px" }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={async () => {
                  await onPollZoom();
                  await loadHealth();
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <RefreshIcon size={14} />
                <span>Şimdi Zoom Penceresini Oku</span>
              </button>
            </div>
          </div>
        </div>

        {/* 2. Git & File Watcher */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">2. Git CLI & Dosya İzleyici</h3>
            <span
              className={`badge ${health.git.gitVersion ? "badge-success" : "badge-danger"}`}
            >
              {health.git.gitVersion ? "Hazır ✓" : "Git Bulunamadı"}
            </span>
          </div>
          <div style={{ fontSize: "13px", display: "grid", gap: "6px" }}>
            <div>
              <strong>Kurulu Git Sürümü:</strong>{" "}
              <code>{health.git.gitVersion || "Yok"}</code>
            </div>
            <div>
              <strong>İzlenen Etkin Proje Sayısı:</strong>{" "}
              {health.git.watchedProjectsCount}
            </div>
            <div>
              <strong>Son Tarama Zamanı:</strong>{" "}
              {health.git.lastSuccessAt || "Henüz yok"}
            </div>
            {health.git.lastError && (
              <div style={{ color: "#fca5a5" }}>
                <strong>Son Hata:</strong> {health.git.lastError}
              </div>
            )}
            <div style={{ marginTop: "8px" }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={async () => {
                  await onPollGit();
                  await loadHealth();
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <RefreshIcon size={14} />
                <span>Şimdi Git Depolarını Tara</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 3. AI Provider Layer (Unified Single Card) */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">3. Raporlama ve AI Sağlayıcı Katmanı</h3>
          <span className="badge badge-success">
            Aktif:{" "}
            {health.ai.activeProvider === "local_rule"
              ? "Yerel Kurallı Motor"
              : health.ai.activeProvider === "gemini_cli"
                ? "Antigravity / Gemini CLI"
                : health.ai.activeProvider === "openai"
                  ? "OpenAI / Codex"
                  : health.ai.activeProvider === "anthropic"
                    ? "Anthropic Claude"
                    : "Özel / Yerel LLM"}
          </span>
        </div>

        <div
          style={{
            fontSize: "13px",
            display: "grid",
            gap: "6px",
            marginBottom: "14px",
          }}
        >
          <div>
            <strong>Yerel Kurallı Motor (LocalRuleProvider):</strong> Hazır
            (%100 çevrimdışı, veri dışarı çıkmaz)
          </div>
          <div>
            <strong>Uzak AI Veri Gönderim İzni:</strong>{" "}
            {health.ai.remoteAiAllowed
              ? "Açık (Her zaman önizleme ile)"
              : "Kapalı (Varsayılan Güvenli Mod)"}
          </div>
          {health.ai.lastError && (
            <div style={{ color: "#fbbf24" }}>
              <strong>Son AI Notu / Durumu:</strong> {health.ai.lastError}
            </div>
          )}
        </div>

        {/* AI Provider Config Tabs */}
        <div
          style={{
            borderTop: "1px solid var(--border-color)",
            paddingTop: "12px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "8px",
              marginBottom: "12px",
            }}
          >
            <span style={{ fontSize: "13px", fontWeight: 600 }}>
              API Entegrasyonu ve Model Yapılandırması:
            </span>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              <button
                type="button"
                className={`btn btn-sm ${activeAiTab === "gemini" ? "btn-primary" : ""}`}
                onClick={() => setActiveAiTab("gemini")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <AntigravityIcon size={14} />
                <span>Antigravity / Gemini</span>
              </button>
              <button
                type="button"
                className={`btn btn-sm ${activeAiTab === "openai" ? "btn-primary" : ""}`}
                onClick={() => setActiveAiTab("openai")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <OpenAiIcon size={14} />
                <span>OpenAI / Codex</span>
              </button>
              <button
                type="button"
                className={`btn btn-sm ${activeAiTab === "anthropic" ? "btn-primary" : ""}`}
                onClick={() => setActiveAiTab("anthropic")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <AnthropicIcon size={14} />
                <span>Anthropic Claude</span>
              </button>
              <button
                type="button"
                className={`btn btn-sm ${activeAiTab === "custom" ? "btn-primary" : ""}`}
                onClick={() => setActiveAiTab("custom")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <OllamaIcon size={14} />
                <span>Özel LLM / Ollama</span>
                {health.ai.customConfigured && (
                  <span style={{ opacity: 0.9 }}>✓</span>
                )}
              </button>
            </div>
          </div>

          {/* Active Tab Panel */}
          {activeAiTab === "gemini" && (
            <div
              style={{
                display: "grid",
                gap: "10px",
                background: "var(--bg-primary)",
                padding: "12px",
                borderRadius: "8px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span style={{ fontSize: "12.5px", fontWeight: 600 }}>
                  Antigravity / Gemini CLI (agy)
                </span>
                <span
                  className={`badge ${health.ai.geminiCliInstalled ? "badge-success" : "badge-danger"}`}
                >
                  {health.ai.geminiCliInstalled
                    ? `Kurulu (${health.ai.geminiCliVersion})`
                    : "Kurulu Değil"}
                </span>
              </div>

              {health.ai.geminiCliInstalled ? (
                <div
                  style={{
                    background: "var(--bg-tertiary)",
                    borderLeft: "3px solid #10b981",
                    padding: "10px 12px",
                    borderRadius: "4px",
                    fontSize: "12px",
                    display: "grid",
                    gap: "4px",
                  }}
                >
                  <div
                    style={{ fontWeight: 600, color: "var(--text-primary)" }}
                  >
                    ✓ Antigravity CLI Ortamda Hazır
                  </div>
                  <div style={{ color: "var(--text-secondary)" }}>
                    Sistemde <code>agy.exe</code> ({health.ai.geminiCliVersion})
                    tespit edildi. API anahtarı girmenize gerek yoktur; oturum
                    terminal üzerinden doğrudan çalışır.
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    background: "var(--bg-tertiary)",
                    borderLeft: "3px solid #ef4444",
                    padding: "10px 12px",
                    borderRadius: "4px",
                    fontSize: "12px",
                    display: "grid",
                    gap: "4px",
                  }}
                >
                  <div style={{ fontWeight: 600, color: "#ef4444" }}>
                    ✕ Antigravity CLI Bulunamadı
                  </div>
                  <div style={{ color: "var(--text-secondary)" }}>
                    Antigravity CLI (agy) veya Gemini CLI bilgisayarınızda
                    tespit edilemedi.
                  </div>
                </div>
              )}

              <div>
                <label
                  style={{ fontSize: "12px", color: "var(--text-secondary)" }}
                >
                  Kullanılabilir Antigravity Modelleri
                </label>
                <select
                  className="select"
                  style={{ width: "100%" }}
                  value={geminiModel || geminiModelsList[0]}
                  onChange={(e) => setGeminiModel(e.target.value)}
                >
                  {geminiModelsList.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <span
                  style={{
                    fontSize: "11px",
                    color: "var(--text-muted)",
                    marginTop: "4px",
                    display: "block",
                  }}
                >
                  Antigravity CLI (agy) model parametresi ve print modu ile tam
                  uyumlu çalışır.
                </span>
              </div>

              <div style={{ display: "flex", gap: "8px", marginTop: "4px", flexWrap: "wrap" }}>
                {!health.ai.geminiCliInstalled ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={installingCli === "gemini"}
                    onClick={() => handleInstallCli("gemini")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <DownloadIcon size={14} />
                    <span>
                      {installingCli === "gemini"
                        ? "Kuruluyor..."
                        : "Gemini CLI Kur (@google/gemini-cli)"}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={authingCli === "gemini"}
                    onClick={() => handleAuthCli("gemini")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <TerminalIcon size={14} />
                    <span>
                      {authingCli === "gemini"
                        ? "Başlatılıyor..."
                        : "Giriş Yap (Auth)"}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    setFeedback("Antigravity CLI bağlantısı test ediliyor...");
                    await loadHealth();
                    if (health.ai.geminiCliInstalled) {
                      setFeedback(
                        `Antigravity CLI hazır ve çalışıyor (${health.ai.geminiCliVersion}).`,
                      );
                    } else {
                      setFeedback("Antigravity CLI bulunamadı.");
                    }
                  }}
                >
                  Durumu Denetle / Test Et
                </button>
              </div>
            </div>
          )}
          {activeAiTab === "openai" && (
            <form
              onSubmit={handleSaveOpenAi}
              style={{
                display: "grid",
                gap: "10px",
                background: "var(--bg-primary)",
                padding: "12px",
                borderRadius: "8px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span style={{ fontSize: "12.5px", fontWeight: 600 }}>
                  OpenAI / Codex
                </span>
                <span
                  className={`badge ${health.ai.openaiConfigured || health.ai.openaiCliInstalled ? "badge-success" : "badge-neutral"}`}
                >
                  {health.ai.openaiCliInstalled && openaiMode !== "api"
                    ? `Yerel Codex CLI Aktif (${health.ai.openaiModel})`
                    : health.ai.openaiConfigured
                      ? `API Yapılandırıldı (${health.ai.openaiModel})`
                      : "Yapılandırılmadı"}
                </span>
              </div>

              {health.ai.openaiCliInstalled ? (
                <div
                  style={{
                    background: "var(--bg-tertiary)",
                    borderLeft: "3px solid #10b981",
                    padding: "8px 12px",
                    borderRadius: "4px",
                    fontSize: "12px",
                  }}
                >
                  <strong>✓ Yerel Codex CLI Bulundu:</strong>{" "}
                  {health.ai.openaiCliVersion} —{" "}
                  <em>
                    API Key zorunlu değildir, yerel ChatGPT/Codex oturumunuz
                    kullanılır.
                  </em>
                </div>
              ) : (
                <div
                  style={{
                    background: "var(--bg-tertiary)",
                    borderLeft: "3px solid #f59e0b",
                    padding: "8px 12px",
                    borderRadius: "4px",
                    fontSize: "12px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "8px",
                  }}
                >
                  <div>
                    <strong>OpenAI Codex CLI:</strong> Sisteminizde kurulu değil (@openai/codex).
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={installingCli === "openai"}
                    onClick={() => handleInstallCli("openai")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <DownloadIcon size={14} />
                    <span>
                      {installingCli === "openai" ? "Kuruluyor..." : "Codex CLI Kur"}
                    </span>
                  </button>
                </div>
              )}

              <div>
                <label
                  style={{ fontSize: "12px", color: "var(--text-secondary)" }}
                >
                  Çalışma Modu
                </label>
                <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
                  <button
                    type="button"
                    className={`btn btn-sm ${openaiMode !== "api" ? "btn-primary" : ""}`}
                    onClick={async () => {
                      setOpenaiMode("cli");
                      await window.mesaiApi.saveAiApiKey({
                        provider: "openai",
                        mode: "cli",
                        model: openaiModel,
                      });
                      await loadHealth();
                    }}
                  >
                    Yerel CLI (API Key Gerekmez)
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${openaiMode === "api" ? "btn-primary" : ""}`}
                    onClick={async () => {
                      setOpenaiMode("api");
                      await window.mesaiApi.saveAiApiKey({
                        provider: "openai",
                        mode: "api",
                        model: openaiModel,
                      });
                      await loadHealth();
                    }}
                  >
                    Uzak API (API Key İle)
                  </button>
                </div>
              </div>

              <div>
                <label
                  style={{ fontSize: "12px", color: "var(--text-secondary)" }}
                >
                  {openaiMode !== "api"
                    ? "API Anahtarı (Yerel CLI modunda boş bırakılabilir)"
                    : "API Anahtarı (Giriş yapıldığında modeller otomatik çekilir)"}
                </label>
                <input
                  type="password"
                  className="input"
                  placeholder={
                    openaiMode !== "api" && health.ai.openaiCliInstalled
                      ? "Yerel Codex CLI oturumu kullanılacak (API anahtarı gerekmez)"
                      : health.ai.openaiConfigured
                        ? "Yeni anahtar girmek için yazın (mevcut anahtar DPAPI ile şifreli kayıtlı)"
                        : "OpenAI API Key (sk-...)"
                  }
                  value={openaiKey}
                  onChange={(e) => {
                    setOpenaiKey(e.target.value);
                    if (e.target.value.trim().length >= 20) {
                      void fetchModelsFor("openai", e.target.value);
                    }
                  }}
                  onBlur={(e) => {
                    if (e.target.value.trim()) {
                      void fetchModelsFor("openai", e.target.value);
                    }
                  }}
                />
              </div>

              <div>
                <label
                  style={{ fontSize: "12px", color: "var(--text-secondary)" }}
                >
                  API Base URL (Opsiyonel - Proxy veya Özel Uç Nokta için)
                </label>
                <input
                  className="input"
                  placeholder="https://api.openai.com/v1 (Varsayılan)"
                  value={openaiBaseUrl}
                  onChange={(e) => setOpenaiBaseUrl(e.target.value)}
                  onBlur={() => {
                    if (openaiBaseUrl.trim()) {
                      void fetchModelsFor(
                        "openai",
                        undefined,
                        openaiBaseUrl.trim(),
                      );
                    }
                  }}
                />
              </div>

              <div>
                <label
                  style={{ fontSize: "12px", color: "var(--text-secondary)" }}
                >
                  Model Seçimi (API'den otomatik çekilen modeller)
                </label>
                {showManualOpenaiModel ? (
                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                      alignItems: "center",
                    }}
                  >
                    <input
                      className="input"
                      style={{ flex: 1 }}
                      placeholder="Örn: 6.1sol, gpt-4o, o3-mini..."
                      value={manualModelInput}
                      onChange={(e) => setManualModelInput(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={async () => {
                        const trimmed = manualModelInput.trim();
                        if (!trimmed) return;
                        setOpenaiModel(trimmed);
                        setShowManualOpenaiModel(false);
                        try {
                          await window.mesaiApi.saveAiApiKey({
                            provider: "openai",
                            model: trimmed,
                            customBaseUrl: openaiBaseUrl || undefined,
                          });
                          setFeedback(
                            `OpenAI modeli "${trimmed}" olarak kaydedildi.`,
                          );
                          await loadHealth();
                        } catch {
                          // non-blocking
                        }
                      }}
                    >
                      Uygula
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setShowManualOpenaiModel(false)}
                    >
                      İptal
                    </button>
                  </div>
                ) : (
                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                      alignItems: "center",
                    }}
                  >
                    <select
                      className="select"
                      style={{ flex: 1 }}
                      value={openaiModel}
                      onChange={async (e) => {
                        const newModel = e.target.value;
                        setOpenaiModel(newModel);
                        try {
                          await window.mesaiApi.saveAiApiKey({
                            provider: "openai",
                            model: newModel,
                            customBaseUrl: openaiBaseUrl || undefined,
                          });
                          await loadHealth();
                        } catch {
                          // non-blocking
                        }
                      }}
                      disabled={loadingOpenaiModels}
                    >
                      {loadingOpenaiModels ? (
                        <option value="">Modeller API'den çekiliyor...</option>
                      ) : (
                        <>
                          {openaiModel &&
                            !openaiModelsList.includes(openaiModel) &&
                            ![
                              "gpt-4o-mini",
                              "gpt-4o",
                              "o1-mini",
                              "o1-preview",
                            ].includes(openaiModel) && (
                              <option value={openaiModel}>
                                {openaiModel} (Aktif Seçili Model)
                              </option>
                            )}
                          {openaiModelsList.length > 0 ? (
                            openaiModelsList.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))
                          ) : (
                            <>
                              <option value="gpt-4o-mini">
                                gpt-4o-mini (Varsayılan Hızlı & Ekonomik)
                              </option>
                              <option value="gpt-4o">
                                gpt-4o (Amiral Gemisi)
                              </option>
                              <option value="o1-mini">
                                o1-mini (Akıl Yürütme)
                              </option>
                              <option value="o1-preview">o1-preview</option>
                            </>
                          )}
                        </>
                      )}
                    </select>
                    <button
                      type="button"
                      className="btn btn-sm"
                      title="Modelleri API'den Yenile"
                      onClick={() =>
                        fetchModelsFor("openai", undefined, openaiBaseUrl)
                      }
                      disabled={loadingOpenaiModels}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                      }}
                    >
                      <RefreshIcon size={12} />
                      <span>
                        {loadingOpenaiModels ? "Çekiliyor..." : "Yenile"}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      title="Listede olmayan modeli elle yazın (örn: 6.1sol)"
                      onClick={() => {
                        setManualModelInput(openaiModel);
                        setShowManualOpenaiModel(true);
                      }}
                    >
                      Manuel Model
                    </button>
                  </div>
                )}
              </div>

              <div style={{ display: "flex", gap: "8px", marginTop: "4px", flexWrap: "wrap" }}>
                <button type="submit" className="btn btn-sm btn-primary">
                  Şifreli Kaydet
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleTestOpenAi}
                >
                  Bağlantı Testi
                </button>
                {health.ai.openaiCliInstalled ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={authingCli === "openai"}
                    onClick={() => handleAuthCli("openai")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <TerminalIcon size={14} />
                    <span>
                      {authingCli === "openai"
                        ? "Başlatılıyor..."
                        : "Codex Giriş Yap (Auth)"}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={installingCli === "openai"}
                    onClick={() => handleInstallCli("openai")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <DownloadIcon size={14} />
                    <span>
                      {installingCli === "openai"
                        ? "Kuruluyor..."
                        : "Codex CLI Kur"}
                    </span>
                  </button>
                )}
              </div>
            </form>
          )}

          {activeAiTab === "anthropic" && (
            <form
              onSubmit={handleSaveAnthropic}
              style={{
                display: "grid",
                gap: "10px",
                background: "var(--bg-primary)",
                padding: "12px",
                borderRadius: "8px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span style={{ fontSize: "12.5px", fontWeight: 600 }}>
                  Anthropic Claude
                </span>
                <span
                  className={`badge ${health.ai.anthropicConfigured || health.ai.anthropicCliInstalled ? "badge-success" : "badge-neutral"}`}
                >
                  {health.ai.anthropicCliInstalled && anthropicMode !== "api"
                    ? `Yerel Claude CLI Aktif (${health.ai.anthropicModel})`
                    : health.ai.anthropicConfigured
                      ? `API Yapılandırıldı (${health.ai.anthropicModel})`
                      : "Yapılandırılmadı"}
                </span>
              </div>

              {health.ai.anthropicCliInstalled ? (
                <div
                  style={{
                    background: "var(--bg-tertiary)",
                    borderLeft: "3px solid #10b981",
                    padding: "8px 12px",
                    borderRadius: "4px",
                    fontSize: "12px",
                  }}
                >
                  <strong>✓ Yerel Claude Code CLI Bulundu:</strong>{" "}
                  {health.ai.anthropicCliVersion} —{" "}
                  <em>
                    API Key zorunlu değildir, yerel Claude oturumunuz
                    kullanılır.
                  </em>
                </div>
              ) : (
                <div
                  style={{
                    background: "var(--bg-tertiary)",
                    borderLeft: "3px solid #f59e0b",
                    padding: "8px 12px",
                    borderRadius: "4px",
                    fontSize: "12px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "8px",
                  }}
                >
                  <div>
                    <strong>Anthropic Claude Code CLI:</strong> Sisteminizde kurulu değil (@anthropic-ai/claude-code).
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={installingCli === "anthropic"}
                    onClick={() => handleInstallCli("anthropic")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <DownloadIcon size={14} />
                    <span>
                      {installingCli === "anthropic" ? "Kuruluyor..." : "Claude CLI Kur"}
                    </span>
                  </button>
                </div>
              )}

              <div>
                <label
                  style={{ fontSize: "12px", color: "var(--text-secondary)" }}
                >
                  Çalışma Modu
                </label>
                <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
                  <button
                    type="button"
                    className={`btn btn-sm ${anthropicMode !== "api" ? "btn-primary" : ""}`}
                    onClick={async () => {
                      setAnthropicMode("cli");
                      await window.mesaiApi.saveAiApiKey({
                        provider: "anthropic",
                        mode: "cli",
                        model: anthropicModel,
                      });
                      await loadHealth();
                    }}
                  >
                    Yerel CLI (API Key Gerekmez)
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${anthropicMode === "api" ? "btn-primary" : ""}`}
                    onClick={async () => {
                      setAnthropicMode("api");
                      await window.mesaiApi.saveAiApiKey({
                        provider: "anthropic",
                        mode: "api",
                        model: anthropicModel,
                      });
                      await loadHealth();
                    }}
                  >
                    Uzak API (API Key İle)
                  </button>
                </div>
              </div>

              <div>
                <label
                  style={{ fontSize: "12px", color: "var(--text-secondary)" }}
                >
                  {anthropicMode !== "api"
                    ? "API Anahtarı (Yerel CLI modunda boş bırakılabilir)"
                    : "API Anahtarı (Giriş yapıldığında modeller otomatik çekilir)"}
                </label>
                <input
                  type="password"
                  className="input"
                  placeholder={
                    anthropicMode !== "api" && health.ai.anthropicCliInstalled
                      ? "Yerel Claude Code CLI oturumu kullanılacak (API anahtarı gerekmez)"
                      : health.ai.anthropicConfigured
                        ? "Yeni anahtar girmek için yazın (mevcut anahtar DPAPI ile şifreli kayıtlı)"
                        : "Claude API Key (sk-ant-...)"
                  }
                  value={anthropicKey}
                  onChange={(e) => {
                    setAnthropicKey(e.target.value);
                    if (e.target.value.trim().length >= 20) {
                      void fetchModelsFor("anthropic", e.target.value);
                    }
                  }}
                  onBlur={(e) => {
                    if (e.target.value.trim()) {
                      void fetchModelsFor("anthropic", e.target.value);
                    }
                  }}
                />
              </div>

              <div>
                <label
                  style={{ fontSize: "12px", color: "var(--text-secondary)" }}
                >
                  Model Seçimi (API'den otomatik çekilen modeller)
                </label>
                <div
                  style={{ display: "flex", gap: "8px", alignItems: "center" }}
                >
                  <select
                    className="select"
                    style={{ flex: 1 }}
                    value={anthropicModel}
                    onChange={async (e) => {
                      const newModel = e.target.value;
                      setAnthropicModel(newModel);
                      try {
                        await window.mesaiApi.saveAiApiKey({
                          provider: "anthropic",
                          model: newModel,
                        });
                        await loadHealth();
                      } catch {
                        // non-blocking
                      }
                    }}
                    disabled={loadingAnthropicModels}
                  >
                    {loadingAnthropicModels ? (
                      <option value="">Modeller API'den çekiliyor...</option>
                    ) : anthropicModelsList.length > 0 ? (
                      anthropicModelsList.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))
                    ) : (
                      <>
                        <option value="claude-3-5-sonnet-20241022">
                          claude-3-5-sonnet-20241022 (Tavsiye Edilen)
                        </option>
                        <option value="claude-3-5-haiku-20241022">
                          claude-3-5-haiku-20241022 (Hızlı & Ekonomik)
                        </option>
                        <option value="claude-3-opus-20240229">
                          claude-3-opus-20240229
                        </option>
                      </>
                    )}
                  </select>
                  <button
                    type="button"
                    className="btn btn-sm"
                    title="Modelleri API'den Yenile"
                    onClick={() => fetchModelsFor("anthropic")}
                    disabled={loadingAnthropicModels}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                    }}
                  >
                    <RefreshIcon size={12} />
                    <span>
                      {loadingAnthropicModels ? "Çekiliyor..." : "Yenile"}
                    </span>
                  </button>
                </div>
              </div>

              <div style={{ display: "flex", gap: "8px", marginTop: "4px", flexWrap: "wrap" }}>
                <button type="submit" className="btn btn-sm btn-primary">
                  Şifreli Kaydet
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleTestAnthropic}
                >
                  Bağlantı Testi
                </button>
                {health.ai.anthropicCliInstalled ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={authingCli === "anthropic"}
                    onClick={() => handleAuthCli("anthropic")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <TerminalIcon size={14} />
                    <span>
                      {authingCli === "anthropic"
                        ? "Başlatılıyor..."
                        : "Claude Giriş Yap (Auth)"}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={installingCli === "anthropic"}
                    onClick={() => handleInstallCli("anthropic")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <DownloadIcon size={14} />
                    <span>
                      {installingCli === "anthropic"
                        ? "Kuruluyor..."
                        : "Claude CLI Kur"}
                    </span>
                  </button>
                )}
              </div>
            </form>
          )}

          {activeAiTab === "custom" && (
            <form
              onSubmit={handleSaveCustom}
              style={{
                display: "grid",
                gap: "10px",
                background: "var(--bg-primary)",
                padding: "12px",
                borderRadius: "8px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span style={{ fontSize: "12.5px", fontWeight: 600 }}>
                  Özel / Yerel LLM (Ollama, vLLM, DeepSeek, OpenRouter)
                </span>
                <span
                  className={`badge ${health.ai.customConfigured || health.ai.customCliInstalled ? "badge-success" : "badge-neutral"}`}
                >
                  {health.ai.customCliInstalled && customMode !== "api"
                    ? `Yerel Ollama CLI Aktif (${health.ai.customModel || "llama3.2"})`
                    : health.ai.customConfigured
                      ? "Yapılandırıldı"
                      : "Yapılandırılmadı"}
                </span>
              </div>

              {health.ai.customCliInstalled ? (
                <div
                  style={{
                    background: "var(--bg-tertiary)",
                    borderLeft: "3px solid #10b981",
                    padding: "8px 12px",
                    borderRadius: "4px",
                    fontSize: "12px",
                  }}
                >
                  <strong>✓ Yerel Ollama CLI Bulundu:</strong>{" "}
                  {health.ai.customCliVersion} —{" "}
                  <em>
                    API Key veya URL gerektirmez; yerel model doğrudan
                    çalıştırılır.
                  </em>
                </div>
              ) : (
                <div
                  style={{
                    background: "var(--bg-tertiary)",
                    borderLeft: "3px solid #f59e0b",
                    padding: "8px 12px",
                    borderRadius: "4px",
                    fontSize: "12px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "8px",
                  }}
                >
                  <div>
                    <strong>Yerel Ollama CLI:</strong> Sisteminizde kurulu değil.
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={installingCli === "custom"}
                    onClick={() => handleInstallCli("custom")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <DownloadIcon size={14} />
                    <span>
                      {installingCli === "custom"
                        ? "Kuruluyor..."
                        : "Ollama Kur (winget)"}
                    </span>
                  </button>
                </div>
              )}

              <div>
                <label
                  style={{ fontSize: "12px", color: "var(--text-secondary)" }}
                >
                  Çalışma Modu
                </label>
                <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
                  <button
                    type="button"
                    className={`btn btn-sm ${customMode !== "api" ? "btn-primary" : ""}`}
                    onClick={async () => {
                      setCustomMode("cli");
                      await window.mesaiApi.saveAiApiKey({
                        provider: "custom",
                        mode: "cli",
                        model: customModel,
                        customBaseUrl,
                      });
                      await loadHealth();
                    }}
                  >
                    Yerel Ollama CLI (API Key Gerekmez)
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${customMode === "api" ? "btn-primary" : ""}`}
                    onClick={async () => {
                      setCustomMode("api");
                      await window.mesaiApi.saveAiApiKey({
                        provider: "custom",
                        mode: "api",
                        model: customModel,
                        customBaseUrl,
                      });
                      await loadHealth();
                    }}
                  >
                    HTTP API Uç Noktası
                  </button>
                </div>
              </div>

              <div className="grid-2">
                <div>
                  <label
                    style={{ fontSize: "12px", color: "var(--text-secondary)" }}
                  >
                    API Base URL
                  </label>
                  <input
                    className="input"
                    placeholder="Örn: http://localhost:11434/v1 veya https://api.deepseek.com/v1"
                    value={customBaseUrl}
                    onChange={(e) => {
                      setCustomBaseUrl(e.target.value);
                      if (e.target.value.trim().startsWith("http")) {
                        void fetchModelsFor(
                          "custom",
                          undefined,
                          e.target.value,
                        );
                      }
                    }}
                    onBlur={(e) => {
                      if (e.target.value.trim()) {
                        void fetchModelsFor(
                          "custom",
                          undefined,
                          e.target.value,
                        );
                      }
                    }}
                  />
                </div>
                <div>
                  <label
                    style={{ fontSize: "12px", color: "var(--text-secondary)" }}
                  >
                    API Anahtarı (Yerel Ollama için boş bırakılabilir)
                  </label>
                  <input
                    type="password"
                    className="input"
                    placeholder="Varsa API Token (DPAPI ile şifrelenir)"
                    value={customKey}
                    onChange={(e) => setCustomKey(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label
                  style={{ fontSize: "12px", color: "var(--text-secondary)" }}
                >
                  Model Adı / Seçimi{" "}
                  {loadingCustomModels && "(Uç noktadan çekiliyor...)"}
                </label>
                <div
                  style={{ display: "flex", gap: "8px", alignItems: "center" }}
                >
                  {customModelsList.length > 0 ? (
                    <select
                      className="select"
                      style={{ flex: 1 }}
                      value={customModel}
                      onChange={async (e) => {
                        const newModel = e.target.value;
                        setCustomModel(newModel);
                        try {
                          await window.mesaiApi.saveAiApiKey({
                            provider: "custom",
                            model: newModel,
                            customBaseUrl: customBaseUrl || undefined,
                          });
                          await loadHealth();
                        } catch {
                          // non-blocking
                        }
                      }}
                      disabled={loadingCustomModels}
                    >
                      {customModelsList.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="input"
                      style={{ flex: 1 }}
                      placeholder="Örn: llama3.1, deepseek-chat, qwen2.5-coder:7b"
                      value={customModel}
                      onChange={(e) => setCustomModel(e.target.value)}
                      onBlur={async () => {
                        if (customModel.trim()) {
                          try {
                            await window.mesaiApi.saveAiApiKey({
                              provider: "custom",
                              model: customModel.trim(),
                              customBaseUrl: customBaseUrl || undefined,
                            });
                            await loadHealth();
                          } catch {
                            // non-blocking
                          }
                        }
                      }}
                    />
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    title="Uç Noktadan Modelleri Getir"
                    onClick={() => fetchModelsFor("custom")}
                    disabled={loadingCustomModels}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                    }}
                  >
                    <RefreshIcon size={12} />
                    <span>
                      {loadingCustomModels ? "Çekiliyor..." : "Modelleri Çek"}
                    </span>
                  </button>
                </div>
              </div>

              <div style={{ display: "flex", gap: "8px", marginTop: "4px", flexWrap: "wrap" }}>
                <button type="submit" className="btn btn-sm btn-primary">
                  Ayarları Kaydet
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleTestCustom}
                >
                  Bağlantı Testi
                </button>
                {health.ai.customCliInstalled ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={authingCli === "custom"}
                    onClick={() => handleAuthCli("custom")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <TerminalIcon size={14} />
                    <span>
                      {authingCli === "custom"
                        ? "Başlatılıyor..."
                        : "Ollama Terminali Aç"}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={installingCli === "custom"}
                    onClick={() => handleInstallCli("custom")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <DownloadIcon size={14} />
                    <span>
                      {installingCli === "custom"
                        ? "Kuruluyor..."
                        : "Ollama Kur (winget)"}
                    </span>
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      </div>

      {/* 4. Optional Jira & Jenkins */}
      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              4. Jira Entegrasyonu (İsteğe Bağlı / Salt-Okunur)
            </h3>
            <span
              className={`badge ${
                health.jira.status === "connected"
                  ? "badge-success"
                  : health.jira.status === "error"
                    ? "badge-danger"
                    : "badge-neutral"
              }`}
            >
              {health.jira.status === "not_configured"
                ? "Yapılandırılmadı"
                : health.jira.status === "untested"
                  ? "Doğrulanmadı (Test Bekliyor)"
                  : health.jira.status === "connected"
                    ? "Bağlantı Doğrulandı"
                    : "Bağlantı Hatası"}
            </span>
          </div>
          <form
            onSubmit={handleSaveJira}
            style={{ display: "grid", gap: "8px" }}
          >
            <input
              className="input"
              placeholder="Jira URL (Örn: https://32bitbilgisayar.atlassian.net)"
              value={jiraUrl}
              onChange={(e) => setJiraUrl(e.target.value)}
            />
            <input
              className="input"
              placeholder="Kurumsal E-posta"
              value={jiraEmail}
              onChange={(e) => setJiraEmail(e.target.value)}
            />
            <input
              type="password"
              className="input"
              placeholder="Jira API Token (DPAPI ile şifrelenir, SQLite'a düz yazılmaz)"
              value={jiraToken}
              onChange={(e) => setJiraToken(e.target.value)}
            />
            {health.jira.lastError && (
              <div style={{ fontSize: "12px", color: "#fca5a5" }}>
                {health.jira.lastError}
              </div>
            )}
            <div style={{ display: "flex", gap: "8px" }}>
              <button type="submit" className="btn btn-sm btn-primary">
                Şifreli Kaydet
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={handleTestJira}
              >
                Gerçek Bağlantı Testi Yap
              </button>
            </div>
          </form>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              5. Jenkins Entegrasyonu (İsteğe Bağlı / Salt-Okunur)
            </h3>
            <span
              className={`badge ${
                health.jenkins.status === "connected"
                  ? "badge-success"
                  : health.jenkins.status === "error"
                    ? "badge-danger"
                    : "badge-neutral"
              }`}
            >
              {health.jenkins.status === "not_configured"
                ? "Yapılandırılmadı"
                : health.jenkins.status === "untested"
                  ? "Doğrulanmadı (Test Bekliyor)"
                  : health.jenkins.status === "connected"
                    ? "Bağlantı Doğrulandı"
                    : "Bağlantı Hatası"}
            </span>
          </div>
          <form
            onSubmit={handleSaveJenkins}
            style={{ display: "grid", gap: "8px" }}
          >
            <input
              className="input"
              placeholder="Jenkins URL (Örn: https://jenkins.sirket.local)"
              value={jenkinsUrl}
              onChange={(e) => setJenkinsUrl(e.target.value)}
            />
            <input
              className="input"
              placeholder="Kullanıcı Adı"
              value={jenkinsUser}
              onChange={(e) => setJenkinsUser(e.target.value)}
            />
            <input
              type="password"
              className="input"
              placeholder="Jenkins API Token (DPAPI ile şifrelenir)"
              value={jenkinsToken}
              onChange={(e) => setJenkinsToken(e.target.value)}
            />
            {health.jenkins.lastError && (
              <div style={{ fontSize: "12px", color: "#fca5a5" }}>
                {health.jenkins.lastError}
              </div>
            )}
            <div style={{ display: "flex", gap: "8px" }}>
              <button type="submit" className="btn btn-sm btn-primary">
                Şifreli Kaydet
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={handleTestJenkins}
              >
                Gerçek Bağlantı Testi Yap
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export const SettingsView: React.FC<{
  settings: AppSettings | null;
  onUpdateSettings: (partial: Partial<AppSettings>) => Promise<void>;
  onClearAllData: () => Promise<void>;
}> = ({ settings, onUpdateSettings, onClearAllData }) => {
  const [form, setForm] = useState<AppSettings | null>(settings);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  useEffect(() => {
    void window.mesaiApi.getUpdateState().then(setUpdateState);
    const cleanup = window.mesaiApi.onUpdateStateChanged((state) => {
      setUpdateState(state);
    });
    return () => {
      cleanup?.();
    };
  }, []);

  const handleCheckUpdates = async () => {
    setCheckingUpdate(true);
    try {
      const res = await window.mesaiApi.checkForUpdates();
      setUpdateState(res);
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleDownloadUpdate = async () => {
    await window.mesaiApi.downloadUpdate();
  };

  const handleInstallUpdate = async () => {
    await window.mesaiApi.quitAndInstallUpdate();
  };

  if (!form) {
    return <SkeletonSettings />;
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await onUpdateSettings({
      zoomPollIntervalSeconds: Math.max(
        10,
        Number(form.zoomPollIntervalSeconds) || 30,
      ),
      gitPollIntervalSeconds: Math.max(
        20,
        Number(form.gitPollIntervalSeconds) || 60,
      ),
      workdayStart: form.workdayStart,
      workdayEnd: form.workdayEnd,
      endOfDayNotification: form.endOfDayNotification,
      timezone: form.timezone,
      retentionDays: Math.max(7, Number(form.retentionDays) || 90),
      aiProvider: form.aiProvider,
      aiModel: form.aiModel,
      aiCustomBaseUrl: form.aiCustomBaseUrl,
      allowRemoteAiSend: form.allowRemoteAiSend,
      autoLaunchOnStartup: form.autoLaunchOnStartup,
      autoCheckUpdatesOnStartup: form.autoCheckUpdatesOnStartup,
      trackingPaused: form.trackingPaused,
    });
    setSavedMsg("Ayarlar kaydedildi ve zamanlayıcılar güncellendi.");
    setTimeout(() => setSavedMsg(null), 3500);
  };

  return (
    <div>
      {savedMsg && <div className="alert-banner">{savedMsg}</div>}

      {/* Antigravity Theme Switcher */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Görünüm ve Tema (Antigravity Theme)</h3>
          <span className="badge badge-info">
            {form.theme === "dark"
              ? "Koyu Tema"
              : form.theme === "light"
                ? "Açık Tema"
                : "Sistem Teması"}
          </span>
        </div>
        <p
          style={{
            color: "var(--text-secondary)",
            fontSize: "13px",
            margin: "0 0 12px 0",
          }}
        >
          MesAI arayüz temasını seçin. Sistem seçildiğinde Windows renk
          düzeninizle anlık otomatik eşitlenir.
        </p>

        <div className="theme-tile-group">
          <button
            type="button"
            className={`theme-tile ${(form.theme || "system") === "dark" ? "active" : ""}`}
            onClick={async () => {
              setForm({ ...form, theme: "dark" });
              await onUpdateSettings({ theme: "dark" });
            }}
          >
            <div className="theme-tile-header">
              <MoonIcon size={18} />
              <span className="theme-tile-title">Koyu Tema</span>
              {(form.theme || "system") === "dark" && <CheckIcon size={16} />}
            </div>
            <div className="theme-tile-desc">
              #101010 nötr koyu tonlar ve yüksek kontrastlı okuma konforu.
            </div>
          </button>

          <button
            type="button"
            className={`theme-tile ${(form.theme || "system") === "light" ? "active" : ""}`}
            onClick={async () => {
              setForm({ ...form, theme: "light" });
              await onUpdateSettings({ theme: "light" });
            }}
          >
            <div className="theme-tile-header">
              <SunIcon size={18} />
              <span className="theme-tile-title">Açık Tema</span>
              {(form.theme || "system") === "light" && <CheckIcon size={16} />}
            </div>
            <div className="theme-tile-desc">
              Temiz beyaz arka plan ve net koyu tipografi.
            </div>
          </button>

          <button
            type="button"
            className={`theme-tile ${(form.theme || "system") === "system" ? "active" : ""}`}
            onClick={async () => {
              setForm({ ...form, theme: "system" });
              await onUpdateSettings({ theme: "system" });
            }}
          >
            <div className="theme-tile-header">
              <LaptopIcon size={18} />
              <span className="theme-tile-title">Sistem</span>
              {(form.theme || "system") === "system" && <CheckIcon size={16} />}
            </div>
            <div className="theme-tile-desc">
              Windows işletim sistemi temasını otomatik algılar ve takip eder.
            </div>
          </button>
        </div>
      </div>

      <form
        onSubmit={handleSave}
        className="card"
        style={{ display: "grid", gap: "14px" }}
      >
        <h3 className="card-title">
          Toplama Aralıkları, Zamanlama ve Gizlilik Ayarları
        </h3>

        <div className="grid-2">
          <div>
            <label
              style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}
            >
              Zoom Okuma Aralığı (saniye, min 10 sn)
            </label>
            <input
              type="number"
              min={10}
              className="input"
              value={form.zoomPollIntervalSeconds}
              onChange={(e) =>
                setForm({
                  ...form,
                  zoomPollIntervalSeconds: parseInt(e.target.value, 10) || 30,
                })
              }
            />
          </div>

          <div>
            <label
              style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}
            >
              Git Çalışma Ağacı & Commit Tarama Aralığı (saniye, min 20 sn)
            </label>
            <input
              type="number"
              min={20}
              className="input"
              value={form.gitPollIntervalSeconds}
              onChange={(e) =>
                setForm({
                  ...form,
                  gitPollIntervalSeconds: parseInt(e.target.value, 10) || 60,
                })
              }
            />
          </div>

          <div>
            <label
              style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}
            >
              Mesai Başlangıç Saati
            </label>
            <input
              type="time"
              className="input"
              value={form.workdayStart}
              onChange={(e) =>
                setForm({ ...form, workdayStart: e.target.value })
              }
            />
          </div>

          <div>
            <label
              style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}
            >
              Mesai Bitiş ve Rapor Hatırlatma Saati
            </label>
            <input
              type="time"
              className="input"
              value={form.workdayEnd}
              onChange={(e) => setForm({ ...form, workdayEnd: e.target.value })}
            />
          </div>

          <div>
            <label
              style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}
            >
              Saat Dilimi
            </label>
            <input
              className="input"
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
            />
          </div>

          <div>
            <label
              style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}
            >
              Yerel Veri Saklama Süresi (Gün)
            </label>
            <input
              type="number"
              min={7}
              className="input"
              value={form.retentionDays}
              onChange={(e) =>
                setForm({
                  ...form,
                  retentionDays: parseInt(e.target.value, 10) || 90,
                })
              }
            />
          </div>

          <div>
            <label
              style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}
            >
              Varsayılan Raporlama AI Sağlayıcısı
            </label>
            <select
              className="select"
              value={form.aiProvider}
              onChange={(e) =>
                setForm({ ...form, aiProvider: e.target.value as any })
              }
            >
              <option value="local_rule">
                Yerel Kurallı Motor (%100 Çevrimdışı — Güvenli)
              </option>
              <option value="gemini_cli">Antigravity / Gemini CLI (agy)</option>
              <option value="openai">OpenAI / Codex API</option>
              <option value="anthropic">Anthropic Claude API</option>
              <option value="custom">Özel / Yerel LLM (OpenAI-Uyumlu)</option>
            </select>
          </div>

          <div>
            <label
              style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}
            >
              Aktif AI Model Adı (Opsiyonel)
            </label>
            <input
              className="input"
              placeholder="Örn: gpt-4o-mini, claude-3-5-sonnet-20241022, deepseek-chat"
              value={form.aiModel || ""}
              onChange={(e) => setForm({ ...form, aiModel: e.target.value })}
            />
          </div>
        </div>

        <div style={{ display: "grid", gap: "8px", marginTop: "6px" }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={form.endOfDayNotification}
              onChange={(e) =>
                setForm({ ...form, endOfDayNotification: e.target.checked })
              }
            />
            Mesai bitiş saatinde onaylanmamış günlük rapor için Windows
            bildirimi göster
          </label>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={form.allowRemoteAiSend}
              onChange={(e) =>
                setForm({ ...form, allowRemoteAiSend: e.target.checked })
              }
            />
            Uzak AI servisine (Antigravity CLI / OpenAI / Claude / Özel API)
            yapılandırılmış aktivite özeti gönderimine izin ver (Her zaman
            önizleme ile)
          </label>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={form.autoLaunchOnStartup}
              onChange={(e) =>
                setForm({ ...form, autoLaunchOnStartup: e.target.checked })
              }
            />
            Windows açılışında MesAI uygulamasını otomatik başlat
          </label>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={form.autoCheckUpdatesOnStartup ?? true}
              onChange={(e) =>
                setForm({
                  ...form,
                  autoCheckUpdatesOnStartup: e.target.checked,
                })
              }
            />
            Uygulama açılışında arka planda yeni sürüm kontrolü yap
          </label>
        </div>

        <div>
          <button
            type="submit"
            className="btn btn-primary"
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            <CheckIcon size={14} />
            <span>Ayarları Kaydet</span>
          </button>
        </div>
      </form>

      {/* Sürüm Kontrolü ve Güncelleme Kartı */}
      <div
        className="card"
        style={{ border: "1px solid rgba(99, 102, 241, 0.4)" }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "10px",
          }}
        >
          <div>
            <h3
              className="card-title"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                margin: 0,
              }}
            >
              <img
                src={MESAI_ICON_DATA_URL}
                alt="MesAI"
                style={{ width: "22px", height: "22px", objectFit: "contain" }}
              />
              <span>Uygulama Sürümü ve Otomatik Güncellemeler</span>
              <span
                className="badge badge-neutral"
                style={{ fontSize: "12px", fontWeight: 600 }}
              >
                {updateState?.currentVersion
                  ? `v${updateState.currentVersion}`
                  : ""}
              </span>
            </h3>
            <p
              style={{
                color: "var(--text-secondary)",
                fontSize: "13px",
                margin: "4px 0 0 0",
              }}
            >
              GitHub Releases üzerinden versiyon kontrolü, sürüm notları ve
              uygulama içi güncelleme.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleCheckUpdates}
            disabled={
              checkingUpdate ||
              updateState?.status === "checking" ||
              updateState?.status === "downloading"
            }
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            <RefreshIcon size={14} />
            <span>
              {checkingUpdate || updateState?.status === "checking"
                ? "Denetleniyor..."
                : "Güncellemeleri Denetle"}
            </span>
          </button>
        </div>

        {/* Durum Bilgisi */}
        {updateState?.status === "checking" && (
          <div
            className="alert-banner"
            style={{
              marginTop: "12px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <RefreshIcon size={14} />
            <span>GitHub Releases üzerinden yeni sürüm denetleniyor...</span>
          </div>
        )}

        {updateState?.status === "not_available" && (
          <div
            className="alert-banner"
            style={{
              marginTop: "12px",
              background: "rgba(16, 185, 129, 0.1)",
              borderColor: "var(--success)",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <CheckIcon size={14} />
            <span>
              Uygulamanız en son sürümde (v{updateState.currentVersion}). Yeni
              bir güncelleme bulunmuyor.
            </span>
          </div>
        )}

        {updateState?.status === "available" && updateState.updateInfo && (
          <div
            style={{
              marginTop: "12px",
              padding: "14px",
              borderRadius: "8px",
              background: "rgba(99, 102, 241, 0.1)",
              border: "1px solid var(--accent)",
              display: "grid",
              gap: "10px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div
                style={{
                  fontWeight: 600,
                  color: "var(--accent)",
                  fontSize: "15px",
                }}
              >
                Yeni Sürüm Mevcut: v{updateState.updateInfo.version}
              </div>
              {updateState.updateInfo.releaseDate && (
                <div
                  style={{ fontSize: "12px", color: "var(--text-secondary)" }}
                >
                  Yayınlanma:{" "}
                  {new Date(
                    updateState.updateInfo.releaseDate,
                  ).toLocaleDateString("tr-TR")}
                </div>
              )}
            </div>

            {updateState.updateInfo.releaseNotes && (
              <div
                style={{
                  background: "var(--bg-primary)",
                  padding: "10px",
                  borderRadius: "6px",
                  fontSize: "13px",
                  maxHeight: "160px",
                  overflowY: "auto",
                }}
              >
                <div
                  style={{
                    fontWeight: 600,
                    marginBottom: "4px",
                    color: "var(--text-secondary)",
                  }}
                >
                  Sürüm Notları:
                </div>
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    fontFamily: "inherit",
                  }}
                >
                  {updateState.updateInfo.releaseNotes}
                </pre>
              </div>
            )}

            <div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleDownloadUpdate}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <DownloadIcon size={14} />
                <span>
                  Güncellemeyi İndir (v{updateState.updateInfo.version})
                </span>
              </button>
            </div>
          </div>
        )}

        {updateState?.status === "downloading" && (
          <div
            style={{
              marginTop: "12px",
              padding: "14px",
              borderRadius: "8px",
              background: "var(--bg-secondary)",
              border: "1px solid var(--accent)",
              display: "grid",
              gap: "8px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "13px",
              }}
            >
              <span>⬇️ Yeni sürüm indiriliyor...</span>
              <span style={{ fontWeight: 600 }}>
                {updateState.progress?.percent ?? 0}%
              </span>
            </div>
            <div
              style={{
                background: "var(--bg-tertiary)",
                borderRadius: "6px",
                height: "10px",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${updateState.progress?.percent ?? 0}%`,
                  background: "var(--accent)",
                  height: "100%",
                  transition: "width 0.2s",
                }}
              />
            </div>
            {updateState.progress && (
              <div
                style={{
                  fontSize: "12px",
                  color: "var(--text-secondary)",
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span>
                  {(
                    updateState.progress.transferredBytes /
                    1024 /
                    1024
                  ).toFixed(1)}{" "}
                  MB /{" "}
                  {(updateState.progress.totalBytes / 1024 / 1024).toFixed(1)}{" "}
                  MB
                </span>
                <span>
                  {(
                    (updateState.progress.bytesPerSecond || 0) /
                    1024 /
                    1024
                  ).toFixed(1)}{" "}
                  MB/sn
                </span>
              </div>
            )}
          </div>
        )}

        {updateState?.status === "downloaded" && (
          <div
            style={{
              marginTop: "12px",
              padding: "14px",
              borderRadius: "8px",
              background: "rgba(16, 185, 129, 0.1)",
              border: "1px solid var(--success)",
              display: "grid",
              gap: "10px",
            }}
          >
            <div
              style={{
                fontWeight: 600,
                color: "var(--success)",
                fontSize: "15px",
              }}
            >
              🎉 Güncelleme başarıyla indirildi ve kuruluma hazır!
            </div>
            <p
              style={{
                margin: 0,
                fontSize: "13px",
                color: "var(--text-secondary)",
              }}
            >
              Uygulamayı yeniden başlatarak yeni sürüme geçebilirsiniz.
            </p>
            <div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleInstallUpdate}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <SparklesIcon size={14} />
                <span>Şimdi Yeniden Başlat ve Güncelle</span>
              </button>
            </div>
          </div>
        )}

        {updateState?.status === "error" && (
          <div
            style={{
              marginTop: "12px",
              padding: "12px",
              borderRadius: "8px",
              background: "rgba(239, 68, 68, 0.1)",
              border: "1px solid var(--danger)",
              fontSize: "13px",
            }}
          >
            <div
              style={{
                fontWeight: 600,
                color: "var(--danger)",
                marginBottom: "4px",
              }}
            >
              ⚠️ Güncelleme Denetimi Hatası
            </div>
            <div style={{ color: "var(--text-secondary)" }}>
              {updateState.errorMessage || "Bilinmeyen bir hata oluştu."}
            </div>
          </div>
        )}

        <div
          style={{
            marginTop: "10px",
            fontSize: "11.5px",
            color: "var(--text-secondary)",
          }}
        >
          {updateState?.lastCheckedAt
            ? `Son Denetleme: ${new Date(updateState.lastCheckedAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
            : "Henüz denetleme yapılmadı."}
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">
          Koruyucu Dosya Filtreleri (Varsayılan Hariç Tutulanlar)
        </h3>
        <p style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
          Aşağıdaki klasör ve dosya kalıpları dosya izleme ve Git çalışma ağacı
          taramalarından otomatik olarak hariç tutulur:
        </p>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {form.globalExclusions.map((ex) => (
            <span key={ex} className="badge badge-neutral">
              {ex}
            </span>
          ))}
          <span className="badge badge-neutral">.env*</span>
          <span className="badge badge-neutral">*.tmp / *.log / *.swp</span>
        </div>
      </div>

      <div className="card" style={{ borderColor: "rgba(239, 68, 68, 0.4)" }}>
        <h3 className="card-title" style={{ color: "#fca5a5" }}>
          Yerel Veri Yönetimi ve Temizleme
        </h3>
        <p style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
          Toplanmış tüm aktiviteleri, kaynak kanıtlarını ve rapor taslaklarını
          yerel SQLite veritabanından kalıcı olarak silebilirsiniz.
        </p>
        {!confirmClear ? (
          <button
            className="btn btn-danger"
            onClick={() => setConfirmClear(true)}
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            <TrashIcon size={14} />
            <span>Toplanan Tüm Yerel Verileri Temizle</span>
          </button>
        ) : (
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <span style={{ color: "#fca5a5", fontSize: "13px" }}>
              Tüm aktiviteler ve raporlar silinecek. Emin misiniz?
            </span>
            <button
              className="btn btn-danger"
              onClick={async () => {
                await onClearAllData();
                setConfirmClear(false);
                setSavedMsg(
                  "Tüm yerel aktivite ve rapor kayıtları temizlendi.",
                );
              }}
            >
              Evet, Kalıcı Olarak Sil
            </button>
            <button className="btn" onClick={() => setConfirmClear(false)}>
              Vazgeç
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
