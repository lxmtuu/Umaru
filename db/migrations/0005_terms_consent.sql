-- Umaru — bằng chứng đồng ý điều khoản (G0: Terms/Privacy)
--
-- Vì sao lưu: khi luật thay đổi hoặc văn bản được sửa, cần biết mỗi tài khoản đã
-- đồng ý **bản nào**. Chỉ lưu phiên bản + thời điểm, không lưu nội dung văn bản
-- (nội dung nằm ở apps/web/src/lib/legal.ts, phiên bản ở
-- packages/protocol/src/legal.ts).
--
-- Tài khoản tạo trước migration này không có mốc đồng ý (NULL) — đúng sự thật,
-- không backfill giả.

BEGIN;

ALTER TABLE users
  ADD COLUMN terms_accepted_at TIMESTAMPTZ,
  ADD COLUMN terms_version TEXT;

COMMIT;
