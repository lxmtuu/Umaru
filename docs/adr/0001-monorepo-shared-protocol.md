# ADR-0001 — Monorepo pnpm + Turborepo, `packages/protocol` là nguồn sự thật duy nhất

- **Trạng thái:** Accepted
- **Ngày:** 2026-10-22
- **Liên quan:** [ROADMAP §4.1](../../ROADMAP.md), [gateway-protocol.md](../gateway-protocol.md)

## Bối cảnh

Umaru phải chạy trên **web, desktop (Tauri/Electron) và mobile (React Native)**. Ba client này dùng chung gần như toàn bộ domain logic: cấu trúc `Message`/`Guild`/`Channel`, bitfield quyền, khung gateway, parse snowflake, reconnect. Nếu mỗi client tự định nghĩa type, mỗi lần server đổi payload sẽ hỏng 3 nơi với 3 kiểu lỗi khác nhau (và mobile phát hiện muộn nhất vì release chậm).

Backend cũng cần cùng định nghĩa đó: gateway phải encode đúng khung mà SDK decode.

## Quyết định

1. **Một monorepo duy nhất**, workspace bằng **pnpm** (nhanh, tiết kiệm đĩa, `workspace:*` rõ ràng).
2. Orchestration bằng **Turborepo**: `build` có phụ thuộc `^build`, `typecheck`/`test` chạy song song và cache theo hash file.
3. Chia gói:
   - `packages/protocol` — **thuần logic, không phụ thuộc runtime** (không React, không Node API): type entity, snowflake, permissions, gateway opcode + event map, codec.
   - `packages/sdk` — client REST + gateway (dùng `@umaru/protocol`), chạy được ở browser/Node/RN.
   - `apps/web` — React + Vite.
   - Tương lai: `apps/desktop`, `apps/mobile`, `packages/ui`, `services/api`, `services/gateway`.
4. **Quy tắc một chiều**: `apps/*` → `packages/sdk` → `packages/protocol`. Protocol **không bao giờ** import ngược lên.
5. Protocol giữ **zero dependency** ở runtime (chỉ devDependency: typescript, vitest) để dùng được trong Worker/RN/CLI mà không kéo theo gì.

## Hệ quả

**Tích cực**
- Đổi payload ở một chỗ → `tsc` báo lỗi ở cả 3 client ngay trong CI.
- Codec/permission logic có test riêng, không bị trộn với UI.
- Backend TS (ADR-0004) import lại chính `@umaru/protocol` → không có "hai định nghĩa sự thật".

**Tiêu cực / phải chấp nhận**
- Phải build protocol trước khi chạy app (`dist/` được export theo `exports` field). `turbo dev` xử lý thứ tự, nhưng thêm package mới phải khai báo đúng `dependsOn`.
- Type dùng chung dễ bị "vá tạm" ở client khi server chưa sẵn sàng — cấm: mọi thay đổi shape phải vào protocol trước.
- CI cần cache Turborepo để không chậm; hiện **chưa có CI** (G0 checklist còn mở).

## Phương án đã loại

| Phương án | Lý do loại |
|---|---|
| Nhiều repo + publish protocol lên registry | vòng lặp phát triển chậm, quản lý version thủ công khi chưa có người dùng |
| Copy type vào từng app | chắc chắn lệch nhau; đây là lỗi phổ biến nhất của các Discord-clone |
| npm workspaces | chậm hơn, resolution kém hơn với peer deps phức tạp |
| Nx | mạnh hơn nhưng nặng, cấu hình nhiều cho một dự án 0đ |

## Khi nào xem lại

- Số package > ~15 hoặc build > 5 phút → cân nhắc remote cache (Turborepo remote / self-host).
- Nếu cần phát hành SDK cho bên thứ ba → tách `packages/sdk` thành repo riêng có version ngữ nghĩa.
