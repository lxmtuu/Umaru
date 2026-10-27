import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "./config.js";

/**
 * Lớp gửi mail tối giản.
 *
 * `SMTP_URL` trống → dùng `LogMailer`: nội dung mail ghi ra log của server
 * (dev tự bấm được link, không cần dựng SMTP). Có `SMTP_URL` → SMTP thật.
 * Interface nhỏ để test thay bằng hộp thư trong bộ nhớ.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Ghi mail ra log — dùng ở dev/test và khi chưa cấu hình SMTP. */
export class LogMailer implements Mailer {
  constructor(private readonly write: (line: string) => void) {}

  async send(message: MailMessage): Promise<void> {
    this.write(
      `[mail] tới=${message.to} tiêu đề="${message.subject}"\n---\n${message.text}\n---`,
    );
  }
}

/** Hộp thư trong bộ nhớ — chỉ dùng cho test. */
export class MemoryMailer implements Mailer {
  readonly outbox: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.outbox.push(message);
  }

  /** Mail gần nhất gửi tới địa chỉ này (không phân biệt hoa/thường). */
  lastTo(address: string): MailMessage | undefined {
    const needle = address.toLowerCase();
    for (let index = this.outbox.length - 1; index >= 0; index -= 1) {
      if (this.outbox[index]!.to.toLowerCase() === needle) return this.outbox[index];
    }
    return undefined;
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

export function createMailer(config: Config, write: (line: string) => void): Mailer {
  if (config.smtpUrl !== null && config.smtpUrl.length > 0) {
    return new SmtpMailer(config.smtpUrl, config.mailFrom);
  }
  return new LogMailer(write);
}
