# Deploy lên Linux server

Hướng dẫn deploy production trên 1 Linux server (Ubuntu 22.04 LTS khuyên dùng, 16GB RAM).

## Yêu cầu server

- CPU: 4-8 cores
- RAM: 16GB (embed model ~2GB, Qdrant ~1-2GB, Node ~500MB)
- Disk: 50GB (cache model, Qdrant storage, local copy data)
- OS: Ubuntu 22.04 / Debian 12 / Rocky 9
- Access: `sudo` + có thể mount SMB

## Bước 1: Cài Docker

```bash
curl -fsSL https://get.docker.com | sudo bash
sudo usermod -aG docker $USER
# logout + login lại
```

Kiểm tra:
```bash
docker version
docker compose version
```

## Bước 2: Login GHCR để pull image private

Nếu repo GitHub để **public** → không cần login, chuyển sang bước 3.

Nếu repo **private**, cần Personal Access Token (classic) có scope `read:packages`:

```bash
echo "YOUR_GHCR_PAT" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

## Bước 3: Clone repo & chuẩn bị env

```bash
cd /opt
sudo git clone https://github.com/<OWNER>/<REPO>.git sop-ai
sudo chown -R $USER:$USER /opt/sop-ai
cd /opt/sop-ai

cp backend/.env.example .env.prod
nano .env.prod
```

Điền tối thiểu:
```bash
GITHUB_OWNER=your-github-user
GITHUB_REPO=sop-ai
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxx
API_TOKEN=            # openssl rand -hex 32 — bảo vệ /query, /query/stream
ADMIN_TOKEN=          # openssl rand -hex 32 — bảo vệ /stats
```

`API_TOKEN` phải trùng với secret `API_TOKEN` dùng khi build desktop app (xem
[Auth](#auth)). Để trống thì backend **không** kiểm tra token cho `/query*`.

Lưu ý: `CHUNK_SIZE`, `CHUNK_OVERLAP`, `DATA_DIR`... trong `.env.prod` không có tác dụng
trên server — các giá trị đó được đặt cứng trong `docker-compose.prod.yml`.

## Bước 4: Mount SMB share + sync data

Xem chi tiết: [MOUNT-SMB.md](MOUNT-SMB.md).

Tóm tắt:
```bash
sudo apt-get install -y cifs-utils rsync
sudo bash scripts/setup-mount.sh  # mount //fileserver/sop vào /mnt/sop-shared
sudo mkdir -p /opt/sop-local-data
sudo bash scripts/sync-shared-folder.sh  # rsync /mnt/sop-shared → /opt/sop-local-data
```

Setup cronjob đồng bộ mỗi 30 phút:
```bash
crontab -e
# Thêm dòng:
*/30 * * * * /opt/sop-ai/scripts/sync-shared-folder.sh >> /var/log/sop-sync.log 2>&1
```

## Bước 5: Khởi động stack

```bash
cd /opt/sop-ai

# Pull image mới nhất
docker compose -f docker-compose.prod.yml --env-file .env.prod pull

# Up
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d

# Kiểm tra
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f backend
```

## Bước 6: Lần đầu index

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec backend \
  npm run ingest:incremental
```

Dùng `ingest:incremental` cả cho lần đầu: collection trống thì nó index toàn bộ và ghi
manifest, các lần sau chỉ xử lý file mới/đổi/xóa. (`ingest:reset` xóa sạch collection
trước khi index — bot không có dữ liệu trong lúc chạy — và không ghi manifest.)

Manifest nằm trên volume `backend_state` (`/app/state`), mỗi collection một file.

**Chốt an toàn khi xóa:** incremental sẽ dừng (exit 1, không xóa gì) nếu thư mục data
không có file nào, hoặc nếu số file cần gỡ khỏi vector DB ≥ 20 và vượt 30% số file đã
index — thường là dấu hiệu SMB chưa mount / rsync lỗi. Nếu việc xóa là có chủ đích
(vd dọn cả một thư mục phòng ban), chạy lại với `--force`:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec backend \
  npm run ingest:incremental -- --force
