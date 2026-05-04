---
name: Browser Automation
description: 3-tier browser control — WebFetch for plain pages, stealth scraping for JS/Cloudflare, CDP with persistent cookies for login-walled sites. Navigate, screenshot, extract text, interact with logged-in pages.
triggers: browse, browser, test webapp, test app, test website, screenshot page, interact with, click on, fill form, visual test, qa test, check page, open page, test my app, browse to, open url, puppeteer, playwright, browser automation, linkedin, stepstone, indeed, scrape, fetch page, crawl, teste die seite, teste die app, schau dir an, öffne die seite, teste mal, visual check, check the ui, check the page, webseite öffnen, seite abrufen
priority: 8
category: automation
---

# Browser Automation — 3-Tier Router

Du hast drei Browser-Strategien plus WebFetch. **Wähle die billigste passende Stufe** und eskaliere nur wenn nötig.

## Entscheidungsregel (in dieser Reihenfolge)

| Task | Tool | Warum |
|------|------|-------|
| Einzelne öffentliche Seite, nur Text | `curl` oder WebFetch | Am schnellsten, keine Browser-Engine |
| Interaktiv (klicken/füllen/extrahieren) auf kooperativer Seite | **Tier 1.5 agent-browser** *(falls installiert)* | Snapshot+Ref-Workflow ist ~90 % token-günstiger als rohes Playwright. Siehe Skill „Agent Browser". |
| Öffentliche Seite mit JS / Cloudflare | **Tier 1 Stealth** | Headless + Fingerprint-Masking |
| Login-pflichtige Seite (LinkedIn, Gmail, …) | **Tier 2 CDP** | Echtes Chromium, persistente Cookies |
| Komplexer Multi-Step-Flow, User soll zusehen | **Tier 3 Extension** | Nur in interaktiven CLI-Sessions |

**NIEMALS** nacktes `node -e "const {chromium}…"` für externe Seiten — wird sofort geblockt.

**Vorab prüfen ob agent-browser verfügbar ist:**
```bash
command -v agent-browser >/dev/null 2>&1 && echo "Tier 1.5 verfügbar"
```
Falls ja und der Task ist „klick X, lies Y, fülle Z aus" → den `agent-browser`-Skill nehmen.
Falls nein → mit Tier 1/2/3 weitermachen wie unten. Installation auf Wunsch des Users: `npm i -g agent-browser && agent-browser install`.

---

## Tier 0 — curl / WebFetch (schnellster Pfad)

Für statische Seiten oder APIs, die keine JS-Rendering brauchen:

```bash
curl -sL -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
  "https://example.com/public-page"
```

Wenn das einen 403/Captcha liefert → eskaliere auf Tier 1.

---

## Tier 1 — Playwright Stealth (headless, schnell, maskiert)

Für Seiten mit JS-Rendering oder Bot-Detection. Der Bot hat eine eingebaute Stealth-Pipeline; keine Hub-Scripts nötig.

**Empfohlener Weg — Bot-API:** Der interne `browser-manager` wählt automatisch die richtige Strategie. Für Scripts direkt nutzbar:

```bash
# Falls ein externes Dev-Hub-Script vorhanden ist, kann es genutzt werden:
# ~/.claude/hub/SCRIPTS/browser.sh stealth "<url>"
```

Ansonsten direkt über Playwright in einem kurzen Node-Script:

```bash
node -e "
(async () => {
  const { chromium } = require('playwright');
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
  await p.goto(process.argv[1], { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log(JSON.stringify({ url: p.url(), title: await p.title() }));
  await b.close();
})();
" "https://example.com"
```

**Wann blockt das:** reCAPTCHA v3, aggressive Cloudflare, Login-Walls → eskaliere auf Tier 2.

**Konkrete funktionierende Targets (Stand 2026):** StepStone, Michael Page, Hays, Blogs, News-Sites.

---

## Tier 2 — Chromium CDP (Bot-managed, persistent Profile)

Echtes Chromium mit Profil unter `~/.alvin-bot/browser/profile/`. Login-Cookies für LinkedIn/Gmail/etc. bleiben über Sessions erhalten.

**Bot-CLI (empfohlen — funktioniert auf jedem Alvin-Bot-Install):**

