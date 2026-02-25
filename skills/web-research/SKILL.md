---
name: Web Research
description: Deep web research with source aggregation and summarization
triggers: research, recherche, find information, look up, search for, herausfinden, web search, deep dive
priority: 3
category: research
---

# Web Research Skill

When conducting web research:

## Workflow
1. **Search** — use curl/web_fetch to search and fetch relevant pages
2. **Read & extract** — parse the content, extract key information
3. **Synthesize YOURSELF** — combine findings into a coherent summary
4. **Cite sources** — always include URLs for claims

## Search Pattern
```bash
# Google via web scraping
curl -sL "https://www.google.com/search?q=QUERY&hl=en" | python3 -c "
import sys, re
html = sys.stdin.read()
for m in re.finditer(r'<a href=\"/url\?q=(https?://[^&\"]+)', html):
    print(m.group(1))
" | head -5
```

## Guidelines
- **Multiple sources** — never rely on a single source
- **Recency** — prefer recent results for time-sensitive topics
- **Summarize** — don't dump raw page content, distill the key findings
- **Structure** — organize by subtopic or relevance
- **Bias check** — note if sources are promotional or one-sided
