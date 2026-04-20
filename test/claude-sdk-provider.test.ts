import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process BEFORE importing the provider, so the provider's
// top-level `promisify(execFile)` binds to our mock.
const execFileMock = vi.fn();
vi.mock("child_process", () => ({
  execFile: (
    path: string,
    args: string[],
    opts: unknown,
    cb: (err: Error | null, stdout: { stdout: string; stderr: string }) => void,
  ) => {
    execFileMock(path, args, opts, cb);
  },
}));

// Stub findClaudeBinary to return a fake path — we don't want real FS
vi.mock("../src/find-claude-binary.js", () => ({
  findClaudeBinary: () => "/fake/claude",
}));

describe("ClaudeSDKProvider.isAvailable", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    vi.resetModules();
  });

  it("returns true when `claude auth status` reports loggedIn: true", async () => {
    // Sequence: --version then auth status (JSON)
    execFileMock
      .mockImplementationOnce((_p, _a, _o, cb) =>
        cb(null, { stdout: "1.0.0\n", stderr: "" }),
      )
      .mockImplementationOnce((_p, _a, _o, cb) =>
        cb(null, {
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: "claude.ai",
            subscriptionType: "max",
          }),
          stderr: "",
        }),
      );

    const { ClaudeSDKProvider } = await import("../src/providers/claude-sdk-provider.js");
    const p = new ClaudeSDKProvider();
    const result = await p.isAvailable();
    expect(result).toBe(true);
  });

  it("returns false when `claude auth status` reports loggedIn: false", async () => {
    execFileMock
      .mockImplementationOnce((_p, _a, _o, cb) =>
        cb(null, { stdout: "1.0.0\n", stderr: "" }),
      )
      .mockImplementationOnce((_p, _a, _o, cb) =>
        cb(null, {
          stdout: JSON.stringify({ loggedIn: false }),
          stderr: "",
        }),
      );

    const { ClaudeSDKProvider } = await import("../src/providers/claude-sdk-provider.js");
    const p = new ClaudeSDKProvider();
    const result = await p.isAvailable();
    expect(result).toBe(false);
  });

  it("falls back to `claude -p` probe when `auth status` fails (older CLI)", async () => {
    // Sequence: --version → auth status rejects → -p ping succeeds
    execFileMock
      .mockImplementationOnce((_p, _a, _o, cb) =>
        cb(null, { stdout: "1.0.0\n", stderr: "" }),
      )
      .mockImplementationOnce((_p, _a, _o, cb) =>
        cb(new Error("unknown command: auth status"), { stdout: "", stderr: "" }),
      )
      .mockImplementationOnce((_p, _a, _o, cb) =>
        cb(null, { stdout: "pong", stderr: "" }),
      );

    const { ClaudeSDKProvider } = await import("../src/providers/claude-sdk-provider.js");
    const p = new ClaudeSDKProvider();
    const result = await p.isAvailable();
    expect(result).toBe(true);
  });

  it("falls back to `claude -p` probe and detects 'Not logged in' text", async () => {
    execFileMock
      .mockImplementationOnce((_p, _a, _o, cb) =>
        cb(null, { stdout: "1.0.0\n", stderr: "" }),
      )
      .mockImplementationOnce((_p, _a, _o, cb) =>
        cb(new Error("auth status not supported"), { stdout: "", stderr: "" }),
      )
      .mockImplementationOnce((_p, _a, _o, cb) =>
        cb(null, { stdout: "Not logged in · Please run /login", stderr: "" }),
      );

    const { ClaudeSDKProvider } = await import("../src/providers/claude-sdk-provider.js");
    const p = new ClaudeSDKProvider();
    const result = await p.isAvailable();
    expect(result).toBe(false);
  });
});

describe("ClaudeSDKProvider — isAuthErrorOutput helper", () => {
  it("detects 'Not logged in' text as auth error", async () => {
    const { isAuthErrorOutput } = await import("../src/providers/claude-sdk-provider.js");
    expect(isAuthErrorOutput("Not logged in · Please run /login")).toBe(true);
    expect(isAuthErrorOutput("   not logged in · Please run /login  ")).toBe(true);
    expect(isAuthErrorOutput("Hello! Here is the result")).toBe(false);
    expect(isAuthErrorOutput("")).toBe(false);
  });
});
