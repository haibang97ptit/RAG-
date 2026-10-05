import { useState, useRef, useEffect } from "react";

interface Source {
  fileName: string;
  category: string;
  sheetName?: string;
  score: number;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  intent?: "NEW_QUESTION" | "FOLLOW_UP" | "CHITCHAT";
  sources?: Source[];
}

const BACKEND_URL =
  (import.meta as any).env?.VITE_BACKEND_URL || "http://localhost:8000";
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

  useEffect(() => {
    saveSession(messages);
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = { role: "user", content: text };
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: text, history }),
        signal: abortRef.current.signal,
      });

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
            } else if (event === "sources") {
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === "assistant") {
                  last.sources = payload.sources || [];
                }
                return next;
              });
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

  function clearChat() {
    setMessages([]);
    localStorage.removeItem(SESSION_STORAGE_KEY);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // Dedupe sources theo fileName
  function dedupeSources(sources: Source[]): Source[] {
    const seen = new Set<string>();
    const out: Source[] = [];
    for (const s of sources) {
      const key = `${s.fileName}::${s.sheetName || ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(s);
      }
    }
    return out;
  }

  return (
    <div className="app">
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
              {m.content || (
                <span className="typing">
                  <span /> <span /> <span />
                </span>
              )}
            </div>
            {m.role === "assistant" && m.sources && m.sources.length > 0 && (
              <div className="sources">
                <div className="sources-title">Nguồn tham khảo:</div>
                <ul>
                  {dedupeSources(m.sources).map((s, j) => (
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
          </div>
        ))}
      </div>

      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Nhập câu hỏi... (Enter để gửi, Shift+Enter xuống dòng)"
          rows={2}
          disabled={loading}
        />
        <button
          className="btn-send"
          onClick={send}
          disabled={loading || !input.trim()}
        >
          {loading ? "Đang gửi..." : "Gửi"}
        </button>
      </div>
    </div>
  );
}
