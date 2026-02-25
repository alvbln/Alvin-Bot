/**
 * Smart Home Plugin — Control smart home devices.
 *
 * Supports:
 * - Philips Hue (via local bridge API)
 * - Generic HTTP devices (webhooks, IFTTT, Home Assistant)
 *
 * Configuration via docs/smarthome.json:
 * {
 *   "hue": { "bridge": "192.168.1.x", "username": "api-key" },
 *   "devices": [
 *     { "name": "Desk Lamp", "type": "hue", "id": "1" },
 *     { "name": "Fan", "type": "webhook", "on": "http://...", "off": "http://..." }
 *   ]
 * }
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_FILE = path.resolve(PLUGIN_ROOT, "docs", "smarthome.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return { hue: null, devices: [] };
  }
}

async function hueRequest(method, endpoint, body = null) {
  const config = loadConfig();
  if (!config.hue?.bridge || !config.hue?.username) {
    throw new Error("Hue Bridge nicht konfiguriert. Erstelle docs/smarthome.json");
  }
  const url = `http://${config.hue.bridge}/api/${config.hue.username}${endpoint}`;
  const options = { method, headers: { "Content-Type": "application/json" } };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  return res.json();
}

export default {
  name: "smarthome",
  description: "Smart Home Steuerung (Hue, Webhooks, Home Assistant)",
  version: "1.0.0",
  author: "Alvin Bot",

  commands: [
    {
      command: "home",
      description: "Smart Home steuern",
      handler: async (ctx, args) => {
        const config = loadConfig();

        if (!args) {
          if (config.devices.length === 0 && !config.hue) {
            await ctx.reply(
              "🏠 *Smart Home*\n\n" +
              "Nicht konfiguriert.\nErstelle `docs/smarthome.json` mit:\n" +
              "```json\n" +
              '{\n  "hue": { "bridge": "IP", "username": "KEY" },\n  "devices": []\n}\n' +
              "```",
              { parse_mode: "Markdown" }
            );
            return;
          }

          // List devices
          const lines = config.devices.map((d, i) => `${i + 1}. ${d.type === "hue" ? "💡" : "🔌"} *${d.name}* (${d.type})`);

          // If Hue configured, show lights
          if (config.hue) {
            try {
              const lights = await hueRequest("GET", "/lights");
              for (const [id, light] of Object.entries(lights)) {
                const state = light.state?.on ? "🟢" : "⚫";
                const brightness = light.state?.bri ? ` (${Math.round(light.state.bri / 254 * 100)}%)` : "";
                lines.push(`💡 ${state} *${light.name}*${brightness} [Hue #${id}]`);
              }
            } catch (err) {
              lines.push(`⚠️ Hue Bridge nicht erreichbar: ${err.message}`);
            }
          }

          await ctx.reply(
            `🏠 *Smart Home:*\n\n${lines.join("\n")}\n\n` +
            "_Befehle: `/home on <name>`, `/home off <name>`, `/home brightness <name> 50`_",
            { parse_mode: "Markdown" }
          );
          return;
        }

        // /home on <device>
        if (args.startsWith("on ") || args.startsWith("off ")) {
          const on = args.startsWith("on ");
          const deviceName = args.slice(on ? 3 : 4).trim().toLowerCase();

          // Check configured devices first
          const device = config.devices.find(d => d.name.toLowerCase().includes(deviceName));
          if (device) {
            if (device.type === "webhook") {
              const url = on ? device.on : device.off;
              if (!url) { await ctx.reply("❌ Kein Webhook für diesen Zustand."); return; }
              await fetch(url, { method: "POST" });
              await ctx.reply(`${on ? "🟢" : "⚫"} *${device.name}* ${on ? "eingeschaltet" : "ausgeschaltet"}.`, { parse_mode: "Markdown" });
              return;
            }
            if (device.type === "hue" && device.id) {
              await hueRequest("PUT", `/lights/${device.id}/state`, { on });
              await ctx.reply(`💡 *${device.name}* ${on ? "ein" : "aus"}.`, { parse_mode: "Markdown" });
              return;
            }
          }

          // Try Hue lights by name
          if (config.hue) {
            try {
              const lights = await hueRequest("GET", "/lights");
              for (const [id, light] of Object.entries(lights)) {
                if (light.name.toLowerCase().includes(deviceName)) {
                  await hueRequest("PUT", `/lights/${id}/state`, { on });
                  await ctx.reply(`💡 *${light.name}* ${on ? "ein" : "aus"}.`, { parse_mode: "Markdown" });
                  return;
                }
              }
            } catch { /* bridge not reachable */ }
          }

          await ctx.reply(`❌ Gerät "${deviceName}" nicht gefunden.`);
          return;
        }

        // /home brightness <device> <0-100>
        if (args.startsWith("brightness ") || args.startsWith("bri ")) {
          const parts = args.split(" ").slice(1);
          const level = parseInt(parts[parts.length - 1]);
          const deviceName = parts.slice(0, -1).join(" ").toLowerCase();

          if (isNaN(level) || level < 0 || level > 100) {
            await ctx.reply("Helligkeit: 0-100. Beispiel: `/home brightness Lampe 50`", { parse_mode: "Markdown" });
            return;
          }

          const bri = Math.round(level / 100 * 254);

          if (config.hue) {
            try {
              const lights = await hueRequest("GET", "/lights");
              for (const [id, light] of Object.entries(lights)) {
                if (light.name.toLowerCase().includes(deviceName)) {
                  await hueRequest("PUT", `/lights/${id}/state`, { on: true, bri });
                  await ctx.reply(`💡 *${light.name}* Helligkeit: ${level}%`, { parse_mode: "Markdown" });
                  return;
                }
              }
            } catch { /* bridge not reachable */ }
          }

          await ctx.reply(`❌ Gerät "${deviceName}" nicht gefunden.`);
          return;
        }

        // /home scene <scene-name>
        if (args.startsWith("scene ")) {
          const sceneName = args.slice(6).trim().toLowerCase();
          if (!config.hue) { await ctx.reply("❌ Hue nicht konfiguriert."); return; }

          try {
            const scenes = await hueRequest("GET", "/scenes");
            for (const [id, scene] of Object.entries(scenes)) {
              if (scene.name.toLowerCase().includes(sceneName)) {
                await hueRequest("PUT", "/groups/0/action", { scene: id });
                await ctx.reply(`🎨 Szene aktiviert: *${scene.name}*`, { parse_mode: "Markdown" });
                return;
              }
            }
            await ctx.reply(`❌ Szene "${sceneName}" nicht gefunden.`);
          } catch (err) {
            await ctx.reply(`❌ Hue-Fehler: ${err.message}`);
          }
          return;
        }

        await ctx.reply(
          "🏠 *Smart Home Befehle:*\n\n" +
          "`/home` — Geräte auflisten\n" +
          "`/home on Lampe` — Einschalten\n" +
          "`/home off Lampe` — Ausschalten\n" +
          "`/home brightness Lampe 50` — Helligkeit\n" +
          "`/home scene Entspannt` — Hue-Szene aktivieren",
          { parse_mode: "Markdown" }
        );
      },
    },
  ],

  tools: [
    {
      name: "control_device",
      description: "Turn a smart home device on or off",
      parameters: {
        type: "object",
        properties: {
          device: { type: "string", description: "Device name" },
          action: { type: "string", enum: ["on", "off"], description: "Action" },
          brightness: { type: "number", description: "Brightness 0-100 (optional)" },
        },
        required: ["device", "action"],
      },
      execute: async (params) => {
        const config = loadConfig();
        if (!config.hue) return "Smart Home not configured";

        const lights = await hueRequest("GET", "/lights");
        for (const [id, light] of Object.entries(lights)) {
          if (light.name.toLowerCase().includes(params.device.toLowerCase())) {
            const state = { on: params.action === "on" };
            if (params.brightness !== undefined) state.bri = Math.round(params.brightness / 100 * 254);
            await hueRequest("PUT", `/lights/${id}/state`, state);
            return `${light.name}: ${params.action}${params.brightness ? ` (${params.brightness}%)` : ""}`;
          }
        }
        return `Device "${params.device}" not found`;
      },
    },
  ],
};
