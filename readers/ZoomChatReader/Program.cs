using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Windows.Automation;

namespace ZoomChatReader;

public sealed class ChatSnapshot
{
    [JsonPropertyName("schemaVersion")]
    public string SchemaVersion { get; set; } = "1.1";

    [JsonPropertyName("status")]
    public string Status { get; set; } = "ok"; // "ok" | "zoom_not_running" | "window_minimized_or_hidden" | "chat_panel_not_open" | "error"

    [JsonPropertyName("errorMessage")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ErrorMessage { get; set; }

    [JsonPropertyName("capturedAt")]
    public string CapturedAt { get; set; } = "";

    [JsonPropertyName("windowTitle")]
    public string WindowTitle { get; set; } = "";

    [JsonPropertyName("windowState")]
    public string WindowState { get; set; } = "normal"; // "normal" | "minimized" | "hidden"

    [JsonPropertyName("chatName")]
    public string? ChatName { get; set; }

    [JsonPropertyName("chatType")]
    public string? ChatType { get; set; }

    [JsonPropertyName("sessionId")]
    public string? SessionId { get; set; }

    [JsonPropertyName("limitations")]
    public List<string> Limitations { get; set; } = [];

    [JsonPropertyName("messages")]
    public List<ChatMessageItem> Messages { get; set; } = [];

    [JsonPropertyName("comparison")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public SnapshotComparison? Comparison { get; set; }
}

public sealed class ChatMessageItem
{
    [JsonPropertyName("indexInDom")]
    public int IndexInDom { get; set; }

    [JsonPropertyName("occurrenceIndexInView")]
    public int OccurrenceIndexInView { get; set; }

    [JsonPropertyName("fingerprint")]
    public string Fingerprint { get; set; } = "";

    [JsonPropertyName("uiaRuntimeId")]
    public string UiaRuntimeId { get; set; } = "";

    [JsonPropertyName("persistentMessageId")]
    public string? PersistentMessageId { get; set; }

    [JsonPropertyName("isGroupedFollowUp")]
    public bool IsGroupedFollowUp { get; set; }

    [JsonPropertyName("isThreadReply")]
    public bool IsThreadReply { get; set; }

    [JsonPropertyName("isUnreadReply")]
    public bool IsUnreadReply { get; set; }

    [JsonPropertyName("dateGroup")]
    public string? DateGroup { get; set; }

    [JsonPropertyName("visibleTimestamp")]
    public string? VisibleTimestamp { get; set; }

    [JsonPropertyName("sender")]
    public string? Sender { get; set; }

    [JsonPropertyName("senderResolved")]
    public string? SenderResolved { get; set; }

    [JsonPropertyName("isSentByMe")]
    public bool IsSentByMe { get; set; }

    [JsonPropertyName("messageType")]
    public string MessageType { get; set; } = "text"; // "text" | "call"

    [JsonPropertyName("text")]
    public string? Text { get; set; }

    [JsonPropertyName("links")]
    public List<string> Links { get; set; } = [];

    [JsonPropertyName("callRecord")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public CallRecordInfo? CallRecord { get; set; }

    [JsonPropertyName("rawAccessibleLabel")]
    public string? RawAccessibleLabel { get; set; }
}

public sealed class CallRecordInfo
{
    [JsonPropertyName("direction")]
    public string Direction { get; set; } = "unknown"; // "incoming" | "outgoing" | "unknown"

    [JsonPropertyName("iconLabel")]
    public string? IconLabel { get; set; }

    [JsonPropertyName("statusText")]
    public string? StatusText { get; set; }
}

public sealed class SnapshotComparison
{
    [JsonPropertyName("previousCapturedAt")]
    public string PreviousCapturedAt { get; set; } = "";

    [JsonPropertyName("previousTotalCount")]
    public int PreviousTotalCount { get; set; }

    [JsonPropertyName("currentTotalCount")]
    public int CurrentTotalCount { get; set; }

    [JsonPropertyName("exactSameElementCount")]
    public int ExactSameElementCount { get; set; }

    [JsonPropertyName("probableSameMessageCount")]
    public int ProbableSameMessageCount { get; set; }

    [JsonPropertyName("newlyVisibleCount")]
    public int NewlyVisibleCount { get; set; }

    [JsonPropertyName("newlyVisibleMessages")]
    public List<ChatMessageItem> NewlyVisibleMessages { get; set; } = [];
}

internal static class Win32Desktop
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
}

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;

        string? stateFile = null;
        bool compareTwice = false;
        int delayMs = 1500;

        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--state-file" && i + 1 < args.Length)
                stateFile = args[++i];
            else if (args[i] == "--compare-twice")
                compareTwice = true;
            else if (args[i] == "--delay-ms" && i + 1 < args.Length && int.TryParse(args[++i], out int d))
                delayMs = d;
            else if (args[i] == "--self-test")
                return RunSelfTest();
        }

