# Push lên GitHub

Repo em đã init sẵn + commit + remote. Anh chỉ cần giải nén rồi push.

## Nếu repo trên GitHub ĐANG RỖNG

```bash
cd sop-full
git push -u origin main
```

Thế là xong.

## Nếu repo GitHub đã có file sẵn (ví dụ có README mặc định)

Có 2 lựa chọn:

### A. Ghi đè toàn bộ (nếu repo cũ không có gì quan trọng)

```bash
cd sop-full
git push -u origin main --force
```

### B. Merge với content cũ

```bash
cd sop-full
git pull origin main --allow-unrelated-histories
# resolve conflict nếu có (hiếm vì repo cũ chắc chỉ có README)
git push -u origin main
```

## Nếu Git chưa cài / dùng Windows

- Cài Git for Windows: https://git-scm.com/download/win
- Mở "Git Bash" ở folder `sop-full`, chạy lệnh ở trên.

## Nếu bị prompt username/password

GitHub từ 2021 không cho dùng password nữa. Dùng **Personal Access Token (classic)**:
1. Vào https://github.com/settings/tokens → Generate new token (classic)
2. Scope cần: `repo`
3. Copy token, khi git prompt password → paste token thay cho password.

Hoặc dùng GitHub CLI (`gh auth login`) rồi mới push.

## Sau khi push thành công

Vào `Settings → Actions → General` của repo trên GitHub, đảm bảo Actions **Enabled**. Workflow `.github/workflows/build-image.yml` sẽ tự chạy ngay sau commit, build Docker image và push lên GHCR.

Trước khi image build thành công lần đầu, GHCR có thể cần cấu hình thủ công:
- Vào `Settings → Packages` sau khi workflow chạy xong
- Chọn package `backend` → Settings → Change visibility → Public (nếu muốn pull không cần auth)
