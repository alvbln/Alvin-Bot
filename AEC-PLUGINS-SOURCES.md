# AEC Plugin Skills — Installed 22.04.2026

54 Skills aus 3 Claude-Code-Plugins, erstellt von **Abhinav Bhardwaj** (GitHub: `Amanbh997`).
Installiert via direkte Kopie in `~/.claude/skills/` — Claude Code auto-discovered via SKILL.md frontmatter.

Vorher: 89 Skills. Nachher: **143 Skills** (+54).

## Quellen

| Plugin | Repo | Skills | Stars |
|---|---|---|---|
| **Urban Design** | [Amanbh997/Urban-Design-Skills-Claude](https://github.com/Amanbh997/Urban-Design-Skills-Claude) | 18 | ⭐ 76 |
| **Architecture** | [Amanbh997/Skills-Architects](https://github.com/Amanbh997/Skills-Architects) | 18 | ⭐ 118 |
| **Computational Design** | [Amanbh997/Claude-skills-for-Computational-Designers](https://github.com/Amanbh997/Claude-skills-for-Computational-Designers) | 18 | ⭐ 127 |

Jedes Plugin: 35.000+ Zeilen, 7 Python-Calculators, 50+ Theorists, 30+ Tools, hunderte numerische Benchmarks.

## Skill-Inventar

### Urban Design (18)
block-and-density · climate-responsive-design · cost-estimation · design-brief · design-evaluation · masterplan-design · mixed-use-programming · mobility-and-transport · precedent-study · public-space-design · site-analysis · street-design · sustainability-scoring · tod-design · urban-calculator · urban-design-foundations · urban-regeneration · zoning-and-codes

### Architecture (18)
accessibility-design · acoustic-design · architect-calculator · architect-foundations · building-codes · building-envelope · building-programming · building-services · building-sustainability · building-typology · concept-design · construction-documentation · daylighting-design · design-theory · fire-life-safety · material-selection · spatial-planning · structural-systems

### Computational Design (18)
algorithmic-patterns · bim-scripting · cd-calculator · cd-foundations · computational-geometry · data-driven-design · design-automation · digital-fabrication · environmental-simulation · facade-computation · generative-design · interoperability · mesh-processing · ml-for-aec · optimization-methods · parametric-modeling · scripting-reference · structural-computation

## Update ziehen

```bash
cd /tmp && rm -rf aec-skills && mkdir aec-skills && cd aec-skills
git clone --depth 1 https://github.com/Amanbh997/Urban-Design-Skills-Claude.git
git clone --depth 1 https://github.com/Amanbh997/Skills-Architects.git
git clone --depth 1 https://github.com/Amanbh997/Claude-skills-for-Computational-Designers.git
cp -R Urban-Design-Skills-Claude/skills/* ~/.claude/skills/
cp -R Skills-Architects/skills/* ~/.claude/skills/
cp -R Claude-skills-for-Computational-Designers/skills/* ~/.claude/skills/
```

## Wie die Skills ausgelöst werden

Jeder Skill hat im SKILL.md frontmatter eine `description`-Zeile die spezifische User-Anfragen matcht. Beispiele:

- „Design a mixed-use quarter" → Urban Design Plugin (masterplan-design, tod-design, mixed-use-programming, zoning-and-codes, mobility-and-transport …)
- „Check if this floor plan meets fire code" → Architecture Plugin (fire-life-safety, building-codes, accessibility-design, construction-documentation …)
- „Generate a parametric facade pattern in Grasshopper" → Computational Design Plugin (parametric-modeling, facade-computation, algorithmic-patterns, digital-fabrication …)

Laut Creator: *"Ask Claude to design a mixed-use quarter and all three plugins kick in working together."*

## Quelle
Reel vom Creator: https://www.instagram.com/reel/DXXhJS2kqAf/
Uploader: Abhinav Bhardwaj / "Claude for AEC!"
