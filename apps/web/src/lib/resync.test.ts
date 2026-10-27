import { describe, expect, it } from "vitest";
import type { Message } from "@umaru/protocol";
import { mergeAfterResync } from "./resync.js";

/**
 * Ghép tin sau khi resume.
 *
 * Bài học đứng sau hàm này: replay chỉ phát lại frame còn trong log, nên frame
 * bị mất có thể là `MESSAGE_DELETE`. Tin đã bị xoá vẫn nằm trong khung chat cho
 * tới lần F5 — người dùng thấy một tin "ma", bấm vào thì 404.
 */
function message(id: string, content = `tin ${id}`): Message {
  return {
    id,
    channelId: "100",
    authorId: "1",
    content,
    // Thời gian không quan trọng: hàm chỉ so id. Snowflake lớn (vài trăm tỷ ms)
    // vượt giới hạn Date nên không dùng nó làm mốc thời gian.
    createdAt: new Date(0).toISOString(),
    editedAt: null,
    replyToId: null,
    attachments: [],
    reactions: [],
    embeds: [],
    pinned: false,
  } as unknown as Message;
}

const ids = (list: Message[]) => list.map((item) => item.id);

describe("mergeAfterResync", () => {
  it("server thắng trong cửa sổ: tin bị xoá lúc mất mạng biến mất", () => {
    const existing = [message("10"), message("11"), message("12")];
    const fresh = [message("10"), message("12")];
    expect(ids(mergeAfterResync(existing, fresh))).toEqual(["10", "12"]);
  });

  it("tin bị sửa trong lúc mất mạng lấy nội dung mới", () => {
    const merged = mergeAfterResync([message("10", "cũ")], [message("10", "mới")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.content).toBe("mới");
  });

  it("giữ lịch sử cũ hơn cửa sổ (người dùng đã cuộn lên đọc)", () => {
    const existing = [message("5"), message("6"), message("11"), message("12")];
    const fresh = [message("11"), message("12"), message("13")];
    expect(ids(mergeAfterResync(existing, fresh))).toEqual(["5", "6", "11", "12", "13"]);
  });

  it("giữ tin mới hơn cửa sổ (vừa tới qua replay, trang chưa gồm)", () => {
    const existing = [message("11"), message("12"), message("14")];
    const fresh = [message("11"), message("12")];
    expect(ids(mergeAfterResync(existing, fresh))).toEqual(["11", "12", "14"]);
  });

  it("kết quả luôn tăng dần theo id, không trùng", () => {
    const existing = [message("6"), message("3"), message("12")];
    const fresh = [message("12"), message("9")];
    expect(ids(mergeAfterResync(existing, fresh))).toEqual(["3", "6", "9", "12"]);
  });

  it("server không trả gì (kênh rỗng trang) thì giữ nguyên", () => {
    const existing = [message("7"), message("8")];
    expect(mergeAfterResync(existing, [])).toBe(existing);
  });

  it("so sánh bằng BigInt: id vượt Number.MAX_SAFE_INTEGER vẫn đúng thứ tự", () => {
    const big = "240329223191920640";
    const bigger = "240329223191920641";
    expect(ids(mergeAfterResync([message(bigger)], [message(big)]))).toEqual([big, bigger]);
  });
});
