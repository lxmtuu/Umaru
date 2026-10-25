import { describe, expect, it } from "vitest";
import { computeBackoffMs } from "./backoff.js";

describe("computeBackoffMs", () => {
  it("tăng exponential và cap tại maxMs (jitter = 0)", () => {
    const at = (attempt: number) => computeBackoffMs({ attempt, jitter: 0 });
    expect(at(0)).toBe(1000);
    expect(at(1)).toBe(2000);
    expect(at(3)).toBe(8000);
    expect(at(30)).toBe(30_000);
  });

  it("jitter nằm trong [exp*(1-j), exp*(1+j)]", () => {
    const exponential = 4000; // attempt = 2
    for (const random of [0, 0.5, 1]) {
      const ms = computeBackoffMs({ attempt: 2, jitter: 0.3, random: () => random });
      expect(ms).toBeGreaterThanOrEqual(Math.round(exponential * 0.7));
      expect(ms).toBeLessThanOrEqual(Math.round(exponential * 1.3));
    }
    // random() = 0.5 → đúng giá trị exponential
    expect(computeBackoffMs({ attempt: 2, jitter: 0.3, random: () => 0.5 })).toBe(exponential);
  });

  it("attempt âm không gây số mũ âm", () => {
    expect(computeBackoffMs({ attempt: -5, jitter: 0, random: () => 0 })).toBe(1000);
  });
});
