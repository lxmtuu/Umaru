import type { RedisClient } from "./redis-client.js";
import type { ReplayFrame, SessionRecord, SessionStore } from "./sessionStore.js";

/**
 * Session + replay log trong Redis (ADR-0006).
 *
 * Khoá:
 * - `{prefix}:session:{id}` — hash `userId`, `seq`, `node`, `disconnectedAt`.
 * - `{prefix}:replay:{id}`  — **list** các frame JSON `{ s, payload }`.
 *
 * Vì sao LIST chứ không phải Stream như ADR-0003 phác: yêu cầu thật chỉ là "đọc
 * phần đuôi sau `s`", không cần consumer group, ack hay nhiều consumer. List có
 * `LTRIM` để chặn độ dài và `LRANGE` để đọc — ít lệnh hơn, ít chỗ sai hơn. Đổi
 * sang Stream chỉ khi cần nhiều node cùng đọc một replay log.
 *
 * TTL: mỗi lần ghi đều `PEXPIRE` cả hai khoá theo `sessionTtlMs`, nên dữ liệu
 * rác tự biến mất khi session bị bỏ quên (client đóng app).
 */
export class RedisSessionStore implements SessionStore {
  constructor(
    private readonly client: RedisClient,
    private readonly prefix = "umaru",
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  private sessionKey(id: string): string {
    return `${this.prefix}:session:${id}`;
  }

  private replayKey(id: string): string {
    return `${this.prefix}:replay:${id}`;
  }

  async save(record: SessionRecord, ttlMs: number): Promise<void> {
    await this.client.pipeline([
      [
        "HSET",
        this.sessionKey(record.id),
        "userId",
        record.userId,
        "seq",
        String(record.seq),
        "node",
        record.node,
        "disconnectedAt",
        record.disconnectedAt === null ? "" : String(record.disconnectedAt),
      ],
      ["PEXPIRE", this.sessionKey(record.id), String(ttlMs)],
    ]);
  }

  async load(id: string): Promise<SessionRecord | null> {
    const reply = await this.client.command(["HGETALL", this.sessionKey(id)]);
    if (!Array.isArray(reply) || reply.length === 0) return null;
    const fields = new Map<string, string>();
    for (let index = 0; index + 1 < reply.length; index += 2) {
      const key = reply[index];
      const value = reply[index + 1];
      if (typeof key === "string" && typeof value === "string") fields.set(key, value);
    }
    const userId = fields.get("userId");
    if (userId === undefined || userId === "") return null;
    const disconnectedAt = Number(fields.get("disconnectedAt") ?? "");
    return {
      id,
      userId,
      seq: Number(fields.get("seq") ?? "0") || 0,
      node: fields.get("node") ?? "",
      disconnectedAt: Number.isFinite(disconnectedAt) && disconnectedAt > 0 ? disconnectedAt : null,
    };
  }

  async claim(id: string, node: string, ttlMs: number): Promise<void> {
    await this.client.pipeline([
      ["HSET", this.sessionKey(id), "node", node],
      ["PEXPIRE", this.sessionKey(id), String(ttlMs)],
    ]);
  }

  appendReplay(
    id: string,
    seq: number,
    payload: unknown,
    ttlMs: number,
    maxFrames: number,
  ): void {
    // Một lượt: thêm frame, cắt đuôi, gia hạn TTL. Không chờ (dispatch đồng bộ);
    // lỗi chỉ log — mất một frame replay không làm hỏng dữ liệu thật, client
    // vẫn tải lại được bằng REST.
    void this.client
      .pipeline([
        ["RPUSH", this.replayKey(id), JSON.stringify({ s: seq, payload })],
        ["LTRIM", this.replayKey(id), String(-Math.max(1, maxFrames)), "-1"],
        ["PEXPIRE", this.replayKey(id), String(ttlMs)],
      ])
      .catch((error: unknown) => {
        this.log(`Redis: không ghi được replay cho ${id}: ${String(error)}`);
      });
  }

  async readReplay(id: string, afterSeq: number): Promise<ReplayFrame[]> {
    const reply = await this.client.command(["LRANGE", this.replayKey(id), "0", "-1"]);
    if (!Array.isArray(reply)) return [];
    const frames: ReplayFrame[] = [];
    for (const entry of reply) {
      if (typeof entry !== "string") continue;
      try {
        const parsed = JSON.parse(entry) as { s?: unknown; payload?: unknown };
        if (typeof parsed.s !== "number") continue;
        if (parsed.s <= afterSeq) continue;
        frames.push({ s: parsed.s, payload: parsed.payload });
      } catch {
        this.log(`Redis: replay của ${id} có frame không phải JSON — bỏ qua`);
      }
    }
    frames.sort((left, right) => left.s - right.s);
    return frames;
  }

  async delete(id: string): Promise<void> {
    await this.client.command(["DEL", this.sessionKey(id), this.replayKey(id)]);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
