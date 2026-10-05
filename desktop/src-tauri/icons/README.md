# Icons

Thư mục này chứa icon cho desktop app. Cần có đầy đủ các file sau để `tauri build` thành công:

- `32x32.png`
- `128x128.png`
- `128x128@2x.png` (256x256)
- `icon.ico` (Windows)
- `icon.icns` (macOS)

## Tạo nhanh từ 1 file PNG gốc

Chuẩn bị 1 file PNG 1024x1024 (nền trong suốt càng tốt), đặt tên `source.png`, sau đó dùng:

```bash
cd desktop
npm run tauri icon ./src-tauri/icons/source.png
```

Lệnh trên sẽ tự tạo tất cả các size cần thiết.

## Hoặc dùng tạm bộ icon mặc định của Tauri

```bash
# ở thư mục desktop/
mkdir -p src-tauri/icons
cp node_modules/@tauri-apps/cli/*/icons/* src-tauri/icons/ 2>/dev/null || true
```

(Chỉ dùng cho dev - production nên có icon riêng.)
