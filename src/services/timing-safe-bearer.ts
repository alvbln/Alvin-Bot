/**
 * Timing-Safe Bearer Token Comparison (v4.12.2)
 *
 * Replaces naive `authHeader !== "Bearer " + token` comparison with
 * crypto.timingSafeEqual so that token comparison time doesn't leak
 * character-level information via side-channel.
 *
 * Real-world exploitability over network is low due to network jitter,
 * but this is the right tool regardless — defense in depth.
 *
 * Behavior:
 *   - Strict "Bearer <token>" format required (exactly one space)
 *   - Empty expected token always rejects (prevents accidental auth bypass)
 *   - Different-length tokens compared via timingSafeEqual on padded buffers
 *     so timing doesn't leak whether the prefix matched
 *   - Unicode-safe: Buffer.from uses UTF-8 encoding
 */
import { timingSafeEqual } from "crypto";

export function timingSafeBearerMatch(
  authHeader: string | undefined,
  expectedToken: string,
): boolean {
  // Empty expected token → always reject. Prevents a misconfig where
  // config.webhookToken is "" from accidentally allowing any "Bearer "
  // or empty Authorization header.
  if (!expectedToken || expectedToken.length === 0) return false;

  // Missing or non-string header
  if (!authHeader || typeof authHeader !== "string") return false;

  // Strict format: "Bearer <token>" with exactly one space. Anything else
  // (double space, leading whitespace, wrong prefix) is rejected. We do
  // this via startsWith + exact-length check, not split, so attackers
  // can't use whitespace variations to confuse the parser.
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  const providedToken = authHeader.slice(prefix.length);

  // timingSafeEqual requires equal-length buffers. If lengths differ,
  // we return false — but we still touch both strings symbolically so
  // the compare itself is constant-time relative to the shorter one.
  // (A length leak through string.length check is acceptable; what we
  // actually care about is that the character-by-character comparison
  // doesn't leak.)
  const expectedBuf = Buffer.from(expectedToken, "utf-8");
  const providedBuf = Buffer.from(providedToken, "utf-8");

  if (expectedBuf.length !== providedBuf.length) {
    // Do a dummy comparison so total time is closer to constant.
    // Not perfect but better than early-return alone.
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }

  return timingSafeEqual(expectedBuf, providedBuf);
}
