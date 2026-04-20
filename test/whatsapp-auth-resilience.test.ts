/**
 * Fix #2 — WhatsApp saveCreds must survive a vanished auth directory.
 *
 * Regression: `Unhandled rejection: ENOENT creds.json` in err.log when
 * baileys fired a delayed `creds.update` event after the auth dir was
 * gone (crash mid-init, trash, manual cleanup, etc.).
 *
 * Contract: we export a helper `makeResilientSaveCreds(authDir, inner)`
 * from src/platforms/whatsapp-auth-helpers.ts. It wraps baileys' raw
 * saveCreds so that an ENOENT triggers a mkdir-p + one retry before
 * surfacing the error. Any other error bubbles up unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import { resolve, join } from "path";
import { makeResilientSaveCreds } from "../src/platforms/whatsapp-auth-helpers.js";

let authDir: string;

beforeEach(() => {
  authDir = resolve(os.tmpdir(), `alvin-wa-auth-${process.pid}-${Date.now()}`);
  fs.mkdirSync(authDir, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
});

describe("makeResilientSaveCreds (Fix #2)", () => {
  it("calls the inner saveCreds on the happy path", async () => {
    let calls = 0;
    const inner = async () => { calls++; };
    const wrapped = makeResilientSaveCreds(authDir, inner);
    await wrapped();
    expect(calls).toBe(1);
  });

  it("recreates the auth dir and retries when inner throws ENOENT", async () => {
    let calls = 0;
    const inner = async () => {
      calls++;
      if (calls === 1) {
        // Mirror baileys fs.promises.writeFile behaviour
        const err = new Error(
          `ENOENT: no such file or directory, open '${join(authDir, "creds.json")}'`,
        ) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
    };
    // Simulate the vanished dir
    fs.rmSync(authDir, { recursive: true, force: true });
    expect(fs.existsSync(authDir)).toBe(false);

    const wrapped = makeResilientSaveCreds(authDir, inner);
    await wrapped();

    expect(calls).toBe(2);
    expect(fs.existsSync(authDir)).toBe(true);
  });

  it("only retries once — a second ENOENT surfaces as error", async () => {
    let calls = 0;
    const inner = async () => {
      calls++;
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    const wrapped = makeResilientSaveCreds(authDir, inner);
    await expect(wrapped()).rejects.toThrow(/ENOENT/);
    expect(calls).toBe(2);
  });

  it("surfaces non-ENOENT errors unchanged", async () => {
    const inner = async () => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    };
    const wrapped = makeResilientSaveCreds(authDir, inner);
    await expect(wrapped()).rejects.toThrow(/EACCES/);
  });

  it("is safe to call concurrently", async () => {
    let calls = 0;
    const inner = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
    };
    const wrapped = makeResilientSaveCreds(authDir, inner);
    await Promise.all([wrapped(), wrapped(), wrapped()]);
    expect(calls).toBe(3);
  });
});
