/**
 * Nơi lưu **session gateway + replay log** để resume được ngoài bộ nhớ một node.
 *
 * Vì sao cần lớp này: `RESUME` cần biết "session này của ai, đã phát tới `s` nào,
 * những frame nào client lỡ". Nếu chỉ giữ trong RAM thì (a) reconnect vào node
 * khác là mất, (b) restart API là mất, (c) rolling deploy làm mọi người resync.
 * ADR-0006 mô tả lựa chọn lưu bằng Redis; `MemorySessionStore` ở đây để test
 * logic của hub mà không cần Redis, và là mức tham chiếu khi so sánh.
 *
 * Hợp đồng cố tình nhỏ: hub vẫn là nơi quyết định *khi nào* ghi (sau mỗi
 * dispatch) và *ai* được resume (token + userId). Store chỉ giữ chữ.
 */

export interface SessionRecord {
  id: string;
  userId: string;
  /** `s` cuối cùng đã phát cho session này (0 = chưa phát gì). */
  seq: number;
  /** Node đang sở hữu — node khác resume sẽ "đòi" lại. */
  node: string;
  /** Mốc ngắt kết nối gần nhất (ms) — `null` khi còn socket sống. */
  disconnectedAt: number | null;
}

export interface ReplayFrame {
  s: number;
  payload: unknown;
}

export interface SessionStore {
  /** Ghi/ghi đè metadata session, TTL = khoảng thời gian còn cho phép resume. */
  save(record: SessionRecord, ttlMs: number): Promise<void>;
  load(id: string): Promise<SessionRecord | null>;
  /** Đặt lại node sở hữu sau khi session được resume ở node khác. */
  claim(id: string, node: string, ttlMs: number): Promise<void>;
  /**
   * Ghi một frame vào replay log. **Không** trả promise: `dispatch` của hub là
   * hàm đồng bộ, gọi từ hàng chục chỗ; chờ I/O ở đây sẽ làm nghẽn toàn bộ vòng
   * phát sự kiện. Lỗi ghi được log lại, không ném.
   */
  appendReplay(
    id: string,
    seq: number,
    payload: unknown,
    ttlMs: number,
    maxFrames: number,
  ): void;
  /** Các frame có `s > afterSeq`, tăng dần. */
  readReplay(id: string, afterSeq: number): Promise<ReplayFrame[]>;
  delete(id: string): Promise<void>;
  close(): Promise<void>;
}

/** Store trong bộ nhớ — dùng cho test nhiều node trong một tiến trình. */
export class MemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly frames = new Map<string, ReplayFrame[]>();

  async save(record: SessionRecord, _ttlMs: number): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  async load(id: string): Promise<SessionRecord | null> {
    const record = this.records.get(id);
    return record === undefined ? null : { ...record };
  }

  async claim(id: string, node: string, _ttlMs: number): Promise<void> {
    const record = this.records.get(id);
    if (record !== undefined) record.node = node;
  }

  appendReplay(id: string, seq: number, payload: unknown, _ttlMs: number, maxFrames: number): void {
    const frames = this.frames.get(id) ?? [];
    frames.push({ s: seq, payload });
    if (frames.length > maxFrames) frames.splice(0, frames.length - maxFrames);
    this.frames.set(id, frames);
  }

  async readReplay(id: string, afterSeq: number): Promise<ReplayFrame[]> {
    return (this.frames.get(id) ?? []).filter((frame) => frame.s > afterSeq);
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
    this.frames.delete(id);
  }

  async close(): Promise<void> {
    this.records.clear();
    this.frames.clear();
  }
}
