---
name: Browser Automation
description: Interactive browser control — navigate, click, fill forms, screenshot, test web apps
triggers: browse, browser, test webapp, test app, test website, screenshot page, interact with, click on, fill form, visual test, qa test, check page, open page, test my app, browse to, open url, puppeteer, playwright, browser automation, test die seite, teste die app, schau dir an, öffne die seite, teste mal, visual check, check the ui, check the page
priority: 8
category: automation
---

# Browser Automation — Playwright Interactive

You have a persistent Playwright browser server that gives you **eyes** and **hands** to interact with web pages. You can navigate, see screenshots, read the accessibility tree, click buttons, fill forms, and test running web apps.

## Quick Start

```bash
# 1. Ensure server is running (auto-shuts down after 5 min idle)
curl -s http://127.0.0.1:3800/health 2>/dev/null | grep -q '"ok":true' || \
  (cd ~/Projects/alvin-bot && node scripts/browse-server.cjs &) && sleep 3

# 2. Navigate to a page
curl -s "http://127.0.0.1:3800/navigate?url=https://example.com" | jq

# 3. Take a screenshot (view it with Read tool)
SHOT=$(curl -s "http://127.0.0.1:3800/screenshot" | jq -r '.path')
# Then use Read tool on $SHOT to see the image

# 4. Get interactive elements
curl -s "http://127.0.0.1:3800/tree" | jq '.tree[]' -r

# 5. Click something
curl -s "http://127.0.0.1:3800/click?ref=e5" | jq
```

## All Routes

| Route | Params | What it does |
|-------|--------|-------------|
| `/navigate` | `url` | Open a URL, returns title + accessibility tree |
| `/screenshot` | `full=true` (optional) | Take screenshot, returns file path |
| `/tree` | `limit=N` (optional) | Get all interactive elements with @eN refs |
| `/click` | `ref=eN` | Click element by ref |
| `/fill` | `ref=eN`, `value=text` | Fill input field |
| `/type` | `ref=eN`, `text=chars` | Type character by character (for special inputs) |
| `/press` | `key=Enter`, `ref=eN` (opt) | Press keyboard key |
| `/select` | `ref=eN`, `value=opt` | Select dropdown option |
| `/hover` | `ref=eN` | Hover over element |
| `/scroll` | `direction=down/up/top/bottom`, `amount=600` | Scroll page |
| `/eval` | `js=expression` | Run JavaScript on page |
| `/wait` | `ms=2000` or `selector=.class` | Wait for time or element |
| `/viewport` | `device=mobile/tablet` or `width=W&height=H` | Change viewport |
| `/cookies` | `set=[{...}]` (optional) | Get or set cookies |
| `/back` | — | Browser back |
| `/forward` | — | Browser forward |
| `/reload` | — | Reload page |
| `/network` | `limit=20` | Recent network requests |
| `/info` | — | Current page info |
| `/close` | — | Close browser + shutdown server |
| `/health` | — | Server status check |

## Element Refs (@eN)

The accessibility tree assigns **refs** like `@e1`, `@e2`, `@e3` to every interactive element (links, buttons, inputs, etc.). Use these refs for all interactions — they're more robust than CSS selectors.

Example tree:
```
@e1 <a href="/"> "Home"
@e2 <a href="/dashboard"> "Dashboard"
@e3 <input type="email" name="email" placeholder="Enter email">
@e4 <input type="password" name="password" placeholder="Password">
@e5 <button> "Sign In"
@e6 <a href="/forgot"> "Forgot password?"
```

To login:
```bash
curl -s "http://127.0.0.1:3800/fill?ref=e3&value=user@example.com"
curl -s "http://127.0.0.1:3800/fill?ref=e4&value=mypassword"
curl -s "http://127.0.0.1:3800/click?ref=e5"
```

## Standard Workflow: Test a Web App

1. **Start** the browse server if not running
2. **Navigate** to the app URL
3. **Screenshot** → view with Read tool to see current state
4. **Tree** → see all interactive elements
5. **Interact** (click, fill, press) using @eN refs
6. **Screenshot** again to verify the result
7. **Repeat** for each test step
8. **Report** findings to the user
9. **Close** when done

## Mobile Testing

```bash
# Switch to mobile viewport
curl -s "http://127.0.0.1:3800/viewport?device=mobile"
curl -s "http://127.0.0.1:3800/screenshot" | jq -r '.path'
# Switch back to desktop
curl -s "http://127.0.0.1:3800/viewport?width=1280&height=720"
```

## Auth / Cookie Injection

For pages that need authentication:
```bash
# Set cookies manually
curl -s 'http://127.0.0.1:3800/cookies?set=[{"name":"session","value":"abc123","domain":"example.com","path":"/"}]'
# Then navigate to the authenticated page
curl -s "http://127.0.0.1:3800/navigate?url=https://example.com/dashboard"
```

## Important Notes

- **Server auto-shuts down** after 5 min idle — restart if needed
- **One page at a time** — navigation replaces the current page
- **Screenshots** are saved to `/tmp/alvin-bot/browse/` — view with Read tool
- **127.0.0.1 only** — not accessible from outside
- **URL-encode** values with special chars: `value=hello%20world`
- **Refs reset** on every navigation/click — always get fresh /tree after page changes
- For **local dev servers**: use `http://localhost:PORT` as the URL
