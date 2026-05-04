---
name: Agent Browser (Snapshot+Ref)
description: Token-efficient browser automation via the `agent-browser` CLI (Vercel Labs). Uses accessibility-tree snapshots with @eN refs (~200–400 tokens per page) instead of raw HTML parsing — typically 90%+ cheaper than Playwright/Puppeteer. Use for click-fill-extract on public pages, single-page test flows, structured form submission, and screenshots-with-refs. Optional dependency — only active if `agent-browser` is on the PATH; otherwise the regular Browser Automation skill takes over.
triggers: snapshot the page, get refs, list interactive elements, click @e, fill @e, agent-browser, click button on, click the button, fill in the field, extract from page, find on page, scrape page interactively, visit and click, open page and click, navigate and fill, semantic locator, accessibility tree, snapshot+ref, schau auf der Seite nach, klicke auf den Button, fülle das Feld, formular ausfüllen
priority: 9
category: automation
---

# Agent Browser — Token-Efficient Snapshot+Ref Workflow

Use this skill when interactive browser automation is needed (click, fill,
extract, screenshot) AND `agent-browser` is installed. The accessibility-tree
snapshot makes per-page interaction roughly an order of magnitude cheaper in
tokens than parsing rendered HTML with Playwright.

## Pre-flight: is the CLI installed?

```bash
command -v agent-browser >/dev/null 2>&1 \
  && echo "agent-browser ok" \
  || echo "fall back to the Browser Automation skill"
```

If absent: **stop and use the regular Browser Automation skill** (Tier 1
Stealth / Tier 2 CDP). Don't suggest installing it unless the user asks —
it's an opt-in tool, see `alvin-bot doctor` for installation hints.

## Core loop

```bash
agent-browser open <url>
agent-browser snapshot -i               # interactive elements, with @e1..@eN refs
agent-browser click @e3                 # act on a ref
agent-browser snapshot -i               # CRITICAL — re-snapshot after every page change
agent-browser close
```

Refs (`@e1`, `@e2`, …) are **assigned fresh every snapshot**. They go stale
the moment the page changes (click that navigates, form submit, dynamic
re-render, modal open). Always re-snapshot before the next ref interaction.
This single rule is the most common pitfall.

A snapshot looks like:

```
Page: Example - Log in
URL: https://example.com/login

@e1 [heading] "Log in"
@e2 [form]
  @e3 [input type="email"] placeholder="Email"
  @e4 [input type="password"] placeholder="Password"
  @e5 [button type="submit"] "Continue"
  @e6 [link] "Forgot password?"
```

## Common patterns

### Read a page

```bash
agent-browser snapshot -i               # interactive only (preferred)
agent-browser snapshot -i -u            # include href URLs on links
agent-browser snapshot -i --json        # machine-readable
agent-browser get text @e1              # visible text of an element
agent-browser get attr @e10 href        # any attribute
agent-browser get url                   # current URL
```

### Interact

```bash
agent-browser click @e1
agent-browser fill @e2 "user@example.com"  # clear + type
agent-browser type @e2 " more text"        # type without clearing
agent-browser press Enter
agent-browser select @e4 "option-value"
agent-browser upload @e5 file.pdf
agent-browser scroll down 500
agent-browser screenshot result.png
```

### Wait for the right thing (most failures come from bad waits)

```bash
agent-browser wait @e1                     # until an element appears
agent-browser wait --text "Success"        # until specific text on the page
agent-browser wait --url "**/dashboard"    # until URL matches glob
agent-browser wait --load networkidle      # post-navigation catch-all
```

Avoid bare `wait 2000` except in throwaway debugging. Default timeout: 25 s.

### Find by semantics when refs aren't ergonomic

```bash
agent-browser find role button click --name "Submit"
agent-browser find text "Sign In" click --exact
agent-browser find label "Email" fill "user@example.com"
agent-browser find placeholder "Search" type "query"
agent-browser find testid "submit-btn" click
```

### Multiple isolated browser sessions (parallel users)

```bash
agent-browser --session a open https://app.example.com
agent-browser --session b open https://app.example.com
agent-browser --session a fill @e1 "alice@test.com"
agent-browser --session b fill @e1 "bob@test.com"
```

### Persist login across runs

```bash
# Save once after a successful login:
agent-browser state save ./auth.json

# Resume already-logged-in:
agent-browser --state ./auth.json open https://app.example.com
```

### Auth vault (don't put passwords in shell history)

```bash
agent-browser auth save my-app --url https://app.example.com/login \
  --username user@example.com --password-stdin
# (paste password, Ctrl+D)

agent-browser auth login my-app
```

### Iframes

Iframes are inlined in the snapshot — refs work transparently. To scope a
snapshot to one iframe:

```bash
agent-browser frame @e3
agent-browser snapshot -i
agent-browser frame main
```

### Mock network (testing)

```bash
agent-browser network route "**/api/users" --body '{"users":[]}'
agent-browser network route "**/analytics" --abort
agent-browser network har start /tmp/trace.har
# ... do stuff ...
agent-browser network har stop
```

## When NOT to use this skill

| Situation | Skill |
|---|---|
| Bot-protected site (Cloudflare, DataDome) | regular **Browser Automation** skill, Tier 1 Stealth |
| Logged-in personal account on LinkedIn / Gmail | **Browser Automation**, Tier 2 CDP (`alvin-bot browser …`) |
| User wants to watch a complex flow live | **Browser Automation**, Tier 3 Extension |
| Static HTML / public JSON / RSS / API | `curl` / WebFetch — no browser engine needed |

agent-browser is great for **task automation on cooperative pages** (your
own apps, public data sites, form submissions). It is *not* a stealth tool.

## Diagnostics

```bash
agent-browser doctor                # full env check
agent-browser doctor --quick        # local-only
agent-browser dashboard start       # observability UI on :4848
agent-browser skills get core       # the upstream tool's own usage guide
```

## One-liner sanity test

```bash
agent-browser open https://example.com \
  && agent-browser snapshot -i \
  && agent-browser close
```

Expect two `@e` refs (heading + link). If that works, the tool is healthy.
