/**
 * Snowflake ID (mô hình Discord): 42-bit mili-giây kể từ UmaruEpoch | 10-bit worker | 12-bit sequence.
 * Thứ tự tin nhắn suy ra từ ID, KHÔNG dựa vào timestamp máy client (ROADMAP §4.2, lưu ý 5).
 */

export type Snowflake = string & { readonly __brand: "Snowflake" };

/** 2025-01-01T00:00:00.000Z */
export const UmaruEpoch = 1_735_689_600_000;

const SEQUENCE_MASK = 0xfff; // 12 bit → 4096 ID mỗi ms mỗi worker

let lastTimestamp = -1;
let sequence = 0;

export function createSnowflake(workerId = 0, now = Date.now()): Snowflake {
  if (!Number.isInteger(workerId) || workerId < 0 || workerId > 1023) {
    throw new RangeError(`workerId phải nằm trong [0, 1023], nhận được ${workerId}`);
  }
  const timestamp = now - UmaruEpoch;
  if (timestamp < 0) {
    throw new RangeError(`now phải lớn hơn UmaruEpoch (${UmaruEpoch})`);
  }
  if (now === lastTimestamp) {
    sequence = (sequence + 1) & SEQUENCE_MASK; // wrap nếu vượt 4096 ID trong cùng ms
  } else {
    sequence = 0;
    lastTimestamp = now;
  }
  const id = (BigInt(timestamp) << 22n) | (BigInt(workerId) << 12n) | BigInt(sequence);
  return id.toString() as Snowflake;
}

export interface SnowflakeParts {
  timestamp: number;
  workerId: number;
  sequence: number;
}

export function parseSnowflake(id: Snowflake): SnowflakeParts {
  if (!isValidSnowflake(id)) {
    throw new TypeError(`Không phải snowflake hợp lệ: ${String(id)}`);
  }
  const value = BigInt(id);
  return {
    timestamp: Number(value >> 22n) + UmaruEpoch,
    workerId: Number((value >> 12n) & 0x3ffn),
    sequence: Number(value & 0xfffn),
  };
}

export function snowflakeTimestamp(id: Snowflake): number {
  return parseSnowflake(id).timestamp;
}

export function isValidSnowflake(value: string): boolean {
  if (!/^\d{1,20}$/.test(value)) return false;
  try {
    BigInt(value);
    return true;
  } catch {
    return false;
  }
}