```

File không đọc được (hỏng, đang bị khóa) sẽ báo ❌ trong log và được thử lại ở lần chạy
sau. File không có text (PDF scan) bị bỏ qua kèm cảnh báo.

Setup cronjob re-index mỗi 2h sau khi sync:
```bash
crontab -e
# Thêm:
15 */2 * * * cd /opt/sop-ai && docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T backend npm run ingest:incremental >> /var/log/sop-ingest.log 2>&1
```

## Bước 7: Firewall / network

Backend lắng nghe `0.0.0.0:8000`. Cho phép mạng nội bộ truy cập:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 8000
sudo ufw reload
```

Tauri desktop app ở máy user sẽ gọi: `http://<server-ip>:8000`.

### Auth

- `/health`: luôn mở (Docker healthcheck).
- `/query`, `/query/stream`: cần header `Authorization: Bearer <API_TOKEN>`.
- `/stats`: cần `ADMIN_TOKEN` (nếu không đặt `ADMIN_TOKEN` thì dùng `API_TOKEN`).

Desktop app gửi token lấy từ `VITE_API_TOKEN` lúc build. Workflow **Build Desktop App**
đọc giá trị này từ repo secret `API_TOKEN` (Settings → Secrets and variables → Actions).
Token nằm trong bản cài nên chỉ chặn được người ngoài không có app, không phân biệt
từng user.

Đổi token = build + phát lại MSI **trước**, đổi `API_TOKEN` trên server **sau**.

Kết nối là HTTP thường nên token và nội dung đi dạng không mã hóa trong mạng nội bộ.
Muốn mã hóa thì đặt reverse proxy có TLS (Caddy/nginx) trước port 8000.

## Bước 8: Auto-restart & update

Image có `restart: unless-stopped` nên docker tự khởi động lại.

Update khi có bản mới trên GHCR:
```bash
cd /opt/sop-ai
git pull
docker compose -f docker-compose.prod.yml --env-file .env.prod pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

Hoặc dùng script sẵn:
```bash
bash scripts/deploy-server.sh
```

Chờ workflow **Build & Push Backend Image** chạy xong rồi mới deploy, để compose mới
không chạy với image cũ.

### Rollback

Mỗi lần build, image có thêm tag `sha-<7 ký tự commit>`. Trước khi update, ghi lại bản
đang chạy:

```bash
docker inspect sop-backend --format '{{.Config.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
```

Để quay lại, thêm vào `.env.prod` rồi `up -d`:
```bash
IMAGE_TAG=sha-xxxxxxx
```

## Index lại toàn bộ không gián đoạn (đổi chunk size, đổi cách đọc file)

Chunk size, cách đọc Excel... chỉ áp dụng cho file được index sau khi đổi. Để áp dụng
cho toàn bộ mà bot vẫn trả lời bình thường: index vào collection mới, xong mới chuyển.

```bash
cd /opt/sop-ai
DC="docker compose -f docker-compose.prod.yml --env-file .env.prod"

# 1. Tạm tắt cronjob ingest (crontab -e, comment dòng ingest:incremental)

# 2. Index vào collection mới. Bản đang chạy vẫn phục vụ từ collection cũ.
#    Chạy trong tmux/screen - embed bằng CPU có thể mất vài giờ.
$DC exec -e COLLECTION_NAME=sop_documents_v2 backend npm run ingest:incremental

# 3. So số chunk / kiểm tra log không còn ❌
curl -s http://localhost:6333/collections/sop_documents_v2 | grep -o '"points_count":[0-9]*'

# 4. Chuyển: thêm COLLECTION_NAME=sop_documents_v2 vào .env.prod rồi
$DC up -d          # backend khởi động lại ~30-60s (load embedding model)

# 5. Bật lại cronjob. Manifest của collection mới đã có sẵn từ bước 2.

