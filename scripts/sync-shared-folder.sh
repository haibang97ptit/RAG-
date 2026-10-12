#!/usr/bin/env bash
# Sync từ SMB mount → local disk. Chạy định kỳ qua cronjob.

set -euo pipefail

# Chỉ sync thư mục con AI của SMB share (mount tại /mnt/sop-shared).
# Đổi qua biến môi trường SOP_SMB_MOUNT nếu cần sync thư mục khác.
SOURCE="${SOP_SMB_MOUNT:-/mnt/sop-shared/AI}"
TARGET="${SOP_LOCAL_DATA:-/opt/sop-local-data}"
LOG_PREFIX="[sync-sop]"

if [[ ! -d "$SOURCE" ]]; then
    echo "$LOG_PREFIX ❌ Source $SOURCE không tồn tại hoặc chưa mount."
    exit 1
fi

# SOURCE có thể là mount point hoặc thư mục con của nó. Nếu filesystem chứa SOURCE
# là "/" thì share chưa được mount → dừng, không để rsync --delete xóa sạch TARGET.
MOUNT_OF_SOURCE="$(findmnt -n -o TARGET -T "$SOURCE" 2>/dev/null || true)"
if [[ -z "$MOUNT_OF_SOURCE" || "$MOUNT_OF_SOURCE" == "/" ]]; then
    echo "$LOG_PREFIX ⚠️  $SOURCE không nằm trên SMB mount. Thử: sudo mount -a"
    exit 1
fi

mkdir -p "$TARGET"

echo "$LOG_PREFIX $(date -Iseconds) Bắt đầu sync $SOURCE → $TARGET"

# rsync áp dụng rule ĐẦU TIÊN khớp, nên exclude file khóa tạm của Office (~$xxx.docx)
# phải đứng trước include '*.docx'. --delete-excluded để dọn các file đó đã lỡ sync trước đây.
rsync -av --delete --delete-excluded \
    --exclude='.DS_Store' --exclude='Thumbs.db' --exclude='~$*' \
    --include='*/' \
    --include='*.pdf' --include='*.docx' --include='*.doc' \
    --include='*.xlsx' --include='*.xls' \
    --include='*.txt' --include='*.md' \
    --exclude='*' \
    "$SOURCE/" "$TARGET/" \
    --log-file=/var/log/sop-rsync.log

# Đảm bảo container (uid 1001) đọc được
chown -R 1001:1001 "$TARGET" 2>/dev/null || true

TOTAL_FILES=$(find "$TARGET" -type f \( -name "*.pdf" -o -name "*.docx" -o -name "*.xlsx" -o -name "*.txt" -o -name "*.md" \) | wc -l)
TOTAL_SIZE=$(du -sh "$TARGET" | cut -f1)

echo "$LOG_PREFIX ✓ Hoàn tất. Files: $TOTAL_FILES | Size: $TOTAL_SIZE"
