/**
 * Graceful Self-Restart — Ensures Grammy acknowledges Telegram updates before exit.
 *
 * Problem: When the AI calls `pm2 restart alvin-bot`, PM2 kills the process
 * externally (SIGTERM → SIGKILL) before Grammy can commit the update offset.
 * This causes a restart loop where the same "restart" message is re-processed.
 *
 * Solution: Instead of `pm2 restart`, we exit gracefully from inside the process.
 * Grammy's bot.stop() commits the offset, then process.exit(0) triggers PM2 auto-restart.
 */

type ShutdownFn = () => Promise<void>;

let _shutdownFn: ShutdownFn | null = null;
let _restartScheduled = false;

/**
 * Register the graceful shutdown function (called once from index.ts).
 */
export function registerShutdownHandler(fn: ShutdownFn) {
  _shutdownFn = fn;
}

/**
 * Schedule a graceful restart. Waits for the given delay (ms) to allow
 * the AI to finish its response, then shuts down cleanly.
 * PM2's autorestart brings the bot back.
 *
 * Returns true if restart was scheduled, false if already pending.
 */
export function scheduleGracefulRestart(delayMs = 1500): boolean {
  if (_restartScheduled) return false;
  _restartScheduled = true;

  setTimeout(async () => {
    console.log("Graceful self-restart initiated...");
    if (_shutdownFn) {
      await _shutdownFn();
    } else {
      process.exit(0);
    }
  }, delayMs);

  return true;
}

/**
 * Check if a shell command is a self-restart command.
 */
export function isSelfRestartCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  // Match: pm2 restart alvin-bot, pm2 restart 0, pm2 reload alvin-bot
  return /pm2\s+(restart|reload)\s+(alvin-bot|0)\b/.test(normalized);
}