```bash
# Starten (headless als Default — perfekt für Cron/Daemon)
alvin-bot browser start
alvin-bot browser start headful       # sichtbar, wenn User zusehen soll

# Navigieren
alvin-bot browser goto "https://www.linkedin.com/jobs/search/?keywords=IT+Director"

# Screenshot → speichert nach ~/.alvin-bot/browser/screenshots/
alvin-bot browser shot "https://www.linkedin.com/feed/" linkedin_feed.png

# JS in Seite ausführen
alvin-bot browser eval "https://example.com" "document.title"

# Tabs auflisten
alvin-bot browser tabs

# Beenden (meistens nicht nötig — Chromium läuft persistent bis Bot-Neustart)
alvin-bot browser stop

# Diagnose bei Problemen
alvin-bot browser doctor
```

**Architektur:** Der Bot nutzt Playwright's gebundeltes Chromium ("Google Chrome for Testing"), nicht das normale User-Chrome. Keine LaunchServices-Kollision mit parallel laufendem Chrome. Erste Einrichtung nach `npm install`:

```bash
# Playwright-Chromium einmal installieren
npx playwright install chromium
```

**Login-Setup (einmalig):** Falls die Seite ausgeloggt ist, den User fragen:
> "Bitte einmal in Chromium (Bot-Profil) bei <Seite> einloggen. Cookies bleiben dann dauerhaft erhalten."

Starten mit `alvin-bot browser start headful`, User loggt in → ab dann persistiert das Profil unter `~/.alvin-bot/browser/profile/`.

**Wie teste ich ob eingeloggt:** nach `goto` die URL prüfen — wenn `/authwall` oder `/login` im Pfad steht, bist du ausgeloggt.

---

## Tier 3 — Claude-in-Chrome Extension (visuelle Kontrolle)

Nur in interaktiven Claude Code CLI-Sessions verfügbar, **nicht** im Bot-Daemon.

```bash
# MCP-Tools über ToolSearch laden:
#   mcp__claude-in-chrome__tabs_context_mcp
#   mcp__claude-in-chrome__navigate
#   mcp__claude-in-chrome__computer
```

**Wann nutzen:** Drag&Drop, komplexe UI, User soll live zusehen und eingreifen können.

---

## Eskalations-Regel (PFLICHT)

```
Öffentliche Text-Seite → Tier 0 (curl/WebFetch)
  ↓ 403/Cloudflare/leerer HTML?
Tier 1 (stealth) → Node+Playwright headless
  ↓ Captcha/Login-Wall?
Tier 2 (CDP) → alvin-bot browser start + goto <url>
  ↓ Cookies fehlen?
Den User fragen: "Bitte einmal in Chromium bei <Seite> einloggen, dann kann ich weitermachen."
```

**NIEMALS aufgeben mit "Browser funktioniert nicht"** — es gibt immer einen nächsten Schritt. Lieber ehrlich melden "Tier 1 blockt mit Captcha, versuche Tier 2" als "Failed to load".

## Status & Diagnose

```bash
# Aktueller CDP-Zustand
alvin-bot browser status

# Vollständige Diagnose (Binary, Port, PID, Profile-Lock, Chrome-Konflikt)
alvin-bot browser doctor

# Raw check ob CDP-Endpoint antwortet
curl -s http://127.0.0.1:9222/json/version | head -c 200
```

## Screenshot-Ausgabe ansehen

Screenshots landen in `~/.alvin-bot/browser/screenshots/` (wenn nur Dateiname angegeben) oder dem absoluten Pfad. Read-Tool auf den Pfad zeigt dir das Bild direkt an.

## Wichtige Notes

- **Profile-Konflikt:** Chromium kann `~/.alvin-bot/browser/profile/` nicht doppelt öffnen. `alvin-bot browser doctor` zeigt stale Locks.
- **Headless vs Headful:** Im Cron/Daemon IMMER `headless` (Default) — headful scheitert an fehlendem Display.
- **Persistenz:** Cookies, LocalStorage, IndexedDB — alles in `~/.alvin-bot/browser/profile/`. Überlebt Bot-Restarts.
- **Kein User-Chrome-Konflikt:** Das Bot-Chromium ist ein separater Binary (Chrome-for-Testing), läuft parallel zum normalen Chrome ohne LaunchServices-Kollision.
