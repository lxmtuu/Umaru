# Architecture Decision Records

Mỗi ADR ghi lại **một** quyết định kiến trúc: bối cảnh, lựa chọn, hệ quả (kể cả cái xấu), phương án bị loại và **ngưỡng xem lại**. Không sửa nội dung ADR cũ khi quyết định thay đổi — tạo ADR mới và đánh dấu cái cũ `Superseded by ADR-XXXX`.

| # | Quyết định | Trạng thái |
|---|---|---|
| [0001](0001-monorepo-shared-protocol.md) | Monorepo pnpm + Turborepo, `packages/protocol` là nguồn sự thật duy nhất | Accepted |
| [0002](0002-json-wire-format.md) | Gateway v1 dùng JSON text, chưa dùng binary | Accepted (xem lại ở G3) |
| [0003](0003-gateway-resume-redis-streams.md) | Resume bằng session + Redis Streams replay log | Accepted |
| [0004](0004-backend-typescript-first.md) | Backend G1 bằng TypeScript (Fastify + `ws`), Rust/Go chỉ khi vượt ngưỡng | Accepted |

Tài liệu liên quan: [data-model.md](../data-model.md) · [gateway-protocol.md](../gateway-protocol.md) · [ROADMAP.md](../../ROADMAP.md)
