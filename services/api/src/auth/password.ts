import { hash, verify } from "@node-rs/argon2";

/** argon2id — tham số mặc định của OWASP (19 MiB, t=2, p=1). */
export function hashPassword(password: string): Promise<string> {
  return hash(password, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // hash hỏng/không đúng định dạng → coi như sai mật khẩu, không lộ chi tiết
    return false;
  }
}
