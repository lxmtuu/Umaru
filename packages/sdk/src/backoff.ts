export interface BackoffOptions {
  /** 0-based: lần thử lại thứ mấy. */
  attempt: number;
  baseMs?: number;
  factor?: number;
  maxMs?: number;
  /** Biên độ jitter 0..1 quanh giá trị exponential. */
  jitter?: number;
  random?: () => number;
}

/**
 * Exponential backoff + jitter — reconnect gateway không dồn ép server
 * (ROADMAP §4.2, lưu ý 1: resume + retry có kiểm soát).
 */
export function computeBackoffMs(options: BackoffOptions): number {
  const {
    attempt,
    baseMs = 1000,
    factor = 2,
    maxMs = 30_000,
    jitter = 0.3,
    random = Math.random,
  } = options;
  const exponential = Math.min(maxMs, baseMs * factor ** Math.max(0, attempt));
  const spread = exponential * Math.min(Math.max(jitter, 0), 1);
  return Math.round(exponential - spread + random() * 2 * spread);
}
