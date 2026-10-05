# SOP AI Assistant

Hệ thống AI nội bộ hỏi đáp tài liệu SOP công ty (RAG). Tech stack: Node.js + TypeScript + Fastify + Qdrant + Groq LLM + Tauri desktop app.

## Kiến trúc

```
┌──────────────┐    HTTPS/SSE    ┌──────────────┐
│ Tauri Desktop│ ◄─────────────► │ Fastify API  │
│  (System Tray)│                 │   :8000      │
└──────────────┘                 └──────┬───────┘
                                        │
                              ┌─────────┴─────────┐
                              │                   │
                        ┌─────▼─────┐       ┌─────▼─────┐
                        │  Qdrant   │       │ Groq LLM  │
                        │  :6333    │       │  Cloud    │
                        └───────────┘       └───────────┘
                              ▲
                              │
                        ┌─────┴─────┐
                        │  Ingest   │
                        │ (SMB sync)│
                        └───────────┘
```

## Tính năng

- RAG tiếng Việt (embed model `multilingual-e5-base`)
- Table-aware chunking (preserve markdown tables từ Word/Excel)
- Intent router (NEW_QUESTION / FOLLOW_UP / CHITCHAT) → tiết kiệm token
- LLM-based reranker (search top-20 → rerank → top-10)
- Conversation memory 24h client-side, gửi 10 turn gần nhất cho LLM
- Strict attribution: không mix dữ liệu giữa file, luôn trích nguồn
- Incremental index: chỉ re-index file mới/thay đổi
- Desktop app: system tray, popup click, auto-hide on blur, 24h session

## Chạy local (dev)

### 1. Qdrant

```bash
docker compose up -d qdrant
```

### 2. Backend

```bash
cd backend
cp .env.example .env   # điền GROQ_API_KEY
npm install
npm run ingest:reset   # lần đầu
npm run dev
```

### 3. Desktop app

```bash
cd desktop
cp .env.example .env
npm install
npm run tauri:dev
```

Icon xuất hiện ở system tray → click để mở popup.

## Deploy production

Xem [docs/DEPLOY.md](docs/DEPLOY.md) và [docs/MOUNT-SMB.md](docs/MOUNT-SMB.md).

Tóm tắt:
1. GitHub Actions tự build Docker image → push lên GHCR
2. Linux server pull image → `docker compose -f docker-compose.prod.yml up -d`
3. Mount SMB share công ty + rsync sang local disk của server
4. Cronjob chạy `npm run ingest:incremental` mỗi N giờ
5. IT cài Tauri desktop app lên máy user (file `.msi` build từ GitHub Actions release)

## Cấu trúc repo

```
.
├── backend/              # Node.js + Fastify API
│   ├── src/
│   │   ├── config.ts
│   │   ├── embedding.ts
│   │   ├── chunker.ts
│   │   ├── fileReaders.ts
│   │   ├── qdrantService.ts
│   │   ├── llmService.ts
│   │   ├── server.ts
│   │   ├── ingest.ts
│   │   └── incrementalIngest.ts
│   ├── Dockerfile
│   └── package.json
├── desktop/              # Tauri + React desktop app
│   ├── src/              # React UI
│   ├── src-tauri/        # Rust (system tray, window)
│   └── package.json
├── data/                 # Local SOP data (gitignored!)
├── scripts/              # Deploy helpers
├── docs/                 # Deploy guides
├── .github/workflows/    # CI/CD
├── docker-compose.yml    # Dev
└── docker-compose.prod.yml
```

## Mô hình LLM & chi phí

- Embedding: local, free (~90MB model, chạy CPU ok)
- LLM chính: `openai/gpt-oss-120b` (Groq) - trả lời user
- LLM router: `openai/gpt-oss-20b` (Groq) - classify intent + rerank

Ước tính: 100 user × 50 query/ngày × ~2000 token = ~10M token/ngày. Groq free tier hiện cover tốt pilot 5-10 user; scale 100 user cần theo dõi rate limit.

## License & attribution

Internal use only. Không public dữ liệu SOP công ty.