        ChatSnapshot? result = null;

        var staThread = new Thread(() =>
        {
            try
            {
                if (compareTwice)
                {
                    var first = CaptureZoomChatSafe();
                    Thread.Sleep(delayMs);
                    var second = CaptureZoomChatSafe();
                    if (first.Status == "ok" && second.Status == "ok")
                    {
                        second.Comparison = CompareSnapshots(first, second);
                    }
                    result = second;
                }
                else
                {
                    var current = CaptureZoomChatSafe();
                    if (current.Status == "ok" && !string.IsNullOrEmpty(stateFile) && File.Exists(stateFile))
                    {
                        try
                        {
                            var prevJson = File.ReadAllText(stateFile, Encoding.UTF8);
                            var prev = JsonSerializer.Deserialize<ChatSnapshot>(prevJson);
                            if (prev != null && prev.Status == "ok")
                            {
                                current.Comparison = CompareSnapshots(prev, current);
                            }
                        }
                        catch { }
                    }
                    if (current.Status == "ok" && !string.IsNullOrEmpty(stateFile))
                    {
                        var dir = Path.GetDirectoryName(Path.GetFullPath(stateFile));
                        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                        File.WriteAllText(stateFile, SerializeSnapshot(current), Encoding.UTF8);
                    }
                    result = current;
                }
            }
            catch (Exception ex)
            {
                result = new ChatSnapshot
                {
                    Status = "error",
                    ErrorMessage = ex.Message,
                    CapturedAt = DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz")
                };
            }
        });

        staThread.SetApartmentState(ApartmentState.STA);
        staThread.Start();
        staThread.Join();

        if (result != null)
        {
            Console.WriteLine(SerializeSnapshot(result));
        }

