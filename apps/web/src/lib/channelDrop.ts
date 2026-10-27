import type { Channel } from "@umaru/protocol";

/**
 * Tính đích thả cho kéo-thả kênh trong sidebar.
 *
 * Tách khỏi component để test được: đây là chỗ dễ sai nhất của kéo-thả (vị trí
 * đếm trong nhóm anh em, category không lồng nhau, thả vào danh mục rỗng) và
 * sai ở đây thì server renumber sai cả dãy kênh.
 */

/** Đích thả khi kéo-thả trong sidebar: hàng kênh, tiêu đề danh mục, hoặc vùng trống của một nhóm. */
export type DropTarget =
  | { kind: "row"; channel: Channel; zone: "before" | "after" }
  | { kind: "category"; categoryId: string; zone: "before" | "after" }
  | { kind: "group"; groupId: string };

/**
 * Tính `(parentId, position)` cho lần thả — `position` là chỉ số trong nhóm kênh cùng
 * category, không tính chính kênh đang kéo (server cũng tính như vậy rồi renumber lại).
 * Không hợp lệ (thả danh mục vào danh mục khác, không tìm thấy đích…) → `null`.
 */
export function resolveDrop(
  channels: Channel[],
  dragged: Channel,
  target: DropTarget,
): { parentId: string | null; position: number } | null {
  const byPosition = (a: Channel, b: Channel): number => a.position - b.position;
  const categories = channels.filter((channel) => channel.type === "category").sort(byPosition);

  if (dragged.type === "category") {
    // Category không được lồng trong category → luôn xếp ở gốc, giữa các category.
    const others = categories.filter((channel) => channel.id !== dragged.id);
    if (target.kind === "category") {
      const at = others.findIndex((channel) => channel.id === target.categoryId);
      if (at < 0) return null;
      return { parentId: null, position: target.zone === "after" ? at + 1 : at };
    }
    if (target.kind === "row") {
      const ownerId = target.channel.categoryId;
      if (ownerId === null) return { parentId: null, position: others.length };
      const at = others.findIndex((channel) => channel.id === ownerId);
      if (at < 0) return null;
      return { parentId: null, position: target.zone === "after" ? at + 1 : at };
    }
    if (target.groupId === "root") return { parentId: null, position: others.length };
    const at = others.findIndex((channel) => channel.id === target.groupId);
    if (at < 0) return null;
    return { parentId: null, position: at + 1 };
  }

  const siblingsOf = (parentId: string | null): Channel[] =>
    channels
      .filter(
        (channel) =>
          channel.type !== "category" &&
          channel.categoryId === parentId &&
          channel.id !== dragged.id,
      )
      .sort(byPosition);

  if (target.kind === "row") {
    const parentId = target.channel.categoryId;
    const siblings = siblingsOf(parentId);
    const at = siblings.findIndex((channel) => channel.id === target.channel.id);
    if (at < 0) return null;
    return { parentId, position: target.zone === "after" ? at + 1 : at };
  }
  if (target.kind === "category") {
    // Danh mục vừa bị xoá (danh sách đổi giữa lúc kéo) → bỏ, đừng gửi `parentId`
    // trỏ vào id không tồn tại.
    if (!categories.some((channel) => channel.id === target.categoryId)) return null;
    // Thả lên tiêu đề danh mục: nửa trên = đầu danh mục, nửa dưới = cuối danh mục.
    const siblings = siblingsOf(target.categoryId);
    return {
      parentId: target.categoryId,
      position: target.zone === "after" ? siblings.length : 0,
    };
  }
  const parentId = target.groupId === "root" ? null : target.groupId;
  return { parentId, position: siblingsOf(parentId).length };
}

