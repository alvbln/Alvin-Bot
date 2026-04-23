# Design Skills — Installed 22.04.2026

19 neue Skills aus 2 Repos + Bestätigung dass Frontend Design bereits via Anthropic Plugin installiert ist.

## Quellen

| Skill | Repo | Stars | Status |
|---|---|---|---|
| **Impeccable** (18 commands) | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | ⭐ 21.419 | ✅ Neu installiert |
| **Design Motion Principles** | [kylezantos/design-motion-principles](https://github.com/kylezantos/design-motion-principles) | ⭐ 293 | ✅ Neu installiert |
| **Frontend Design** | [anthropics/skills/frontend-design](https://github.com/anthropics/skills) | — | ℹ️ War bereits aktiv (Plugin `frontend-design:frontend-design`) |

## Reel-Quelle
Marc Cleroux auf Instagram — https://www.instagram.com/reel/DXdVUiOjKUv/ (22.04.2026)

## Impeccable-Commands (18)

Vokabular um Claude bei frontend-design zu steuern wenn dir die richtigen Worte fehlen.

| Command | Funktion |
|---|---|
| `/impeccable` | Core skill mit 18 commands + 7 Referenz-Domänen |
| `/adapt` | Responsive / Breakpoints / Touch-Targets |
| `/animate` | Purposeful motion + micro-interactions |
| `/audit` | Technische Quality Checks (a11y, perf, responsive) + scored report |
| `/bolder` | Bland → visuell interessanter |
| `/clarify` | Unklare UX-Copy verbessern |
| `/colorize` | Strategische Farbe einführen |
| `/critique` | UX Design Review (Hierarchie, Klarheit, Resonanz) |
| `/delight` | Joy-Momente, Personality, Memorable Touches |
| `/distill` | Auf Essenz reduzieren, Complexity weg |
| `/harden` | Error Handling, Empty States, Onboarding, i18n, Edge Cases |
| `/layout` | Layout / Spacing / Visual Rhythm fixen |
| `/optimize` | Performance (Bundle, Rendering, Images) |
| `/overdrive` | Technisch ambitioniert — Shaders, Spring Physics, 60fps |
| `/polish` | Final Quality Pass pre-shipping |
| `/quieter` | Overstimulating Design beruhigen |
| `/shape` | UX/UI-Plan vor Code |
| `/typeset` | Typografie fixen |

### 7 Referenz-Domänen in `impeccable`
typography · color-and-contrast · spatial-design · motion-design · interaction-design · responsive-design · ux-writing

## Design Motion Principles

Motion-Audit-Skill basierend auf den Philosophien von:
- **Emil Kowalski** — iOS-native UI polish
- **Jakub Krehel** — smooth interaction design
- **Jhey Tompkins** — creative web animation

Use case: *"Audit the hover states and transitions on my landing page"* → strukturierter Motion-Report.

## Installation

Geklont + direkt in `~/.claude/skills/` einzeln kopiert (Impeccable folgt dem Pattern aus ihrer README: `cp -r dist/claude-code/.claude/* ~/.claude/`).

## Update ziehen

```bash
cd /tmp && rm -rf design-skills && mkdir design-skills && cd design-skills
git clone --depth 1 https://github.com/pbakaus/impeccable.git
git clone --depth 1 https://github.com/kylezantos/design-motion-principles.git
cp -R impeccable/.claude/skills/. ~/.claude/skills/
cp -R design-motion-principles/skills/design-motion-principles ~/.claude/skills/
```

## Stand Skills-Inventar (22.04.2026)
- Vorher: 143 (nach AEC-Installation)
- Nachher: **162** (+19)

## Nebenbaustelle
Impeccable bringt zusätzlich eine `.claude/agents/anti-patterns.md` mit — nicht installiert (würde Permission für `~/.claude/agents/` brauchen). Das ist optional: Die 18 Skills funktionieren unabhängig vom Anti-Patterns-Agent. Falls später gewünscht: `cp -R /tmp/design-skills/impeccable/.claude/agents/. ~/.claude/agents/`

## Empfohlene Workflow-Kombination

Laut Marc Cleroux im Reel ist das Power-Trio:
1. **shape** (plan before code) — Teil von Impeccable
2. **frontend-design** (implement mit Geschmack) — schon installiert
3. **audit** + **critique** + **polish** (iterieren) — Impeccable

Bei jedem neuen Frontend-Build: `/shape` → `/impeccable craft` → `/audit` → `/critique` → `/polish` → shippen.
