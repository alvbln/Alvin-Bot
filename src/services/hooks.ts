import { readdirSync, existsSync } from "fs";
import { resolve } from "path";
import { HOOKS_DIR } from "../paths.js";

export type HookEvent =
  | "session:start" | "session:end" | "session:compact"
  | "message:received" | "message:sent"
  | "cron:before" | "cron:after"
  | "command:executed";

interface HookHandler {
  event: HookEvent;
  name: string;
  handler: (payload: Record<string, unknown>) => Promise<void>;
}

const registry: HookHandler[] = [];

export function registerHook(hook: HookHandler): void {
  registry.push(hook);
}

export async function emit(event: HookEvent, payload: Record<string, unknown> = {}): Promise<void> {
  const handlers = registry.filter(h => h.event === event);
  for (const h of handlers) {
    try { await h.handler({ ...payload, _event: event, _timestamp: Date.now() }); }
    catch (err) { console.error(`Hook error (${h.name}/${event}):`, err); }
  }
}

export function loadHooks(): number {
  if (!existsSync(HOOKS_DIR)) return 0;
  const files = readdirSync(HOOKS_DIR).filter(f => f.endsWith(".js") || f.endsWith(".mjs"));
  let loaded = 0;
  for (const file of files) {
    try {
      const hookPath = resolve(HOOKS_DIR, file);
      // Use dynamic import for ESM modules
      import(hookPath).then(mod => {
        if (mod.event && typeof mod.handler === "function") {
          registerHook({ event: mod.event, name: file, handler: mod.handler });
          console.log(`Hook loaded: ${file} → ${mod.event}`);
        }
      }).catch(err => console.error(`Failed to load hook ${file}:`, err));
      loaded++;
    } catch (err) {
      console.error(`Failed to load hook ${file}:`, err);
    }
  }
  return loaded;
}

export function getRegisteredHooks(): { event: string; name: string }[] {
  return registry.map(h => ({ event: h.event, name: h.name }));
}
