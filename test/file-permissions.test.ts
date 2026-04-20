/**
 * v4.12.2 — File permissions hardening.
 *
 * Sensitive files (.env, sessions.json, memory files) must be chmod 0o600
 * so that on multi-user Dev-Server installations, other users on the same
 * machine can't read Alvin's secrets or conversation history.
 *
 * This module provides pure helpers for ensuring files get 0o600 on write,
 * plus a startup repair routine that fixes permissions on existing files.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import { resolve } from "path";
import { ensureSecureMode, writeSecure, auditSensitiveFiles } from "../src/services/file-permissions.js";

const TEST_DIR = resolve(os.tmpdir(), `alvin-fileperm-${process.pid}-${Date.now()}`);

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("file-permissions (v4.12.2)", () => {
  describe("writeSecure", () => {
    it("creates a file with mode 0o600", () => {
      const file = resolve(TEST_DIR, "secret.txt");
      writeSecure(file, "sensitive content");
      const mode = fs.statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(fs.readFileSync(file, "utf-8")).toBe("sensitive content");
    });

    it("overwrites an existing file and enforces mode 0o600 even if it was 0o644", () => {
      const file = resolve(TEST_DIR, "existing.txt");
      fs.writeFileSync(file, "old content", "utf-8");
      fs.chmodSync(file, 0o644);

      writeSecure(file, "new content");

      const mode = fs.statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(fs.readFileSync(file, "utf-8")).toBe("new content");
    });

    it("accepts Buffer content", () => {
      const file = resolve(TEST_DIR, "buf.bin");
      writeSecure(file, Buffer.from([1, 2, 3]));
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });
  });

  describe("ensureSecureMode", () => {
    it("returns 'already-secure' when file is already 0o600", () => {
      const file = resolve(TEST_DIR, "f.txt");
      fs.writeFileSync(file, "x");
      fs.chmodSync(file, 0o600);
      const result = ensureSecureMode(file);
      expect(result.status).toBe("already-secure");
    });

    it("repairs a file that is too permissive (0o644 → 0o600)", () => {
      const file = resolve(TEST_DIR, "f.txt");
      fs.writeFileSync(file, "x");
      fs.chmodSync(file, 0o644);
      const result = ensureSecureMode(file);
      expect(result.status).toBe("repaired");
      expect(result.previousMode).toBe("644");
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it("returns 'missing' for a nonexistent file without erroring", () => {
      const result = ensureSecureMode(resolve(TEST_DIR, "nope.txt"));
      expect(result.status).toBe("missing");
    });

    it("is idempotent: calling twice on a 0o644 file still ends at 0o600", () => {
      const file = resolve(TEST_DIR, "f.txt");
      fs.writeFileSync(file, "x");
      fs.chmodSync(file, 0o644);
      ensureSecureMode(file);
      const second = ensureSecureMode(file);
      expect(second.status).toBe("already-secure");
    });

    it("does NOT try to loosen a stricter-than-needed mode (e.g. 0o400)", () => {
      const file = resolve(TEST_DIR, "f.txt");
      fs.writeFileSync(file, "x");
      fs.chmodSync(file, 0o400);
      const result = ensureSecureMode(file);
      expect(result.status).toBe("already-secure");
      expect(fs.statSync(file).mode & 0o777).toBe(0o400);
    });
  });

  describe("auditSensitiveFiles", () => {
    it("reports a list of files checked and their status", () => {
      const envFile = resolve(TEST_DIR, ".env");
      const stateFile = resolve(TEST_DIR, "sessions.json");
      fs.writeFileSync(envFile, "SECRET=1");
      fs.chmodSync(envFile, 0o644); // insecure
      fs.writeFileSync(stateFile, "{}");
      fs.chmodSync(stateFile, 0o600); // secure

      const report = auditSensitiveFiles([envFile, stateFile]);
      expect(report).toHaveLength(2);

      const env = report.find(r => r.path === envFile);
      const state = report.find(r => r.path === stateFile);
      expect(env!.status).toBe("repaired");
      expect(state!.status).toBe("already-secure");

      expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    });

    it("skips nonexistent files gracefully", () => {
      const report = auditSensitiveFiles([
        resolve(TEST_DIR, "nope.env"),
        resolve(TEST_DIR, "also-nope.json"),
      ]);
      expect(report).toHaveLength(2);
      expect(report[0].status).toBe("missing");
      expect(report[1].status).toBe("missing");
    });
  });
});
