# MesAI (DevTrack AI) — Kanıta Dayalı Günlük Çalışma Raporu Uygulaması

Windows üzerinde gün içindeki yazılım geliştirme (Git commitleri, çalışma ağacı ve debounced dosya aktiviteleri), teknik görüşme ve toplantı aktivitelerini (yerel Windows UI Automation tabanlı Zoom Team Chat okuyucusu ve hızlı notlar) toplayarak **kanıta dayalı Türkçe günlük çalışma raporu** üreten masaüstü uygulaması.

## 1. Mimari ve Teknoloji Yığını

- **Masaüstü Çatısı:** Electron 35 + React 19 + TypeScript + Vite 6 (`contextIsolation: true`, `nodeIntegration: false`)
- **Yerel Veritabanı:** SQLite (`node:sqlite` / `DatabaseSync`, WAL modu, otomatik şema migration yapısı)
- **Yerel Zoom Okuyucu (`readers/ZoomChatReader`):** C# / .NET 10 (`net10.0-windows`, WPF `UIAutomationClient` / `UIAutomationTypes`)
- **Raporlama ve AI Katmanı:**
  - **Varsayılan (`LocalRuleProvider`):** %100 yerel, çevrimdışı, deterministik kurallı Türkçe rapor üreticisi.
  - **İsteğe Bağlı (`GeminiCliProvider`):** Güvenli argüman dizisi (`execFile`), girdi boyutu sınırı, 35 sn zaman aşımı, `<untrusted_evidence_json>` prompt injection izolasyonu, veri gönderim önizlemesi ve JSON şema doğrulaması ile çalışan CLI adaptörü. Hata durumunda verileri koruyarak otomatik yerel kurallı üretime döner.
- **Güvenli Kimlik Saklama:** İsteğe bağlı Jira ve Jenkins salt-okunur entegrasyonlarında API anahtarları düz metin SQLite'a **yazılmaz**; Windows DPAPI (`electron.safeStorage`) ile şifrelenerek saklanır.

---

## 2. Yerel Zoom Okuyucu (`ZoomChatReader`) Kapsamı ve Sınırlamaları

Zoom API veya geliştirici uygulaması yetkisi bulunmadığından, Zoom verisi yalnızca yerel `ZoomChatReader.exe` yardımcı süreci üzerinden **salt-okunur** olarak toplanır:

1. **Pencere ve Görünüm Kapsamı:**
   - Yalnızca o an Zoom Workplace (`ZPPTMainFrmWndClassEx` -> `Chrome_RenderWidgetHostHWND`) içinde açık olan sohbeti (`_chatPanel_`) ve sanal listede (`_virtualList_`) yüklü DOM tamponundaki mesajları okur.
   - Pencere simge durumuna küçültülmüş (`minimized`) olsa dahi pencereyi öne getirmeden arka planda okuyabilir.
   - Yan etki (okundu işaretleme, odak çalma) oluşturmamak için otomatik kaydırma (scroll) veya başka sohbetlere tıklama **yapmaz**.
2. **Durum Ayrıştırması:**
   - Okuyucu her çalışmada `status` alanı üretir: `ok`, `zoom_not_running`, `window_minimized_or_hidden`, `chat_panel_not_open`, `timeout` veya `error`.
3. **Tekilleştirme (Deduplication):**
   - Zoom UIA ağacı sunucu/veritabanı mesaj ID'si (`persistentMessageId: null`) sunmaz.
   - Tekilleştirme `sessionId/chatName + çözümlenen tarih + görünen saat + gönderen + içerik özeti (SHA-256) + görünüm içi sıra numarası (occurrenceIndexInView)` ile yapılır. Tekrarlanan okumalar kopya oluşturmaz; aynı kişinin aynı dakikada gönderdiği ikinci aynı metin ise `occurrenceIndexInView` ile korunur.
4. **Göreli Tarih Çözümleme:**
   - `Today`, `Yesterday`, `Wed`, `16:25` gibi ifadeler gözlem zamanı ve yerel saat dilimi (`+03:00`) ile çözümlenir; özgün tarih ifadesi (`rawTimestampText`) her zaman korunur.

---

## 3. Gereksinimler ve Çalışma Ortamı

- **İşletim Sistemi:** Windows 10 / 11 (x64)
- **Node.js:** `v22.5.0+` veya `v24.x` (`node:sqlite` yerleşik desteği için)
- **.NET SDK / Runtime:** `.NET 10.0 Windows Desktop Runtime` (`net10.0-windows`, `ZoomChatReader.exe` derlemesi ve çalışması için)
- **Git CLI:** `git` komutunun `PATH` üzerinde erişilebilir olması

---

## 4. Geliştirme, Test ve Paketleme Komutları

Proje kök dizini: `C:\Repos\MesAI`

```powershell
# 1. Bağımlılıkları yükle
npm install

# 2. Yalnızca C# ZoomChatReader okuyucusunu derle (Release)
npm run build:reader

# 3. Tüm projeyi derle (ZoomChatReader + Electron Main + React Renderer)
npm run build

# 4. Birim ve entegrasyon testlerini çalıştır (8 doğrulama senaryosu)
npm test

# 5. Masaüstü uygulamasını başlat
npm start

# 6. Gerçek ortam duman testi (Zoom + Git okuma + Rapor üretimi + JSON doğrulama)
npx electron . --verify-smoke

# 7. Paketlenmiş Windows uygulama dizini oluştur (dist-electron/win-unpacked)
npm run pack:dir

# 8. Windows Portable (.exe) paketi üret (dist-electron/MesAI-1.0.0-Portable.exe)
npm run pack:win
```

### Okuyucunun Paketlenmesi (`extraResources`)
`electron-builder.yml` yapılandırması, `readers/ZoomChatReader/bin/Release/net10.0-windows` altındaki derlenmiş `ZoomChatReader.exe` ve bağımlılıklarını paketlenmiş uygulamanın `resources/ZoomChatReader/` dizinine kopyalar. `ZoomReaderAdapter` çalışma zamanında önce `process.resourcesPath/ZoomChatReader/ZoomChatReader.exe` yolunu, geliştirme modunda ise `readers/ZoomChatReader/bin/Release/net10.0-windows/ZoomChatReader.exe` yolunu otomatik kullanır.