        return 0;
    }

    private static string SerializeSnapshot(ChatSnapshot snapshot)
    {
        var opts = new JsonSerializerOptions
        {
            WriteIndented = true,
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
        };
        return JsonSerializer.Serialize(snapshot, opts);
    }

    private static bool IsMeetingActive(HashSet<uint> zoomPids)
    {
        // 1. Zoom video / meeting child host processes
        try
        {
            if (Process.GetProcessesByName("CptHost").Length > 0 ||
                Process.GetProcessesByName("aomhost64").Length > 0)
            {
                return true;
            }
        }
        catch { }

        // 2. Check for active Meeting window ("Zoom Meeting")
        bool meetingWindowFound = false;
        try
        {
            Win32Desktop.EnumWindows((hWnd, _) =>
            {
                Win32Desktop.GetWindowThreadProcessId(hWnd, out uint pid);
                if (!zoomPids.Contains(pid)) return true;

                if (!Win32Desktop.IsWindowVisible(hWnd)) return true;

                var sbTitle = new StringBuilder(256);
                Win32Desktop.GetWindowText(hWnd, sbTitle, 256);
                string title = sbTitle.ToString();

                if (title.StartsWith("Zoom Meeting", StringComparison.OrdinalIgnoreCase) ||
                    title.Contains("Meeting", StringComparison.OrdinalIgnoreCase) && title.Contains("Zoom", StringComparison.OrdinalIgnoreCase))
                {
                    meetingWindowFound = true;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
        }
        catch { }

        return meetingWindowFound;
    }

    private static ChatSnapshot CaptureZoomChatSafe()
    {
        var snapshot = new ChatSnapshot
        {
            CapturedAt = DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz"),
            Limitations =
            [
                "No persistent message ID: Zoom Team Chat Chromium DOM does not expose database/server message IDs via UIA AutomationId. Deduplication relies on session UiaRuntimeId and content fingerprint.",
                "Virtualized DOM (_virtualList_): Only messages currently mounted in the scroll viewport buffer are readable without scrolling.",
                "Relative timestamps: Zoom displays relative strings ('Today', 'Wed', '16:25') rather than full ISO-8601 timestamps; original values are preserved without fabrication."
            ]
        };

        var zoomPids = Process.GetProcessesByName("Zoom").Select(p => (uint)p.Id).ToHashSet();
        if (zoomPids.Count == 0)
        {
            snapshot.Status = "zoom_not_running";
            snapshot.ErrorMessage = "Zoom uygulaması çalışmıyor.";
            return snapshot;
        }

        // Fast meeting check: If meeting is active or launching, gracefully suspend UIA inspection to avoid blocking Zoom
        if (IsMeetingActive(zoomPids))
        {
            snapshot.Status = "meeting_active";
            snapshot.ErrorMessage = "Zoom toplantısı veya görüşme aktif olduğundan okuyucu geçici olarak duraklatıldı.";
            return snapshot;
        }

        IntPtr mainHwnd = IntPtr.Zero;
        bool isVisible = false;
        bool isIconic = false;

        Win32Desktop.EnumWindows((hWnd, _) =>
        {
            Win32Desktop.GetWindowThreadProcessId(hWnd, out uint pid);
            if (!zoomPids.Contains(pid)) return true;

            var sb = new StringBuilder(256);
            Win32Desktop.GetClassName(hWnd, sb, 256);
            if (sb.ToString() == "ZPPTMainFrmWndClassEx")
            {
                bool vis = Win32Desktop.IsWindowVisible(hWnd);
                bool ico = Win32Desktop.IsIconic(hWnd);
                if (mainHwnd == IntPtr.Zero || (vis && !ico))
                {
                    mainHwnd = hWnd;
                    isVisible = vis;
                    isIconic = ico;
                }
                if (vis && !ico) return false;
            }
            return true;
        }, IntPtr.Zero);

        if (mainHwnd == IntPtr.Zero)
        {
            snapshot.Status = "window_minimized_or_hidden";
            snapshot.WindowState = "hidden";
            snapshot.ErrorMessage = "Açık Zoom ana penceresi (ZPPTMainFrmWndClassEx) bulunamadı.";
            return snapshot;
        }

        snapshot.WindowState = !isVisible ? "hidden" : (isIconic ? "minimized" : "normal");

        var rootEl = AutomationElement.FromHandle(mainHwnd);
        snapshot.WindowTitle = rootEl.Current.Name ?? "Zoom Workplace";

        var renderHwnds = new List<IntPtr>();
        Win32Desktop.EnumChildWindows(mainHwnd, (childHwnd, _) =>
        {
            var sb = new StringBuilder(256);
            Win32Desktop.GetClassName(childHwnd, sb, 256);
            if (sb.ToString() == "Chrome_RenderWidgetHostHWND")
                renderHwnds.Add(childHwnd);
            return true;
        }, IntPtr.Zero);

        AutomationElement? chatPanel = null;
        foreach (var rHwnd in renderHwnds)
        {
            try
            {
                var renderEl = AutomationElement.FromHandle(rHwnd);
                chatPanel = FindFirstByClassSubstring(renderEl, "_chatPanel_", 12);
                if (chatPanel != null) break;
            }
            catch { }
        }

        chatPanel ??= FindFirstByClassSubstring(rootEl, "_chatPanel_", 22);
        if (chatPanel == null)
        {
            if (!isVisible || isIconic)
            {
                snapshot.Status = "window_minimized_or_hidden";
                snapshot.ErrorMessage = "Zoom penceresi simge durumunda veya gizli olduğundan sohbet paneline erişilemedi.";
            }
            else
            {
                snapshot.Status = "chat_panel_not_open";
                snapshot.ErrorMessage = "Zoom açık ancak Team Chat sekmesi veya bir sohbet ekranı açık değil.";
            }
            return snapshot;
        }

        // 1. Read Chat Header (_header_)
        var headerEl = FindFirstByClassSubstring(chatPanel, "_header_", 6);
        if (headerEl != null)
        {
            string headerName = headerEl.Current.Name ?? "";
            var titleNode = FindFirstByClassSubstring(headerEl, "_title_", 6);
            if (titleNode != null)
            {
                snapshot.ChatName = CollectAllText(titleNode).Trim();
            }

            if (headerName.Contains(','))
            {
                int commaIdx = headerName.IndexOf(',');
                snapshot.ChatType = headerName[..commaIdx].Trim();
                if (string.IsNullOrEmpty(snapshot.ChatName))
                    snapshot.ChatName = headerName[(commaIdx + 1)..].Trim();
            }
            else if (string.IsNullOrEmpty(snapshot.ChatName) && !string.IsNullOrEmpty(headerName))
            {
                snapshot.ChatName = headerName;
            }
        }

        // 2. Read SessionId from link-break-hint
        var hintEl = FindFirstByIdPrefix(chatPanel, "link-break-hint-", 16);
        if (hintEl != null)
        {
            snapshot.SessionId = hintEl.Current.AutomationId["link-break-hint-".Length..];
        }

        // 3. Read Virtualized Message List (_virtualList_)
        var virtualList = FindFirstByClassSubstring(chatPanel, "_virtualList_", 12);
        if (virtualList == null)
        {
            snapshot.Status = "chat_panel_not_open";
            snapshot.ErrorMessage = "Sohbet mesaj listesi (_virtualList_) yüklü değil.";
            return snapshot;
        }

        var walker = TreeWalker.RawViewWalker;
        var child = walker.GetFirstChild(virtualList);

        string? currentDateGroup = null;
        string? lastHeaderSender = null;
        string? lastHeaderSenderResolved = null;
        string? lastHeaderTimestamp = null;
        bool lastIsSentByMe = false;

        int domIndex = 0;
        var occurrenceCounter = new Dictionary<string, int>(StringComparer.Ordinal);

        while (child != null)
        {
            string cls = child.Current.ClassName ?? "";

            if (cls.Contains("_dateIndicator_"))
            {
                string dateText = (child.Current.Name ?? "").Trim();
                if (string.IsNullOrEmpty(dateText))
                    dateText = CollectAllText(child).Trim();
                if (!string.IsNullOrEmpty(dateText))
                    currentDateGroup = dateText;
            }
            else if (cls.Contains("_message_"))
            {
                domIndex++;
                var msg = ParseMessageElement(
                    child,
                    domIndex,
                    currentDateGroup,
                    ref lastHeaderSender,
                    ref lastHeaderSenderResolved,
                    ref lastHeaderTimestamp,
                    ref lastIsSentByMe);

                string baseKey = $"{snapshot.ChatName}|{msg.DateGroup}|{msg.VisibleTimestamp}|{msg.Sender}|{msg.MessageType}|{msg.Text}|{msg.CallRecord?.StatusText}|{string.Join(",", msg.Links)}";
                occurrenceCounter.TryGetValue(baseKey, out int occ);
                occ++;
                occurrenceCounter[baseKey] = occ;
                msg.OccurrenceIndexInView = occ;
                msg.Fingerprint = ComputeSha256Hex($"{baseKey}|#{occ}")[..16];

                snapshot.Messages.Add(msg);
            }

            child = walker.GetNextSibling(child);
        }

        snapshot.Status = "ok";
        return snapshot;
    }

    private static ChatMessageItem ParseMessageElement(
        AutomationElement msgNode,
        int domIndex,
        string? currentDateGroup,
        ref string? lastHeaderSender,
        ref string? lastHeaderSenderResolved,
        ref string? lastHeaderTimestamp,
        ref bool lastIsSentByMe)
    {
        string cls = msgNode.Current.ClassName ?? "";
        bool isGroupedFollowUp = cls.Contains("undefined");
        bool isThreadReply = cls.Contains("_isReply_");
        bool isUnreadReply = cls.Contains("_unreadReply_");
        string runtimeId = string.Join(".", msgNode.GetRuntimeId());

        string? avatarOwner = null;
        string? headerSender = null;
        string? headerTime = null;
        string? accessibleLabel = null;
        bool isSentByMe = false;

        var links = new List<string>();
        string? callIconLabel = null;
        string? callStatusText = null;
        string? bodyText = null;

        var profileTrigger = FindFirstByClassSubstring(msgNode, "_profileTrigger_", 3);
        if (profileTrigger != null)
        {
            var img = FindFirstByControlType(profileTrigger, ControlType.Image, 4);
            if (img != null)
            {
                string imgName = img.Current.Name ?? "";
                const string suffix = "'s avatar";
                if (imgName.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                    avatarOwner = imgName[..^suffix.Length].Trim();
            }
        }

        var contentWrapper = FindFirstByClassSubstring(msgNode, "_contentWrapper_", 3);
        if (contentWrapper != null)
        {
            accessibleLabel = contentWrapper.Current.Name;

            var senderNode = FindFirstByClassSubstring(contentWrapper, "_senderBold_", 3);
            if (senderNode != null)
            {
                headerSender = CollectAllText(senderNode).Trim();
            }

            var timeContainer = FindFirstByClassSubstring(contentWrapper, "_headerSubtextContainer_", 3);
            if (timeContainer != null)
            {
                headerTime = ExtractHeaderTime(timeContainer);
            }

            var longContent = FindFirstByClassSubstring(contentWrapper, "_longMessageContent_", 6);
            if (longContent != null)
            {
                string lcClass = longContent.Current.ClassName ?? "";
                if (lcClass.Contains("_longMessageContentMine_"))
                    isSentByMe = true;

                var callLabelNode = FindFirstByClassSubstring(longContent, "_callLabel_", 4);
                if (callLabelNode != null)
                {
                    callStatusText = CollectAllText(callLabelNode).Trim();
                    var callImg = FindFirstByControlType(longContent, ControlType.Image, 3);
                    if (callImg != null)
                        callIconLabel = (callImg.Current.Name ?? "").Trim();
                }

                var textDetail = FindFirstByClassSubstring(longContent, "_textDetail_", 3);
                if (textDetail != null)
                {
                    if ((textDetail.Current.ClassName ?? "").Contains("_sentByMe_"))
                        isSentByMe = true;

                    var textDetailContent = FindFirstByClassSubstring(textDetail, "_textDetailContent_", 3) ?? textDetail;
                    var sbText = new StringBuilder();
                    ExtractBodyTextAndLinks(textDetailContent, sbText, links);
                    bodyText = sbText.ToString().Trim();
                }
            }
        }

        string? fallbackSender = null;
        string? fallbackTime = null;
        if (!string.IsNullOrEmpty(accessibleLabel))
        {
            ParseAccessibleLabelFallback(accessibleLabel, out fallbackSender, out fallbackTime);
        }

        string? finalSender = headerSender ?? fallbackSender ?? lastHeaderSender;
        string? finalSenderResolved = avatarOwner ?? (finalSender == lastHeaderSender ? lastHeaderSenderResolved : null) ?? finalSender;
        string? finalTime = headerTime ?? fallbackTime ?? lastHeaderTimestamp;

        if (!isSentByMe && string.Equals(finalSender, "You", StringComparison.OrdinalIgnoreCase))
            isSentByMe = true;
        else if (isGroupedFollowUp && headerSender == null && fallbackSender == null)
            isSentByMe = lastIsSentByMe;

        if (headerSender != null)
        {
            lastHeaderSender = headerSender;
            lastHeaderSenderResolved = avatarOwner ?? headerSender;
        }
        if (headerTime != null)
        {
            lastHeaderTimestamp = headerTime;
        }
        lastIsSentByMe = isSentByMe;

        var item = new ChatMessageItem
        {
            IndexInDom = domIndex,
            UiaRuntimeId = runtimeId,
            PersistentMessageId = null,
            IsGroupedFollowUp = isGroupedFollowUp,
            IsThreadReply = isThreadReply,
            IsUnreadReply = isUnreadReply,
            DateGroup = currentDateGroup,
            VisibleTimestamp = finalTime,
            Sender = finalSender,
            SenderResolved = finalSenderResolved,
            IsSentByMe = isSentByMe,
            MessageType = callStatusText != null ? "call" : "text",
            Text = bodyText,
            Links = links.Distinct(StringComparer.Ordinal).ToList(),
            RawAccessibleLabel = accessibleLabel
        };

        if (callStatusText != null)
        {
            string dir = "unknown";
            if ((callIconLabel != null && callIconLabel.Contains("Incoming", StringComparison.OrdinalIgnoreCase)) ||
                callStatusText.Contains("Incoming", StringComparison.OrdinalIgnoreCase))
            {
                dir = "incoming";
            }
            else if ((callIconLabel != null && callIconLabel.Contains("Outgoing", StringComparison.OrdinalIgnoreCase)) ||
                     callStatusText.Contains("Outgoing", StringComparison.OrdinalIgnoreCase))
            {
                dir = "outgoing";
            }

            item.CallRecord = new CallRecordInfo
            {
                Direction = dir,
                IconLabel = callIconLabel,
                StatusText = callStatusText
            };
        }

        return item;
    }

    private static string? ExtractHeaderTime(AutomationElement timeContainer)
    {
        var walker = TreeWalker.RawViewWalker;
        var child = walker.GetFirstChild(timeContainer);
        var parts = new List<string>();
        while (child != null)
        {
            string t = (child.Current.Name ?? "").Trim();
            if (t.Length > 0 && t != "（" && t != "）" && t != "(" && t != ")")
                parts.Add(t);
            child = walker.GetNextSibling(child);
        }
        return parts.Count > 0 ? string.Join(" ", parts) : null;
    }

    private static void ExtractBodyTextAndLinks(AutomationElement node, StringBuilder sbText, List<string> links)
    {
        var c = node.Current;
        if (c.ControlType == ControlType.Hyperlink)
        {
            string url = "";
            if (node.TryGetCurrentPattern(ValuePattern.Pattern, out object? vp))
            {
                try { url = ((ValuePattern)vp).Current.Value ?? ""; } catch { }
            }
            if (string.IsNullOrEmpty(url))
                url = c.Name ?? "";
            if (!string.IsNullOrEmpty(url))
                links.Add(url);

            string linkText = c.Name ?? url;
            if (!string.IsNullOrEmpty(linkText))
                sbText.Append(linkText);
            return;
        }

        if (c.ControlType == ControlType.Text)
        {
            string t = c.Name ?? "";
            if (!string.IsNullOrEmpty(t))
                sbText.Append(t);
            return;
        }

        var walker = TreeWalker.RawViewWalker;
        var child = walker.GetFirstChild(node);
        bool isBlock = (c.ClassName ?? "").Contains("zds-block-content");
        if (isBlock && sbText.Length > 0 && sbText[^1] != '\n')
            sbText.Append('\n');

        while (child != null)
        {
            ExtractBodyTextAndLinks(child, sbText, links);
            child = walker.GetNextSibling(child);
        }
    }

    public static void ParseAccessibleLabelFallback(string label, out string? sender, out string? timestamp)
    {
        sender = null;
        timestamp = null;

        const string suffix = ", Press TAB for more chat options";
        string working = label.EndsWith(suffix, StringComparison.Ordinal)
            ? label[..^suffix.Length]
            : label;

        int firstComma = working.IndexOf(',');
        if (firstComma > 0)
        {
            sender = working[..firstComma].Trim();
        }

        int lastComma = working.LastIndexOf(',');
        if (lastComma > firstComma && lastComma + 1 < working.Length)
        {
            string candidateTime = working[(lastComma + 1)..].Trim();
            if (Regex.IsMatch(candidateTime, @"(\d{1,2}:\d{2}|Yesterday|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun)", RegexOptions.IgnoreCase))
            {
                timestamp = candidateTime;
            }
        }
    }

    public static SnapshotComparison CompareSnapshots(ChatSnapshot prev, ChatSnapshot curr)
    {
        var prevRuntimeIds = prev.Messages
            .Where(m => !string.IsNullOrEmpty(m.UiaRuntimeId))
            .Select(m => m.UiaRuntimeId)
            .ToHashSet(StringComparer.Ordinal);

        var prevFingerprints = prev.Messages
            .Select(m => m.Fingerprint)
            .ToHashSet(StringComparer.Ordinal);

        int exactSame = 0;
        int probableSame = 0;
        var newlyVisible = new List<ChatMessageItem>();

        foreach (var msg in curr.Messages)
        {
            bool hasSameRuntimeId = !string.IsNullOrEmpty(msg.UiaRuntimeId) && prevRuntimeIds.Contains(msg.UiaRuntimeId);
            bool hasSameFingerprint = prevFingerprints.Contains(msg.Fingerprint);

            if (hasSameRuntimeId && hasSameFingerprint)
            {
                exactSame++;
                probableSame++;
            }
            else if (hasSameFingerprint)
            {
                probableSame++;
            }
            else
            {
                newlyVisible.Add(msg);
            }
        }

        return new SnapshotComparison
        {
            PreviousCapturedAt = prev.CapturedAt,
            PreviousTotalCount = prev.Messages.Count,
            CurrentTotalCount = curr.Messages.Count,
            ExactSameElementCount = exactSame,
            ProbableSameMessageCount = probableSame,
            NewlyVisibleCount = newlyVisible.Count,
            NewlyVisibleMessages = newlyVisible
        };
    }

    private static AutomationElement? FindFirstByClassSubstring(AutomationElement root, string substring, int maxDepth)
    {
        if (maxDepth < 0 || root == null) return null;
        string cls = root.Current.ClassName ?? "";
        if (cls.Contains(substring, StringComparison.Ordinal)) return root;
        if (maxDepth == 0) return null;

        var walker = TreeWalker.RawViewWalker;
        var child = walker.GetFirstChild(root);
        while (child != null)
        {
            var found = FindFirstByClassSubstring(child, substring, maxDepth - 1);
            if (found != null) return found;
            child = walker.GetNextSibling(child);
        }
        return null;
    }

    private static AutomationElement? FindFirstByIdPrefix(AutomationElement root, string prefix, int maxDepth)
    {
        if (maxDepth < 0 || root == null) return null;
        string aid = root.Current.AutomationId ?? "";
        if (aid.StartsWith(prefix, StringComparison.Ordinal)) return root;
        if (maxDepth == 0) return null;

        var walker = TreeWalker.RawViewWalker;
        var child = walker.GetFirstChild(root);
        while (child != null)
        {
            var found = FindFirstByIdPrefix(child, prefix, maxDepth - 1);
            if (found != null) return found;
            child = walker.GetNextSibling(child);
        }
        return null;
    }

    private static AutomationElement? FindFirstByControlType(AutomationElement root, ControlType controlType, int maxDepth)
    {
        if (maxDepth < 0 || root == null) return null;
        if (root.Current.ControlType == controlType) return root;
        if (maxDepth == 0) return null;

        var walker = TreeWalker.RawViewWalker;
        var child = walker.GetFirstChild(root);
        while (child != null)
        {
            var found = FindFirstByControlType(child, controlType, maxDepth - 1);
            if (found != null) return found;
            child = walker.GetNextSibling(child);
        }
        return null;
    }

    private static string CollectAllText(AutomationElement root)
    {
        var sb = new StringBuilder();
        CollectTextRecursive(root, sb);
        return sb.ToString();
    }

    private static void CollectTextRecursive(AutomationElement node, StringBuilder sb)
    {
        if (node == null) return;
        if (node.Current.ControlType == ControlType.Text)
        {
            sb.Append(node.Current.Name ?? "");
            return;
        }
        var walker = TreeWalker.RawViewWalker;
        var child = walker.GetFirstChild(node);
        while (child != null)
        {
            CollectTextRecursive(child, sb);
            child = walker.GetNextSibling(child);
        }
    }

    private static string ComputeSha256Hex(string input)
    {
        byte[] bytes = SHA256.HashData(Encoding.UTF8.GetBytes(input));
        return Convert.ToHexStringLower(bytes);
    }

    private static int RunSelfTest()
    {
        ParseAccessibleLabelFallback(
            "You, Available, https://32bitbilgisayar.atlassian.net/browse/BAM-4066, Wed 11:55, Press TAB for more chat options",
            out string? s1,
            out string? t1);
        Debug.Assert(s1 == "You", $"Expected 'You', got '{s1}'");
        Debug.Assert(t1 == "Wed 11:55", $"Expected 'Wed 11:55', got '{t1}'");

        var snapA = new ChatSnapshot
        {
            CapturedAt = "2026-10-16T17:00:00+03:00",
            Messages =
            [
                new ChatMessageItem { UiaRuntimeId = "42.1.100", Fingerprint = "aaa111", Text = "Selam" },
                new ChatMessageItem { UiaRuntimeId = "42.1.101", Fingerprint = "bbb222", Text = "Nasılsın" }
            ]
        };
        var snapB = new ChatSnapshot
        {
            CapturedAt = "2026-10-16T17:00:05+03:00",
            Messages =
            [
                new ChatMessageItem { UiaRuntimeId = "42.1.100", Fingerprint = "aaa111", Text = "Selam" },
                new ChatMessageItem { UiaRuntimeId = "42.1.999", Fingerprint = "bbb222", Text = "Nasılsın" },
                new ChatMessageItem { UiaRuntimeId = "42.1.102", Fingerprint = "ccc333", Text = "Yeni mesaj" }
            ]
        };

        var cmp = CompareSnapshots(snapA, snapB);
        Debug.Assert(cmp.ExactSameElementCount == 1, "ExactSameElementCount should be 1");
        Debug.Assert(cmp.ProbableSameMessageCount == 2, "ProbableSameMessageCount should be 2");
        Debug.Assert(cmp.NewlyVisibleCount == 1, "NewlyVisibleCount should be 1");
        Debug.Assert(cmp.NewlyVisibleMessages[0].Text == "Yeni mesaj", "New message text mismatch");

        Console.WriteLine("Self-test passed.");
        return 0;
    }
}
