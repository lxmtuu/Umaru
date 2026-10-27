import type { Channel } from "@umaru/protocol";
import { describe, expect, it } from "vitest";
import { resolveDrop } from "./channelDrop.js";

/**
 * Kéo-thả kênh trong sidebar. `position` là chỉ số trong nhóm anh em **không
 * tính** kênh đang kéo — server cũng tính vậy rồi renumber cả dãy, nên lệch một
 * đơn vị ở đây là lệch cả danh sách.
 */

// Snowflake là string có brand → phải ép kiểu ở đúng một chỗ thay vì rải `as`.
type ChannelInput = {
  id: string;
  type?: Channel["type"];
  name?: string;
  categoryId?: string | null;
  position?: number;
};

function channel(partial: ChannelInput): Channel {
  return {
    id: partial.id as Channel["id"],
    guildId: "1" as Channel["guildId"],
    type: partial.type ?? "guild_text",
    name: partial.name ?? partial.id,
    topic: null,
    categoryId: (partial.categoryId ?? null) as Channel["categoryId"],
    position: partial.position ?? 0,
    slowmodeSeconds: 0,
  };
}

const category = channel({ id: "c1", type: "category", position: 0, name: "Học tập" });

describe("resolveDrop — kênh chữ", () => {
  const a = channel({ id: "a", position: 0 });
  const b = channel({ id: "b", position: 1 });
  const inside = channel({ id: "in", position: 2, categoryId: "c1" });
  const inside2 = channel({ id: "in2", position: 3, categoryId: "c1" });

  it("thả nửa trên/nửa dưới một hàng cùng nhóm → chèn trước/sau", () => {
    expect(
      resolveDrop([category, a, b], b, { kind: "row", channel: a, zone: "before" }),
    ).toEqual({ parentId: null, position: 0 });
    expect(
      resolveDrop([category, a, b], a, { kind: "row", channel: b, zone: "after" }),
    ).toEqual({ parentId: null, position: 1 });
  });

  it("kéo từ gốc vào trong danh mục (thả lên hàng đầu của danh mục)", () => {
    expect(
      resolveDrop([category, a, b, inside, inside2], a, {
        kind: "row",
        channel: inside,
        zone: "before",
      }),
    ).toEqual({ parentId: "c1", position: 0 });
  });

  it("kéo ra khỏi danh mục về gốc", () => {
    // "sau b" trong nhóm gốc = chỉ số 2 (a, b rồi tới nó).
    expect(
      resolveDrop([category, a, b, inside, inside2], inside, {
        kind: "row",
        channel: b,
        zone: "after",
      }),
    ).toEqual({ parentId: null, position: 2 });
  });

  it("thả lên tiêu đề danh mục: nửa trên = đầu, nửa dưới = cuối", () => {
    const list = [category, a, inside, inside2];
    expect(resolveDrop(list, a, { kind: "category", categoryId: "c1", zone: "before" })).toEqual({
      parentId: "c1",
      position: 0,
    });
    expect(resolveDrop(list, a, { kind: "category", categoryId: "c1", zone: "after" })).toEqual({
      parentId: "c1",
      position: 2,
    });
  });

  it("thả vào danh mục rỗng (vùng nhóm) → position 0", () => {
    const empty = channel({ id: "c2", type: "category", position: 1 });
    expect(resolveDrop([category, empty, a], a, { kind: "group", groupId: "c2" })).toEqual({
      parentId: "c2",
      position: 0,
    });
  });

  it("thả vào vùng gốc → cuối danh sách gốc, không đếm chính nó", () => {
    expect(resolveDrop([category, a, b], a, { kind: "group", groupId: "root" })).toEqual({
      parentId: null,
      position: 1,
    });
  });

  it("đích không còn tồn tại (danh sách vừa đổi) → null, không ném lỗi", () => {
    expect(
      resolveDrop([category, a], a, { kind: "row", channel: channel({ id: "zz" }), zone: "before" }),
    ).toBeNull();
    expect(
      resolveDrop([category, a], a, { kind: "category", categoryId: "khong-co", zone: "after" }),
    ).toBeNull();
  });
});

describe("resolveDrop — danh mục", () => {
  const other = channel({ id: "c2", type: "category", position: 1 });
  const a = channel({ id: "a", position: 0 });

  it("đổi thứ tự giữa hai danh mục", () => {
    expect(
      resolveDrop([category, other, a], other, {
        kind: "category",
        categoryId: "c1",
        zone: "before",
      }),
    ).toEqual({ parentId: null, position: 0 });
    expect(
      resolveDrop([category, other, a], category, {
        kind: "category",
        categoryId: "c2",
        zone: "after",
      }),
    ).toEqual({ parentId: null, position: 1 });
  });

  it("thả danh mục lên một hàng kênh → rơi về đúng chỗ của danh mục chứa hàng đó", () => {
    const inside = channel({ id: "in", position: 0, categoryId: "c2" });
    // Nửa trên hàng → trước danh mục chứa nó (c2 đang ở chỉ số 0 sau khi bỏ c1).
    expect(
      resolveDrop([category, other, inside], category, {
        kind: "row",
        channel: inside,
        zone: "before",
      }),
    ).toEqual({ parentId: null, position: 0 });
    // Nửa dưới hàng → sau danh mục đó.
    expect(
      resolveDrop([category, other, inside], category, {
        kind: "row",
        channel: inside,
        zone: "after",
      }),
    ).toEqual({ parentId: null, position: 1 });
  });

  it("danh mục không bao giờ lồng trong danh mục: thả vào vùng nhóm vẫn ở gốc", () => {
    expect(resolveDrop([category, other, a], category, { kind: "group", groupId: "c2" })).toEqual({
      parentId: null,
      position: 1,
    });
  });
});
