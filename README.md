# VocabForge — TOEIC Vocabulary Extension (MV3)

VocabForge là Chrome Extension giúp bạn **lưu từ vựng nhanh khi bôi đen**, **tự dịch sang tiếng Việt**, và **ôn tập theo lịch (spaced repetition)** với thống kê **streak / XP / due words**.

---

## ✨ Tính năng chính

- **Quick Add**: bôi đen từ trên bất kỳ trang web nào để lưu nhanh vào từ điển.
- **Auto translate**: tự dịch nghĩa (VN), tự gợi ý part of speech, có thể nhập ví dụ/tags.
- **Review / Session**
  - **Start Review**: ôn tất cả từ **đang đến hạn (Due)**.
  - **Start Session**: luyện theo **số lượng + chế độ** bạn chọn (Smart/Due…).
- **Streak & Flame**
  - Hiển thị số ngày streak.
  - Dãy mốc streak theo tier: **3d → 10d → 30d → 100d → 200d** (chưa đạt sẽ xám).
  - Icon ngọn lửa có **animation flicker**.

---

## ⌨️ Phím tắt (trong Quick Add)

> (Một số trang web chặn phím tắt. Nếu không hoạt động, hãy click icon thay thế hoặc dùng UI nút.)

- **Alt + S / Alt + A**: Save nhanh (tuỳ UI đang mở)
- **Alt + D**: **Auto dịch lại** (restore auto + fill meaning/pos/example)
- **Enter**: Save (khi focus trong modal/field phù hợp)
- **Shift + Enter**: xuống dòng (trong ô Meaning/Example)

---

## 🧠 Cách hoạt động Streak / Due

- **Due**: từ cần ôn theo lịch (dựa vào `dueAt`).
- **Streak**: tăng khi bạn có hoạt động học/ôn trong ngày (record result).
- Các tier streak:
  - 3 ngày
  - 10 ngày
  - 30 ngày
  - 100 ngày
  - 200 ngày

---

## 🧩 Cài đặt

1. Mở Chrome → vào: `chrome://extensions`
2. Bật **Developer mode**
3. Chọn **Load unpacked**
4. Trỏ đến thư mục dự án VocabForge

---

## 🔄 Update / Reload đúng cách (tránh lỗi “Extension context invalidated”)

Khi bạn **Reload extension** hoặc Chrome cập nhật extension:
- Những tab đang mở từ trước có thể giữ content-script cũ.
- Nếu bạn thấy lỗi hoặc phím tắt không hoạt động:
  1. **Reload extension** ở `chrome://extensions`
  2. **Reload lại tab web** bạn đang dùng (F5 / Ctrl+R)
  3. Thử lại Quick Add / Alt + D

> Mình đã thêm cơ chế “safeSendMessage” để tránh crash/unhandled error,
> nhưng việc reload tab sau khi extension update là hành vi bình thường của MV3.

---

## 🗂️ Cấu trúc file chính

- `manifest.json` — cấu hình MV3, permissions, scripts
- `background.js` — service worker / xử lý nền (translate, storage, alarms nếu có)
- `content.js` — bắt selection, hiển thị Quick Add UI, xử lý phím tắt
- `popup.html`, `popup.js` — UI popup (due, streak, quick add, start review/session)
- `dashboard.html`, `dashboard.js` — trang dashboard (thống kê, danh sách từ, chỉnh sửa)
- `review.html`, `review.js` — trang review (queue, session, rating Good/Hard…)
- `styles.css` — theme + animation (snow, flame, UI chung)
- `storage.js`, `stats.js` — lưu trữ, thống kê streak/XP

---

## 🧪 Kiểm tra nhanh sau khi cài

- Bôi đen một từ tiếng Anh trên web → Quick Add hiện lên
- Nhấn **Alt + D** → meaning tự dịch và đổ vào ô
- Nhấn **Alt + S** → lưu từ
- Mở popup → kiểm tra Due / Next review / Streak flame tier

---

## 🛠️ Troubleshooting

### 1) Alt + D báo “Extension context invalidated”
- Reload extension + reload tab web (xem mục Update/Reload).
- Nếu đang chạy nhiều bản extension trùng ID (dev) → chỉ bật 1 bản.

### 2) Quick Add không hiện ở một số trang
- Một số trang (nhất là site có sandbox/csp chặt) có thể hạn chế content-script.
- Kiểm tra `manifest.json` phần `host_permissions` và `matches`.
- Thử trang khác để đối chiếu.

### 3) Auto translate không ra nghĩa
- Có thể do mạng/endpoint bị chặn.
- Thử Alt + D lần nữa hoặc nhập tay.
- (Nếu bạn dùng API riêng trong `background.js`, kiểm tra key/quota.)

---

## ✅ Góp ý / Roadmap

- Tối ưu thuật toán review (SRS) & “Smart mode”
- Import từ file / ảnh (OCR) theo yêu cầu
- Đồng bộ cloud / export CSV
- Theme + animation nâng cao

---

**VocabForge** — học từ vựng hiệu quả, nhanh, ít thao tác và có “game feel” nhờ streak + animation 🔥
