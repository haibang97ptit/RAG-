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
curl -fsS http://localhost:8000/stats | head -c 500 && echo ""

echo ""
echo "✅ Deploy xong. Nếu đây là lần đầu, chạy ingest:"
echo "   docker compose -f $COMPOSE_FILE --env-file $ENV_FILE exec backend npm run ingest:reset"
