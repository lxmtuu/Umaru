import type { FastifyInstance } from "fastify";

export class HttpError extends Error {
  override readonly name = "HttpError";
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, "BAD_REQUEST", message);
export const unauthorized = (message = "Cần đăng nhập") =>
  new HttpError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "Không có quyền") =>
  new HttpError(403, "FORBIDDEN", message);
export const notFound = (message = "Không tìm thấy") =>
  new HttpError(404, "NOT_FOUND", message);
export const conflict = (message: string) => new HttpError(409, "CONFLICT", message);
export const tooManyRequests = (message: string) =>
  new HttpError(429, "TOO_MANY_REQUESTS", message);
export const serviceUnavailable = (message: string) =>
  new HttpError(503, "SERVICE_UNAVAILABLE", message);

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    const known = error as { statusCode?: number; message?: string };
    const status = known.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({
        error: { code: "BAD_REQUEST", message: known.message ?? "Yêu cầu không hợp lệ" },
      });
    }
    app.log.error(error);
    return reply
      .code(500)
      .send({ error: { code: "INTERNAL", message: "Lỗi hệ thống" } });
  });
}

export function readString(
  body: Record<string, unknown> | undefined,
  field: string,
  options: { min?: number; max?: number; trim?: boolean } = {},
): string {
  const raw = body?.[field];
  if (typeof raw !== "string") throw badRequest(`Thiếu trường "${field}"`);
  const value = options.trim === false ? raw : raw.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 1000;
  const length = [...value].length;
  if (length < min || length > max) {
    throw badRequest(`"${field}" phải dài ${min}–${max} ký tự`);
  }
  return value;
}

export function readOptionalString(
  body: Record<string, unknown> | undefined,
  field: string,
  options: { max?: number } = {},
): string | null {
  const raw = body?.[field];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw badRequest(`"${field}" phải là chuỗi`);
  const value = raw.trim();
  if (value.length === 0) return null;
  if ([...value].length > (options.max ?? 1024)) {
    throw badRequest(`"${field}" quá dài`);
  }
  return value;
}

export function readId(body: Record<string, unknown> | undefined, field: string): string | null {
  const raw = body?.[field];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || !/^\d{1,20}$/.test(raw)) {
    throw badRequest(`"${field}" phải là snowflake (chuỗi số)`);
  }
  return raw;
}

export function readLimit(raw: unknown, fallback: number, max = 100): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw badRequest(`limit phải là số nguyên 1–${max}`);
  }
  return value;
}