# 6. Khi đã ổn (vài ngày), xóa collection cũ
curl -X DELETE http://localhost:6333/collections/sop_documents
```

Quay lại collection cũ: đổi `COLLECTION_NAME` về giá trị cũ rồi `$DC up -d`.

## Bật tìm kiếm theo từ khóa + tên mục (cần index lại một lần)

Từ bản có `sparseVector.ts`, mỗi đoạn được lưu kèm tên tài liệu, tên mục và vector từ khóa
(tìm đúng hơn với mã số, tên thiết bị: "F17", "HPLC-05", "SOP 5" ↔ "0005"). Collection có sẵn
không thêm được loại vector này, nên bot vẫn chạy kiểu cũ (chỉ tìm theo nghĩa) cho tới khi
index sang collection MỚI theo đúng mục trên, với một tên chưa dùng bao giờ, vd:

```bash
$DC exec -e COLLECTION_NAME=sop_documents_v3 backend npm run ingest:incremental
```

Log khởi động backend sẽ ghi "Created collection ... (tìm theo nghĩa + từ khóa)" khi tạo collection mới.

## Học từ câu hỏi thật

**Phản hồi người dùng.** Mỗi câu hỏi (kèm cách bot hiểu, câu trả lời) và mỗi lần bấm 👍/👎 được
ghi vào `/app/state/logs/*.jsonl` (volume `backend_state`). Xem báo cáo:

```bash
$DC exec backend npm run feedback:report          # 30 ngày; thêm "-- 7" cho 7 ngày
$DC exec backend cat /app/state/feedback-report.md
```

Báo cáo liệt kê câu bị 👎, góp ý của người dùng, bot đã hiểu câu đó thế nào, và có sẵn mẫu để
thêm vào `backend/src/knowledge/router-examples.json` (sửa "route" cho đúng trước khi thêm).

**Bộ ví dụ cho bước hiểu câu hỏi:** `backend/src/knowledge/router-examples.json`. Mỗi câu hỏi,
bot chọn 6 ví dụ giống nhất đưa cho model làm mẫu. Thêm ví dụ từ các câu bị hiểu sai, rồi đo:

```bash
cd backend && npm run eval:router     # trên máy dev, dùng GROQ_API_KEY trong backend/.env
```

**Bảng thuật ngữ:** mặc định ở `backend/src/knowledge/glossary.csv`. QA có thể tự bổ sung bằng
file `glossary.xlsx` (hoặc `glossary.csv`) ở THƯ MỤC GỐC của thư mục tài liệu chung: cột 1 là các
cách gọi cách nhau bằng `|`, cột 2 là giải thích. File được đồng bộ cùng tài liệu và bot tự đọc lại
khi file đổi, không cần deploy. Giải thích bắt đầu bằng "Phòng ban:" thì chỉ dùng để nhận diện
phòng ban.

## Nâng cấp từ bản chưa có auth / chunk 3000

Thứ tự này để user đang dùng app bản cũ không bị gián đoạn:

1. **Tắt cronjob ingest**, ghi lại image đang chạy (mục Rollback).
2. **Deploy backend mới, chưa đặt `API_TOKEN`** (`bash scripts/deploy-server.sh`).
   App bản cũ vẫn dùng được. Từ lúc này `/stats` cần `ADMIN_TOKEN` nếu biến đó đã có
   trong `.env.prod`.
3. **Index lại vào collection mới rồi chuyển** (mục trên).
4. **Bật lại cronjob ingest.**
5. Tạo token (`openssl rand -hex 32`), lưu thành repo secret `API_TOKEN`, chạy workflow
   **Build Desktop App**, phát MSI mới cho user.
6. Khi mọi máy đã cài bản mới: thêm `API_TOKEN=<token>` vào `.env.prod`, `up -d`.
   Máy nào còn bản cũ sẽ báo "Lỗi kết nối: HTTP 401".

## Monitoring

Health check:
```bash
curl http://localhost:8000/health
curl http://localhost:8000/stats
```

Xem log:
```bash
docker compose -f docker-compose.prod.yml logs -f --tail=100 backend
```

Dung lượng:
```bash
docker system df
du -sh /opt/sop-local-data /var/lib/docker/volumes/*qdrant*
```
