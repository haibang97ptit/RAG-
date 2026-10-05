# Mount SMB share công ty vào Linux server

Giả định: file server công ty share folder qua SMB/CIFS, ví dụ:
- UNC path: `\\fileserver.company.local\sop`
- Linux dạng: `//fileserver.company.local/sop`

## Phương án: Mount + rsync (khuyến nghị)

Lý do: mount trực tiếp vào container Docker thường gặp vấn đề permission + chậm khi scan nhiều file. Mount lên host rồi rsync sang local SSD sẽ:
- Ổn định (không phụ thuộc network khi index)
- Nhanh (local disk)
- An toàn (read-only mount, không rủi ro ghi nhầm file công ty)

### Bước 1: Cài gói

```bash
sudo apt-get update
sudo apt-get install -y cifs-utils rsync
```

### Bước 2: Tạo file credentials (bảo mật)

```bash
sudo mkdir -p /etc/sop
sudo nano /etc/sop/smb-credentials
```

Nội dung:
```
username=sop_readonly_user
password=STRONG_PASSWORD
domain=COMPANY
```

Phân quyền chỉ root đọc:
```bash
sudo chmod 600 /etc/sop/smb-credentials
sudo chown root:root /etc/sop/smb-credentials
```

### Bước 3: Mount thử

```bash
sudo mkdir -p /mnt/sop-shared
sudo mount -t cifs //fileserver.company.local/sop /mnt/sop-shared \
  -o credentials=/etc/sop/smb-credentials,ro,uid=$(id -u),gid=$(id -g),iocharset=utf8,vers=3.0

ls /mnt/sop-shared
```

Nếu lỗi `No such device or address` → thử `vers=2.1` hoặc `vers=1.0`.

### Bước 4: Mount tự động mỗi lần boot (fstab)

```bash
sudo nano /etc/fstab
```

Thêm dòng (1 dòng duy nhất):
```
//fileserver.company.local/sop  /mnt/sop-shared  cifs  credentials=/etc/sop/smb-credentials,ro,uid=1000,gid=1000,iocharset=utf8,vers=3.0,x-systemd.automount,_netdev  0  0
```

Kiểm tra:
```bash
sudo umount /mnt/sop-shared
sudo mount -a
ls /mnt/sop-shared
```

### Bước 5: Sync sang local

Tạo thư mục local:
```bash
sudo mkdir -p /opt/sop-local-data
sudo chown -R 1001:1001 /opt/sop-local-data  # uid Docker user
```

Chạy script:
```bash
bash /opt/sop-ai/scripts/sync-shared-folder.sh
```

Nội dung script (xem `scripts/sync-shared-folder.sh`):
```bash
rsync -av --delete \
  --include='*/' \
  --include='*.pdf' --include='*.docx' --include='*.xlsx' \
  --include='*.xls' --include='*.txt' --include='*.md' \
  --exclude='*' \
  /mnt/sop-shared/ /opt/sop-local-data/
```

### Bước 6: Cronjob tự động

```bash
crontab -e
```

Thêm:
```cron
# Sync SMB share → local mỗi 30 phút
*/30 * * * * /opt/sop-ai/scripts/sync-shared-folder.sh >> /var/log/sop-sync.log 2>&1

# Incremental ingest mỗi 2h, 15 phút sau sync
15 */2 * * * cd /opt/sop-ai && docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T backend node dist/incrementalIngest.js >> /var/log/sop-ingest.log 2>&1
```

## Troubleshooting

**Lỗi mount: `mount error(13): Permission denied`**
→ Credentials sai, hoặc user không có quyền read share. Nhờ IT grant đọc.

**Lỗi: `mount error(112): Host is down`**
→ Mạng ko tới được file server. Check `ping fileserver.company.local`.

**File tiếng Việt bị lỗi encoding**
→ Thêm `iocharset=utf8,nounix` vào options mount.

**Mount quá chậm**
→ Dùng `cache=loose` + mount read-only. Hoặc chuyển sang NFS nếu file server support.

**Permission bị denied khi container đọc `/opt/sop-local-data`**
→ Chown lại `sudo chown -R 1001:1001 /opt/sop-local-data` (uid Docker nodejs user).
