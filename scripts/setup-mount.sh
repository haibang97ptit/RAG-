#!/usr/bin/env bash
# Setup SMB mount - CHẠY VỚI SUDO
# Edit các biến bên dưới cho đúng với công ty rồi chạy.

set -euo pipefail

# ============ CẤU HÌNH ============
SMB_HOST="fileserver.company.local"
SMB_SHARE="sop"
MOUNT_POINT="/mnt/sop-shared"
CREDENTIALS_FILE="/etc/sop/smb-credentials"
TARGET_UID="1000"   # UID của user chạy service
TARGET_GID="1000"
SMB_VERSION="3.0"
# ===================================

if [[ $EUID -ne 0 ]]; then
   echo "❌ Script này cần chạy với sudo"
   exit 1
fi

echo "📦 Cài cifs-utils..."
apt-get update -qq
apt-get install -y cifs-utils rsync

if [[ ! -f "$CREDENTIALS_FILE" ]]; then
    echo ""
    echo "⚠️  Chưa có credentials file tại $CREDENTIALS_FILE"
    echo "   Tạo file đó với nội dung:"
    echo ""
    echo "   username=..."
    echo "   password=..."
    echo "   domain=..."
    echo ""
    echo "   Rồi chmod 600, sau đó chạy lại script này."
    exit 1
fi

chmod 600 "$CREDENTIALS_FILE"
chown root:root "$CREDENTIALS_FILE"

mkdir -p "$MOUNT_POINT"

echo "🔌 Mount thử //$SMB_HOST/$SMB_SHARE → $MOUNT_POINT ..."

if mountpoint -q "$MOUNT_POINT"; then
    umount "$MOUNT_POINT" || true
fi

mount -t cifs "//$SMB_HOST/$SMB_SHARE" "$MOUNT_POINT" \
    -o "credentials=$CREDENTIALS_FILE,ro,uid=$TARGET_UID,gid=$TARGET_GID,iocharset=utf8,vers=$SMB_VERSION"

echo "✓ Mount thành công. Kiểm tra:"
ls -la "$MOUNT_POINT" | head -20

FSTAB_LINE="//$SMB_HOST/$SMB_SHARE  $MOUNT_POINT  cifs  credentials=$CREDENTIALS_FILE,ro,uid=$TARGET_UID,gid=$TARGET_GID,iocharset=utf8,vers=$SMB_VERSION,x-systemd.automount,_netdev  0  0"

if grep -qF "//$SMB_HOST/$SMB_SHARE" /etc/fstab; then
    echo "ℹ️  Đã có entry trong /etc/fstab, không thêm lại."
else
    echo "📝 Thêm vào /etc/fstab để auto-mount khi boot..."
    echo "$FSTAB_LINE" >> /etc/fstab
    echo "✓ Added:"
    echo "   $FSTAB_LINE"
fi

echo ""
echo "✅ XONG. Mount point: $MOUNT_POINT"
echo "   Tiếp theo: chạy scripts/sync-shared-folder.sh để sync sang local."
