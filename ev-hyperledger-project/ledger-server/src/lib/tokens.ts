import crypto from "crypto";

//generate a secure random resume token
export function generateResumeToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

//hash a token using SHA-256
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
