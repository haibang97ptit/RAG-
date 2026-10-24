import { useState, useRef, useEffect } from "react";
import Markdown from "./Markdown";

interface Source {
  fileName: string;
  category: string;
  sheetName?: string;
  score: number;
}

type Rating = "up" | "down";

interface Message {
  role: "user" | "assistant";
  content: string;
  intent?: "NEW_QUESTION" | "FOLLOW_UP" | "CHITCHAT";
  sources?: Source[];
  answerId?: string; // backend cấp, dùng khi gửi 👍/👎
  rating?: Rating;
  commentSent?: boolean;
  attachments?: string[]; // tên file gửi kèm câu hỏi (chỉ để hiển thị)
}

// File tải lên để hỏi kèm (so sánh, tìm đoạn). Server chỉ giữ trong RAM, hết hạn sau một thời gian không dùng.
interface Attachment {
  localId: string;
  fileName: string;
  status: "uploading" | "ready" | "error";
  uploadId?: string;
  error?: string;
}

const UPLOAD_EXTENSIONS = [".docx", ".pdf", ".xlsx", ".xls", ".txt", ".md"];
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 2;

const BACKEND_URL =
  (import.meta as any).env?.VITE_BACKEND_URL || "http://localhost:8000";
const API_TOKEN = (import.meta as any).env?.VITE_API_TOKEN || "";
const SESSION_STORAGE_KEY = "sop_session_v2";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface StoredSession {
  messages: Message[];
  savedAt: number;
}

function loadSession(): Message[] {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredSession;
    if (Date.now() - parsed.savedAt > SESSION_TTL_MS) {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      return [];
    }
    return parsed.messages;
  } catch {
    return [];
  }
}

function saveSession(messages: Message[]) {
  try {
    const data: StoredSession = { messages, savedAt: Date.now() };
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(data));
  } catch {}
}

const authHeaders = (): Record<string, string> => ({
  "Content-Type": "application/json",
  ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
});

/** Upload 1 file → uploadId. Lỗi (sai định dạng, quá lớn, không đọc được chữ) → throw kèm thông báo của server. */
async function uploadFile(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file, file.name);
  const response = await fetch(`${BACKEND_URL}/upload`, {
    method: "POST",
    // Không đặt Content-Type: trình duyệt tự thêm boundary của multipart
    headers: API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {},
    body: form,
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 404) throw new Error("Server chưa có tính năng tải file (cần cập nhật server)");
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload.uploadId as string;
}

/** Gửi 👍/👎 (kèm góp ý nếu có). Lỗi mạng thì bỏ qua: phản hồi không quan trọng bằng việc hỏi đáp. */
async function sendFeedback(answerId: string, rating: Rating, comment?: string) {
  try {
    await fetch(`${BACKEND_URL}/feedback`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ answerId, rating, ...(comment ? { comment } : {}) }),
    });
  } catch (err) {
    console.warn("Gửi phản hồi lỗi:", err);
  }
}

