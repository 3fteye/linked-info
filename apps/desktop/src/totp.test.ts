import { describe, expect, it } from "vitest";
import {
  generateTotp,
  parseTotpDirectiveLine,
  totpRemainingSeconds,
  type TotpAlgorithm,
  type TotpConfiguration,
} from "./totp";

function rfcConfiguration(
  algorithm: TotpAlgorithm,
  secret: string,
): TotpConfiguration {
  return {
    algorithm,
    digits: 8,
    period: 30,
    secret: new TextEncoder().encode(secret),
  };
}

describe("TOTP", () => {
  it("accepts an explicit prefix, lowercase Base32, grouped spaces, and a full-width colon", () => {
    const directive = parseTotpDirectiveLine(" TOTP ： jbsw y3dp ehpk 3pxp ");

    expect(directive?.valid).toBe(true);
    if (directive?.valid) {
      expect(directive.configuration).toMatchObject({
        algorithm: "SHA-1",
        digits: 6,
        period: 30,
      });
      expect(directive.configuration.secret.length).toBeGreaterThan(0);
    }
  });

  it("parses standard otpauth parameters and rejects ambiguous or invalid lines", () => {
    const directive = parseTotpDirectiveLine(
      "TOTP: otpauth://totp/Example?secret=jbswy3dpehpk3pxp&algorithm=SHA256&digits=8&period=45",
    );

    expect(directive?.valid).toBe(true);
    if (directive?.valid) {
      expect(directive.configuration).toMatchObject({
        algorithm: "SHA-256",
        digits: 8,
        period: 45,
      });
    }
    expect(parseTotpDirectiveLine("jbsw y3dp ehpk 3pxp")).toBeNull();
    expect(parseTotpDirectiveLine("优惠码：JBSWY3DPEHPK3PXP")).toBeNull();
    expect(parseTotpDirectiveLine("TOTP: not-a-base32-secret")).toEqual({
      valid: false,
    });
  });

  it("matches the RFC 6238 SHA-1, SHA-256, and SHA-512 vectors", async () => {
    await expect(
      generateTotp(
        rfcConfiguration("SHA-1", "12345678901234567890"),
        59_000,
      ),
    ).resolves.toBe("94287082");
    await expect(
      generateTotp(
        rfcConfiguration("SHA-256", "12345678901234567890123456789012"),
        59_000,
      ),
    ).resolves.toBe("46119246");
    await expect(
      generateTotp(
        rfcConfiguration(
          "SHA-512",
          "1234567890123456789012345678901234567890123456789012345678901234",
        ),
        59_000,
      ),
    ).resolves.toBe("90693936");
  });

  it("reports the remaining time in the active period", () => {
    expect(totpRemainingSeconds(30, 59_000)).toBe(1);
    expect(totpRemainingSeconds(30, 60_000)).toBe(30);
  });
});
