/**
 * Rate limit thuần bộ nhớ (token bucket) — spec §7.
 *
 * Vì sao token bucket chứ không phải "đếm trong cửa sổ cố định": cửa sổ cố định
 * cho phép bắn 2× giới hạn ở ranh giới hai cửa sổ (30 tin lúc 11:59:59 rồi 30
 * tin lúc 12:00:00), còn token bucket làm mượt theo thời gian thật.
 *
 * Ở G1 chưa có Redis: bộ đếm **theo từng process**. Nhiều node thì giới hạn thực
 * tế = n × giới hạn cấu hình — ghi rõ trong docs thay vì che đi.
 *
 * Mọi hàm ở đây đều nhận `now` để test không phải `sleep`.
 */
export class Bucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = limit;
    this.updatedAt = now();
  }

  /**
   * Xin 1 token. `null` = được phép; ngược lại là **số giây phải chờ** (làm tròn
   * lên, tối thiểu 1) để client hiện được "thử lại sau N giây".
   */
  take(cost = 1): number | null {
    const now = this.now();
    const elapsed = Math.max(0, now - this.updatedAt);
    this.tokens = Math.min(this.limit, this.tokens + (elapsed / this.windowMs) * this.limit);
    this.updatedAt = now;

    if (this.tokens < cost) {
      const waitMs = ((cost - this.tokens) / this.limit) * this.windowMs;
      return Math.max(1, Math.ceil(waitMs / 1000));
    }
    this.tokens -= cost;
    return null;
  }
}

/**
 * Nhiều bucket theo khoá (userId, userId:channelId, …) trong một process.
 *
 * `maxKeys` chặn phình bộ nhớ khi bị quét khoá rác: vượt ngưỡng thì bỏ các khoá
 * **lâu không dùng nhất** (bucket vừa đầy token cũng coi là cũ, vứt đi không sao
 * vì tạo lại là đầy ngay).
 */
export class BucketStore {
  private readonly buckets = new Map<string, { bucket: Bucket; touchedAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 20_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** `null` = được phép, ngược lại là số giây phải chờ. */
  take(key: string): number | null {
    const now = this.now();
    let entry = this.buckets.get(key);
    if (entry === undefined) {
      entry = { bucket: new Bucket(this.limit, this.windowMs, this.now), touchedAt: now };
      this.buckets.set(key, entry);
      if (this.buckets.size > this.maxKeys) this.evictOldest();
    }
    entry.touchedAt = now;
    return entry.bucket.take();
  }

  /** Xoá khoá (test, hoặc khi người dùng rời kênh). */
  clear(key: string): void {
    this.buckets.delete(key);
  }

  get size(): number {
    return this.buckets.size;
  }

  private evictOldest(): void {
    // Bỏ 10% cũ nhất một lượt để không phải duyệt lại ở mỗi lần thêm.
    const victims = Math.max(1, Math.floor(this.maxKeys * 0.1));
    const sorted = [...this.buckets.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    for (const [key] of sorted.slice(0, victims)) this.buckets.delete(key);
  }
}

/** Body lỗi 429 thống nhất cho mọi route REST (spec §7: `429` + `retry_after`). */
export function rateLimitedBody(retryAfter: number, message: string): {
  error: { code: string; message: string };
  retry_after: number;
} {
  return { error: { code: "RATE_LIMITED", message }, retry_after: retryAfter };
}
