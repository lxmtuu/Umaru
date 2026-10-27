import type { Poll, PollOption } from "@umaru/protocol";
import { createSnowflake, type Snowflake } from "@umaru/protocol";
import type { Pool } from "./db.js";
import { badRequest, readString } from "./http.js";

/**
 * Bình chọn (poll) trong tin nhắn.
 *
 * Ba quyết định:
 *
 *  1. **Tối đa 10 lựa chọn, nhãn 1–55 ký tự** — con số của Discord. Nhiều hơn thì
 *     khung chat không còn chỗ cho nút bấm trên điện thoại, và một tin 40 lựa
 *     chọn là công cụ spam gửi 40 dòng tới từng người trong kênh.
 *  2. **Không sửa được poll sau khi gửi** (không có route): người đã bỏ phiếu đã
 *     thấy kết quả, đổi lựa chọn nghĩa là làm sai lệch ý họ. Muốn khác thì gửi
 *     poll mới.
 *  3. **Hết hạn do server quyết** (`ended` tính từ `expires_at`): client không tự
 *     so đồng hồ, vì đồng hồ máy người dùng lệch vài phút là thấy nút bấm được
 *     trong khi server đã chặn.
 */

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_QUESTION_MAX = 300;
export const POLL_LABEL_MAX = 55;
/** Trần thời lượng: 7 ngày. Dài hơn thì poll thành thứ không ai nhớ đã bỏ phiếu. */
export const POLL_MAX_DURATION_HOURS = 168;

/** Dữ liệu poll sau khi kiểm — đủ để ghi DB. */
export interface PollInput {
  question: string;
  options: string[];
  allowMultiple: boolean;
  durationHours: number | null;
}

/**
 * Đọc + kiểm khối `poll` trong body gửi tin. Trả `null` khi không có poll.
 *
 * Kiểm **hết** ở đây (trước khi ghi DB) để không có tin nửa vời: một tin đã phát
 * `MESSAGE_CREATE` mà poll hỏng thì không sửa lại được.
 */
export function readPollInput(body: unknown): PollInput | null {
  const record = body as Record<string, unknown> | undefined;
  const raw = record?.poll;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") throw badRequest('"poll" phải là object');

  const poll = raw as Record<string, unknown>;
  const question = readString(poll, "question", { min: 1, max: POLL_QUESTION_MAX });

  const rawOptions = poll.options;
  if (!Array.isArray(rawOptions)) throw badRequest('"poll.options" phải là mảng');
  if (rawOptions.length < POLL_MIN_OPTIONS || rawOptions.length > POLL_MAX_OPTIONS) {
    throw badRequest(
      `Poll cần ${POLL_MIN_OPTIONS}–${POLL_MAX_OPTIONS} lựa chọn (đang có ${rawOptions.length})`,
    );
  }
  const options: string[] = [];
  for (const item of rawOptions) {
    if (typeof item !== "string") throw badRequest("Mỗi lựa chọn phải là chuỗi");
    const label = item.trim();
    if (label.length === 0) throw badRequest("Lựa chọn không được để trống");
    if ([...label].length > POLL_LABEL_MAX) {
      throw badRequest(`Mỗi lựa chọn tối đa ${POLL_LABEL_MAX} ký tự`);
    }
    // Trùng nhãn thì người bỏ phiếu không biết mình đang chọn cái nào.
    if (options.includes(label)) throw badRequest(`Lựa chọn "${label}" bị lặp`);
    options.push(label);
  }

  const allowMultiple = poll.allowMultiple === true;

  let durationHours: number | null = null;
  if (poll.durationHours !== undefined && poll.durationHours !== null) {
    const value = poll.durationHours;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw badRequest('"poll.durationHours" phải là số nguyên');
    }
    if (value < 1 || value > POLL_MAX_DURATION_HOURS) {
      throw badRequest(`Thời lượng poll phải trong 1–${POLL_MAX_DURATION_HOURS} giờ`);
    }
    durationHours = value;
  }

  return { question, options, allowMultiple, durationHours };
}

/** Ghi poll cho một tin vừa tạo (trong cùng transaction với tin). */
export async function insertPoll(
  client: { query: Pool["query"] },
  messageId: string,
  input: PollInput,
  workerId: number,
): Promise<void> {
  await client.query(
    `INSERT INTO message_polls (message_id, question, allow_multiple, expires_at)
     VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + ($4::int || ' hours')::interval END)`,
    [messageId, input.question, input.allowMultiple, input.durationHours],
  );
  for (const [position, label] of input.options.entries()) {
    await client.query(
      "INSERT INTO poll_options (id, message_id, label, position) VALUES ($1, $2, $3, $4)",
      [createSnowflake(workerId), messageId, label, position],
    );
  }
}

interface PollRow {
  message_id: string;
  question: string;
  allow_multiple: boolean;
  expires_at: Date | null;
  option_id: string | null;
  label: string | null;
  position: number | null;
  votes: string | null;
  mine: boolean | null;
  total_votes: string;
}

/**
 * Nạp poll cho cả trang tin bằng **một** câu SQL.
 *
 * `me` tính theo `viewerId` (không có bản chung đúng cho mọi người), và
 * `total_votes` là `count(DISTINCT user_id)` — với poll nhiều lựa chọn, cộng số
 * phiếu từng dòng sẽ đếm một người nhiều lần.
 */
export async function loadPollsByMessage(
  pool: Pool,
  messageIds: string[],
  viewerId: string,
): Promise<Map<string, Poll>> {
  const result = new Map<string, Poll>();
  if (messageIds.length === 0) return result;

  const rows = await pool.query<PollRow>(
    `SELECT p.message_id,
            p.question,
            p.allow_multiple,
            p.expires_at,
            o.id   AS option_id,
            o.label,
            o.position,
            (SELECT count(*) FROM poll_votes v WHERE v.option_id = o.id)::text AS votes,
            EXISTS (
              SELECT 1 FROM poll_votes v WHERE v.option_id = o.id AND v.user_id = $2::bigint
            ) AS mine,
            (SELECT count(DISTINCT v.user_id) FROM poll_votes v WHERE v.message_id = p.message_id)::text
              AS total_votes
       FROM message_polls p
       LEFT JOIN poll_options o ON o.message_id = p.message_id
      WHERE p.message_id = ANY($1::bigint[])
      ORDER BY p.message_id, o.position`,
    [messageIds, viewerId],
  );

  const now = Date.now();
  for (const row of rows.rows) {
    const existing = result.get(row.message_id);
    const poll =
      existing ??
      ({
        question: row.question,
        options: [],
        allowMultiple: row.allow_multiple,
        totalVotes: Number(row.total_votes),
        expiresAt: row.expires_at === null ? null : row.expires_at.toISOString(),
        ended: row.expires_at !== null && row.expires_at.getTime() <= now,
      } satisfies Poll);
    if (row.option_id !== null && row.label !== null) {
      const option: PollOption = {
        id: row.option_id as Snowflake,
        label: row.label,
        votes: Number(row.votes ?? "0"),
        me: row.mine === true,
      };
      poll.options.push(option);
    }
    result.set(row.message_id, poll);
  }
  return result;
}

/** Poll của **một** tin — dùng cho route bỏ phiếu (cần hình dạng đầy đủ để phát). */
export async function loadPoll(pool: Pool, messageId: string, viewerId: string): Promise<Poll | null> {
  const polls = await loadPollsByMessage(pool, [messageId], viewerId);
  return polls.get(messageId) ?? null;
}
