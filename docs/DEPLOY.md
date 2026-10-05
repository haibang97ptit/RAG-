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
ADMIN_TOKEN=generate-a-strong-random-token
```

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
  npm run ingest:reset
```

Hoặc dùng incremental (lần sau):
```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec backend \
  npm run ingest:incremental
```

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
