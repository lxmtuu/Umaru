import type { Embed, Snowflake } from "@umaru/protocol";
import type { Pool } from "../db.js";
import type { EventPublisher } from "../events.js";
import { firstUrl, parseEmbedHtml, type ParsedEmbed } from "./extract.js";
import { fetchHtml, type FetchHtmlOptions } from "./fetch.js";
import { deleteEmbed, saveEmbed } from "./store.js";

/**
 * Dựng embed xem trước cho tin nhắn mới.
 *
 * Vì sao **không** `await` ở đường gửi tin: một trang bên ngoài chậm 3 giây không
 * được làm tin nhắn chậm 3 giây. Tin hiện ra ngay, embed tới sau bằng
 * `MESSAGE_UPDATE` — đúng cách Discord làm.
 *
 * Hàng đợi có trần đồng thời để vài chục tin chứa link không mở vài chục kết nối
 * ra ngoài cùng lúc. Cache theo URL (10 phút) vì cùng một link hay được dán lại.
 */

type FetchFn = (url: string, options: FetchHtmlOptions) => Promise<{ html: string; finalUrl: string }>;

export interface EmbedResolverOptions {
  /** Chừa chỗ bơm hàm tải giả trong test. */
  fetch?: FetchFn;
  /** Trần số tác vụ chạy cùng lúc. */
  concurrency?: number;
  /** Số URL giữ trong cache. */
  cacheSize?: number;
}

export interface EmbedConfig {
  enabled: boolean;
  allowPrivateHosts: boolean;
  timeoutMs: number;
  maxBytes: number;
}

interface Task {
  messageId: string;
  channelId: string;
  url: string;
}

export class LinkEmbedResolver {
  private readonly queue: Task[] = [];
  private readonly cache = new Map<string, ParsedEmbed | null>();
  private readonly fetchImpl: FetchFn;
  private readonly concurrency: number;
  private readonly cacheSize: number;
  private active = 0;
  private idleWaiters: Array<() => void> = [];
  private closed = false;

  constructor(
    private readonly deps: { pool: Pool; publisher: EventPublisher; config: EmbedConfig },
    options: EmbedResolverOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetchHtml;
    this.concurrency = options.concurrency ?? 3;
    this.cacheSize = options.cacheSize ?? 500;
  }

  /**
   * Xếp hàng lấy embed cho tin vừa tạo. Không trả promise: lỗi mạng chỉ làm tin
   * không có thẻ, không bao giờ làm hỏng việc gửi tin.
   */
  enqueue(messageId: string, channelId: string, content: string): void {
    if (!this.deps.config.enabled || this.closed) return;
    const url = firstUrl(content);
    if (url === null) return;
    this.queue.push({ messageId, channelId, url });
    this.pump();
  }

  /**
   * Sửa tin: embed cũ có thể sai (đổi link) nên xoá và dựng lại. Client nhận
   * `MESSAGE_UPDATE` với `embeds: []` trước để thẻ cũ biến mất ngay.
   */
  async refresh(messageId: string, channelId: string, content: string): Promise<void> {
    await deleteEmbed(this.deps.pool, messageId);
    this.deps.publisher.publishToChannel(channelId, "MESSAGE_UPDATE", {
      id: messageId as Snowflake,
      channelId: channelId as Snowflake,
      embeds: [],
    });
    this.enqueue(messageId, channelId, content);
  }

  /** Chờ hàng đợi rỗng — chỉ dùng trong test. */
  async whenIdle(): Promise<void> {
    if (this.queue.length === 0 && this.active === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
  }

  private pump(): void {
    while (!this.closed && this.active < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift() as Task;
      this.active += 1;
      void this.run(task).finally(() => {
        this.active -= 1;
        if (this.active === 0 && this.queue.length === 0) {
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          for (const resolve of waiters) resolve();
        } else {
          this.pump();
        }
      });
    }
  }

  private async run(task: Task): Promise<void> {
    try {
      const embed = await this.resolve(task.url);
      if (embed === null || this.closed) return;
      await saveEmbed(this.deps.pool, task.messageId, embed);
      this.deps.publisher.publishToChannel(task.channelId, "MESSAGE_UPDATE", {
        id: task.messageId as Snowflake,
        channelId: task.channelId as Snowflake,
        embeds: [embed],
      });
    } catch {
      // Trang chết, DNS hỏng, bị chặn SSRF… đều chỉ có nghĩa "tin này không có
      // thẻ". Không log ồn ào: nội dung do người dùng nhập nên đây là đường
      // bình thường, không phải sự cố của server.
    }
  }

  private async resolve(url: string): Promise<Embed | null> {
    const cached = this.cache.get(url);
    if (cached !== undefined) return cached;

    let parsed: ParsedEmbed | null = null;
    try {
      const page = await this.fetchImpl(url, {
        timeoutMs: this.deps.config.timeoutMs,
        maxBytes: this.deps.config.maxBytes,
        allowPrivateHosts: this.deps.config.allowPrivateHosts,
      });
      // `finalUrl` chứ không phải `url`: `og:image` tương đối phải ghép với URL
      // sau redirect, nếu không ảnh ra 404.
      parsed = parseEmbedHtml(page.html, page.finalUrl);
      if (parsed !== null) parsed = { ...parsed, url };
    } catch {
      parsed = null;
    }
    this.remember(url, parsed);
    return parsed;
  }

  private remember(url: string, embed: ParsedEmbed | null): void {
    if (this.cache.size >= this.cacheSize) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(url, embed);
  }
}
