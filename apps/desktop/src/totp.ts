export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

export interface TotpConfiguration {
  algorithm: TotpAlgorithm;
  digits: 6 | 8;
  period: number;
  secret: Uint8Array;
}

export type TotpDirective =
  | { configuration: TotpConfiguration; valid: true }
  | { valid: false };

const totpDirectivePattern = /^\s*totp\s*[:：]\s*(.*?)\s*$/iu;
const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(value: string): Uint8Array | null {
  const normalized = value.replace(/\s/gu, "").toUpperCase();
  if (normalized.length === 0 || !/^[A-Z2-7]+=*$/u.test(normalized)) {
    return null;
  }
  const unpadded = normalized.replace(/=+$/u, "");
  if (unpadded.length === 0) {
    return null;
  }

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of unpadded) {
    const digit = base32Alphabet.indexOf(character);
    if (digit < 0) {
      return null;
    }
    buffer = (buffer << 5) | digit;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= bits === 0 ? 0 : (1 << bits) - 1;
    }
  }
  if (bits > 0 && buffer !== 0) {
    return null;
  }
  return bytes.length === 0 ? null : Uint8Array.from(bytes);
}

function parsePositiveInteger(value: string | null, fallback: number): number | null {
  if (value === null) {
    return fallback;
  }
  if (!/^\d+$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseAlgorithm(value: string | null): TotpAlgorithm | null {
  const normalized = (value ?? "SHA1").replace(/-/gu, "").toUpperCase();
  if (normalized === "SHA1") {
    return "SHA-1";
  }
  if (normalized === "SHA256") {
    return "SHA-256";
  }
  if (normalized === "SHA512") {
    return "SHA-512";
  }
  return null;
}

export function parseTotpPayload(value: string): TotpConfiguration | null {
  const trimmedValue = value.trim();
  let secretText = trimmedValue;
  let algorithm: TotpAlgorithm = "SHA-1";
  let digits: 6 | 8 = 6;
  let period = 30;

  if (/^otpauth:\/\//iu.test(trimmedValue)) {
    let uri: URL;
    try {
      uri = new URL(trimmedValue);
    } catch {
      return null;
    }
    if (uri.protocol !== "otpauth:" || uri.hostname.toLowerCase() !== "totp") {
      return null;
    }
    secretText = uri.searchParams.get("secret") ?? "";
    const parsedAlgorithm = parseAlgorithm(uri.searchParams.get("algorithm"));
    const parsedDigits = parsePositiveInteger(uri.searchParams.get("digits"), 6);
    const parsedPeriod = parsePositiveInteger(uri.searchParams.get("period"), 30);
    if (
      parsedAlgorithm === null ||
      (parsedDigits !== 6 && parsedDigits !== 8) ||
      parsedPeriod === null ||
      parsedPeriod > 300
    ) {
      return null;
    }
    algorithm = parsedAlgorithm;
    digits = parsedDigits;
    period = parsedPeriod;
  }

  const secret = decodeBase32(secretText);
  return secret === null ? null : { algorithm, digits, period, secret };
}

export function parseTotpDirectiveLine(line: string): TotpDirective | null {
  const match = totpDirectivePattern.exec(line);
  if (match === null) {
    return null;
  }
  const configuration = parseTotpPayload(match[1]);
  return configuration === null
    ? { valid: false }
    : { configuration, valid: true };
}

function counterBytes(counter: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let remaining = counter;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

export async function generateTotp(
  configuration: TotpConfiguration,
  timestampMs: number,
): Promise<string> {
  if (!Number.isFinite(timestampMs) || timestampMs < 0) {
    throw new Error("invalid TOTP timestamp");
  }
  const counter = BigInt(
    Math.floor(timestampMs / 1_000 / configuration.period),
  );
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    configuration.secret,
    { hash: configuration.algorithm, name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.sign("HMAC", key, counterBytes(counter)),
  );
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return (binary % 10 ** configuration.digits)
    .toString()
    .padStart(configuration.digits, "0");
}

export function totpRemainingSeconds(period: number, timestampMs: number): number {
  const elapsedSeconds = Math.floor(timestampMs / 1_000);
  return period - (elapsedSeconds % period);
}
