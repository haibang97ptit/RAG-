#!/usr/bin/env bash
# Deploy / Update stack trên Linux server.
# Usage: bash scripts/deploy-server.sh

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env.prod}"
COMPOSE_FILE="docker-compose.prod.yml"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "❌ Thiếu file $ENV_FILE. Copy từ backend/.env.example và chỉnh."
    exit 1
fi

echo "🔄 Git pull..."
git pull

echo ""
echo "⬇️  Docker pull image mới nhất..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" pull

echo ""
echo "🚀 Khởi động stack..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d

echo ""
echo "⏳ Chờ 15s cho backend sẵn sàng..."
sleep 15

echo ""
echo "🩺 Health check..."
if curl -fsS http://localhost:8000/health; then
    echo ""
    echo "✅ Backend đang chạy."
else
    echo "❌ Backend chưa trả về health. Xem log:"
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs --tail=50 backend
    exit 1
fi

echo ""
echo "📊 Stats:"
# /stats cần ADMIN_TOKEN (hoặc API_TOKEN nếu không đặt ADMIN_TOKEN)
env_value() { grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d '\r"' || true; }
STATS_TOKEN="$(env_value ADMIN_TOKEN)"
[[ -z "$STATS_TOKEN" ]] && STATS_TOKEN="$(env_value API_TOKEN)"
curl -fsS -H "Authorization: Bearer $STATS_TOKEN" http://localhost:8000/stats | head -c 500 \
    || echo "⚠️  Không lấy được /stats (không ảnh hưởng deploy)"
echo ""

echo ""
echo "✅ Deploy xong. Nếu đây là lần đầu, chạy ingest:"
echo "   docker compose -f $COMPOSE_FILE --env-file $ENV_FILE exec backend npm run ingest:incremental"
