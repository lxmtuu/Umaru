import { describe, expect, it } from "vitest";
import {
  UmaruEpoch,
  createSnowflake,
  isValidSnowflake,
  parseSnowflake,
  snowflakeTimestamp,
} from "./snowflake.js";

describe("snowflake", () => {
  it("roundtrip timestamp, worker và sequence trong cùng ms", () => {
    const now = UmaruEpoch + 1_700_000_000;
    const a = createSnowflake(42, now);
    const b = createSnowflake(42, now); // cùng ms → sequence +1

    const pa = parseSnowflake(a);
    const pb = parseSnowflake(b);

    expect(pa.timestamp).toBe(now);
    expect(pa.workerId).toBe(42);
    expect(pb.sequence).toBe(pa.sequence + 1);
    expect(BigInt(b)).toBeGreaterThan(BigInt(a));
  });

  it("ID tăng dần theo thời gian, timestamp đọc lại được", () => {
    const earlier = createSnowflake(1, UmaruEpoch + 1000);
    const later = createSnowflake(1, UmaruEpoch + 2000);

    expect(BigInt(later)).toBeGreaterThan(BigInt(earlier));
    expect(snowflakeTimestamp(earlier)).toBe(UmaruEpoch + 1000);
    expect(snowflakeTimestamp(later)).toBe(UmaruEpoch + 2000);
  });

  it("validate đúng / sai", () => {
    expect(isValidSnowflake("123456789012345678")).toBe(true);
    expect(isValidSnowflake("abc")).toBe(false);
    expect(isValidSnowflake("")).toBe(false);
    expect(isValidSnowflake("-1")).toBe(false);
    expect(isValidSnowflake("12.5")).toBe(false);
  });

  it("workerId ngoài [0, 1023] ném RangeError", () => {
    expect(() => createSnowflake(1024)).toThrow(RangeError);
    expect(() => createSnowflake(-1)).toThrow(RangeError);
  });

  it("parse ID rác ném TypeError", () => {
    expect(() => parseSnowflake("not-a-snowflake" as never)).toThrow(TypeError);
  });
});
