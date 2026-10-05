#!/usr/bin/env bash
# Sync từ SMB mount → local disk. Chạy định kỳ qua cronjob.

set -euo pipefail

SOURCE="${SOP_SMB_MOUNT:-/mnt/sop-shared}"
TARGET="${SOP_LOCAL_DATA:-/opt/sop-local-data}"
LOG_PREFIX="[sync-sop]"

if [[ ! -d "$SOURCE" ]]; then
    echo "$LOG_PREFIX ❌ Source $SOURCE không tồn tại hoặc chưa mount."
    exit 1
fi

if ! mountpoint -q "$SOURCE"; then
    echo "$LOG_PREFIX ⚠️  $SOURCE không phải mount point. Thử: sudo mount -a"
    exit 1
fi

mkdir -p "$TARGET"

echo "$LOG_PREFIX $(date -Iseconds) Bắt đầu sync $SOURCE → $TARGET"

rsync -av --delete \
    --include='*/' \
    --include='*.pdf' --include='*.docx' --include='*.doc' \
    --include='*.xlsx' --include='*.xls' \
    --include='*.txt' --include='*.md' \
    --exclude='.DS_Store' --exclude='Thumbs.db' --exclude='~$*' \
    --exclude='*' \
    "$SOURCE/" "$TARGET/" \
    --log-file=/var/log/sop-rsync.log

# Đảm bảo container (uid 1001) đọc được
chown -R 1001:1001 "$TARGET" 2>/dev/null || true

TOTAL_FILES=$(find "$TARGET" -type f \( -name "*.pdf" -o -name "*.docx" -o -name "*.xlsx" -o -name "*.txt" -o -name "*.md" \) | wc -l)
TOTAL_SIZE=$(du -sh "$TARGET" | cut -f1)

echo "$LOG_PREFIX ✓ Hoàn tất. Files: $TOTAL_FILES | Size: $TOTAL_SIZE"
