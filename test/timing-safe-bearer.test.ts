/**
 * v4.12.2 — Timing-safe bearer token comparison.
 *
 * The webhook auth check at src/web/server.ts:127 previously used naive
 * string equality on the Authorization header. That's vulnerable (in
 * principle) to timing side-channel attacks where an attacker measures
 * response times to leak the token character by character.
 *
 * Real-world exploitability over network is low due to jitter, but
 * crypto.timingSafeEqual is the right tool regardless.
 *
 * This test covers the pure helper; the integration is in server.ts.
 */
import { describe, it, expect } from "vitest";
import { timingSafeBearerMatch } from "../src/services/timing-safe-bearer.js";

describe("timing-safe bearer token comparison (v4.12.2)", () => {
  it("matches a correct token", () => {
    expect(timingSafeBearerMatch("Bearer abc123xyz", "abc123xyz")).toBe(true);
  });

  it("rejects an incorrect token", () => {
    expect(timingSafeBearerMatch("Bearer wrong", "abc123xyz")).toBe(false);
  });

  it("rejects when Bearer prefix is missing", () => {
    expect(timingSafeBearerMatch("abc123xyz", "abc123xyz")).toBe(false);
  });

  it("rejects when auth header is empty", () => {
    expect(timingSafeBearerMatch("", "abc123xyz")).toBe(false);
  });

  it("rejects when auth header is undefined", () => {
    expect(timingSafeBearerMatch(undefined, "abc123xyz")).toBe(false);
  });

  it("rejects when expected token is empty (prevents accidental auth bypass)", () => {
    expect(timingSafeBearerMatch("Bearer anything", "")).toBe(false);
    expect(timingSafeBearerMatch("Bearer ", "")).toBe(false);
    expect(timingSafeBearerMatch("", "")).toBe(false);
  });

  it("rejects tokens of different lengths without revealing prefix match", () => {
    expect(timingSafeBearerMatch("Bearer abc", "abcdefg")).toBe(false);
    expect(timingSafeBearerMatch("Bearer abcdefg", "abc")).toBe(false);
  });

  it("handles unicode tokens (not that we'd use them, but correctness)", () => {
    expect(timingSafeBearerMatch("Bearer 🔒xyz", "🔒xyz")).toBe(true);
    expect(timingSafeBearerMatch("Bearer 🔒xyz", "🔒xYz")).toBe(false);
  });

  it("case-sensitive comparison (tokens are opaque)", () => {
    expect(timingSafeBearerMatch("Bearer AbCdEf", "abcdef")).toBe(false);
    expect(timingSafeBearerMatch("Bearer AbCdEf", "AbCdEf")).toBe(true);
  });

  it("rejects Bearer with leading/trailing whitespace mismatches the expected format", () => {
    // RFC 6750 says: Authorization: Bearer <token>
    // Exactly one space between "Bearer" and the token.
    expect(timingSafeBearerMatch("Bearer  abc", "abc")).toBe(false); // double space
    expect(timingSafeBearerMatch(" Bearer abc", "abc")).toBe(false); // leading space
  });
});
