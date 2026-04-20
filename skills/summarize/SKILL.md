---
name: Summarize
description: Summarize URLs, documents, PDFs, and long text
triggers: summarize, zusammenfassen, summary, zusammenfassung, tldr, tl;dr, digest
priority: 7
category: research
---

# Summarization Workflow

## URL Summarization
1. Fetch content: `curl -sL URL | head -c 50000`
2. Summarize the text directly (YOU are the LLM — no external API needed)
3. Present: Key points, main arguments, conclusion

## PDF Summarization
1. Extract text: `pdftotext file.pdf -` or `python3 -c "..."`
2. Summarize directly
3. If too long: chunk into sections, summarize each, then meta-summarize

## Long Text
1. If under 10,000 chars: summarize directly
2. If over 10,000 chars: split into logical sections, summarize each, combine

## Output Format
- **One-line summary** (1 sentence)
- **Key Points** (3-5 bullets)
- **Details** (if requested, 2-3 paragraphs)