function FeedbackBar({
  message,
  onRate,
  onComment,
}: {
  message: Message;
  onRate: (rating: Rating) => void;
  onComment: (comment: string) => void;
}) {
  const [comment, setComment] = useState("");
  const [skipped, setSkipped] = useState(false);
  const askComment = message.rating === "down" && !message.commentSent && !skipped;

  return (
    <div className="feedback">
      <div className="feedback-buttons">
        <span className="feedback-label">Câu trả lời có đúng không?</span>
        <button
          className={`btn-rate${message.rating === "up" ? " active" : ""}`}
          onClick={() => onRate("up")}
          title="Đúng, hữu ích"
        >
          👍
        </button>
        <button
          className={`btn-rate${message.rating === "down" ? " active" : ""}`}
          onClick={() => onRate("down")}
          title="Sai hoặc chưa đủ"
        >
          👎
        </button>
        {message.rating && !askComment && <span className="feedback-thanks">Cảm ơn bạn đã góp ý</span>}
      </div>
      {askComment && (
        <div className="feedback-comment">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Sai ở đâu, hoặc câu trả lời đúng là gì? (không bắt buộc)"
            rows={2}
            maxLength={1000}
          />
          <div className="feedback-actions">
            <button className="btn-skip" onClick={() => setSkipped(true)}>
              Bỏ qua
            </button>
            <button className="btn-send-comment" onClick={() => onComment(comment.trim())} disabled={!comment.trim()}>
              Gửi góp ý
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function IntentBadge({ intent }: { intent?: Message["intent"] }) {
  if (!intent) return null;
  const label =
    intent === "NEW_QUESTION"
      ? "Câu hỏi mới"
      : intent === "FOLLOW_UP"
      ? "Tiếp nối"
      : "Trò chuyện";
  const cls =
    intent === "NEW_QUESTION"
      ? "badge badge-new"
      : intent === "FOLLOW_UP"
      ? "badge badge-follow"
      : "badge badge-chat";
  return <span className={cls}>{label}</span>;
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>(() => loadSession());
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const uploading = attachments.some((a) => a.status === "uploading");

  function patchAttachment(localId: string, patch: Partial<Attachment>) {
    setAttachments((prev) => prev.map((a) => (a.localId === localId ? { ...a, ...patch } : a)));
  }

  function addFiles(files: File[]) {
    const room = MAX_ATTACHMENTS - attachments.length;
    for (const file of files.slice(0, Math.max(0, room))) {
      const localId = `${Date.now()}-${Math.random()}`;
      const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
      const error = !UPLOAD_EXTENSIONS.includes(ext)
        ? `Chưa hỗ trợ ${ext}`
        : file.size > UPLOAD_MAX_BYTES
          ? "Quá 20 MB"
          : undefined;
      setAttachments((prev) => [...prev, { localId, fileName: file.name, status: error ? "error" : "uploading", error }]);
      if (error) continue;
      uploadFile(file)
        .then((uploadId) => patchAttachment(localId, { status: "ready", uploadId }))
        .catch((err) => patchAttachment(localId, { status: "error", error: (err as Error).message }));
    }
  }

  function removeAttachment(localId: string) {
    setAttachments((prev) => prev.filter((a) => a.localId !== localId));
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  }

  useEffect(() => {
    saveSession(messages);
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || loading || uploading) return;

    // File vẫn giữ sau khi gửi: các câu hỏi tiếp theo cũng hỏi kèm file đó, tới khi người dùng bỏ thẻ file
    const ready = attachments.filter((a) => a.status === "ready" && a.uploadId);
    const userMsg: Message = {
      role: "user",
      content: text,
      ...(ready.length > 0 ? { attachments: ready.map((a) => a.fileName) } : {}),
    };
    const history = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    setMessages((prev) => [
      ...prev,
      userMsg,
      { role: "assistant", content: "", sources: [] },
    ]);
    setInput("");
    setLoading(true);

    abortRef.current = new AbortController();

    try {
      const response = await fetch(`${BACKEND_URL}/query/stream`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          query: text,
          history,
          ...(ready.length > 0 ? { attachments: ready.map((a) => a.uploadId) } : {}),
        }),
        signal: abortRef.current.signal,
      });

      if (response.status === 401) {
        throw new Error("Server từ chối truy cập (401) - cần cập nhật app bản mới");
      }
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          const lines = part.split("\n");
          let event = "message";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!data) continue;

          try {
            const payload = JSON.parse(data);

            if (event === "intent") {
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === "assistant") {
                  last.intent = payload.intent;
                }
                return next;
              });
            } else if (event === "done") {
              // Nguồn chỉ hiện sau khi trả lời xong: backend gửi danh sách file mà câu trả lời
              // thật sự dùng (rỗng nếu trò chuyện / không tìm thấy thông tin)
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === "assistant") {
                  last.sources = payload.sources || [];
                  last.answerId = payload.answerId;
                }
                return next;
              });
              // Server đã xoá file (hết hạn / khởi động lại): bỏ thẻ file, người dùng tải lại
              if (payload.uploadExpired) setAttachments([]);
            } else if (event === "chunk") {
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === "assistant") {
                  last.content += payload.delta;
                }
                return next;
              });
            } else if (event === "error") {
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === "assistant") {
                  last.content += `\n\n[Lỗi: ${payload.message}]`;
                }
                return next;
              });
            }
          } catch (e) {
            console.warn("Parse SSE lỗi:", e);
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            last.content = `[Lỗi kết nối: ${(err as Error).message}]`;
          }
          return next;
        });
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  function updateMessage(index: number, patch: Partial<Message>) {
    setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  }

  function rate(index: number, rating: Rating) {
    const message = messages[index];
    if (!message.answerId) return;
    updateMessage(index, { rating, commentSent: false });
    void sendFeedback(message.answerId, rating);
  }

  function comment(index: number, text: string) {
    const message = messages[index];
    if (!message.answerId || !message.rating) return;
    updateMessage(index, { commentSent: true });
    void sendFeedback(message.answerId, message.rating, text);
  }

  function clearChat() {
    setMessages([]);
    setAttachments([]);
    localStorage.removeItem(SESSION_STORAGE_KEY);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div
      className={`app${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {dragging && <div className="drop-hint">Thả file vào đây để hỏi kèm (Word, PDF, Excel, txt)</div>}
      <header className="header">
        <div className="header-title">
          <span className="logo">●</span>
          <span>SOP AI Assistant</span>
        </div>
        <button className="btn-clear" onClick={clearChat} title="Xóa hội thoại">
          Xóa chat
        </button>
      </header>

      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="empty">
            <div className="empty-title">Xin chào!</div>
            <div className="empty-sub">
              Hỏi về quy trình, chính sách, SOP của công ty.
            </div>
            <div className="empty-examples">
              <div>• "Quy trình xin nghỉ phép?"</div>
              <div>• "Thiết bị nào cần đồng bộ thời gian?"</div>
              <div>• "Chính sách bảo mật password?"</div>
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            <div className="msg-head">
              <span className="msg-role">
                {m.role === "user" ? "Bạn" : "Trợ lý"}
              </span>
              {m.role === "assistant" && <IntentBadge intent={m.intent} />}
            </div>
            <div className="msg-body">
              {!m.content ? (
                <span className="typing">
                  <span /> <span /> <span />
                </span>
              ) : m.role === "assistant" ? (
                <Markdown content={m.content} />
              ) : (
                m.content
              )}
            </div>
            {m.role === "user" && m.attachments && m.attachments.length > 0 && (
              <div className="msg-files">
                {m.attachments.map((name, j) => (
                  <span key={j} className="file-chip">📄 {name}</span>
                ))}
              </div>
            )}
            {m.role === "assistant" && m.sources && m.sources.length > 0 && (
              <div className="sources">
                <div className="sources-title">Nguồn tham khảo:</div>
                <ul>
                  {m.sources.map((s, j) => (
                    <li key={j}>
                      <span className="src-file">{s.fileName}</span>
                      {s.sheetName && (
                        <span className="src-sheet"> › {s.sheetName}</span>
                      )}
                      <span className="src-cat"> ({s.category})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {m.role === "assistant" && m.answerId && !(loading && i === messages.length - 1) && (
              <FeedbackBar
                message={m}
                onRate={(rating) => rate(i, rating)}
                onComment={(text) => comment(i, text)}
              />
            )}
          </div>
        ))}
      </div>

      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((a) => (
            <span key={a.localId} className={`file-chip file-${a.status}`} title={a.error || a.fileName}>
              {a.status === "uploading" ? "⏳" : a.status === "error" ? "⚠️" : "📄"} {a.fileName}
              {a.error && <span className="file-error"> - {a.error}</span>}
              <button className="file-remove" onClick={() => removeAttachment(a.localId)} title="Bỏ file">
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="composer">
        <input
          ref={fileInputRef}
          type="file"
          accept={UPLOAD_EXTENSIONS.join(",")}
          multiple
          hidden
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = ""; // chọn lại cùng file vẫn nhận
          }}
        />
        <button
          className="btn-attach"
          onClick={() => fileInputRef.current?.click()}
          disabled={loading || attachments.length >= MAX_ATTACHMENTS}
          title="Tải file lên để so sánh, tìm đoạn (tối đa 2 file, 20 MB)"
        >
          📎
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            attachments.length > 0
              ? 'Hỏi về file... vd "so sánh với SOP hiện hành", "chỗ nào nói về..."'
              : "Nhập câu hỏi... (Enter để gửi, Shift+Enter xuống dòng)"
          }
          rows={2}
          disabled={loading}
        />
        <button
          className="btn-send"
          onClick={send}
          disabled={loading || uploading || !input.trim()}
        >
          {loading ? "Đang gửi..." : uploading ? "Đang tải file..." : "Gửi"}
        </button>
      </div>
    </div>
  );
}
