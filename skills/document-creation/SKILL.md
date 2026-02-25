---
name: Document Creation
description: Create professional documents (PDF, reports, letters)
triggers: pdf, document, report, brief, letter, create document, dokument erstellen, bericht, schreiben, anschreiben, vorlage
priority: 4
category: productivity
---

# Document Creation Skill

When creating professional documents:

## Workflow
1. **Clarify** format and content requirements
2. **Write** the content YOURSELF — you are the language model
3. **Generate** HTML with professional styling
4. **Convert** to PDF using available tools
5. **Deliver** to the user

## PDF via HTML + Chrome/Playwright
```bash
# Write HTML
cat > /tmp/document.html << 'EOF'
<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: 'Segoe UI', system-ui, sans-serif; max-width: 210mm; margin: 0 auto; padding: 20mm; line-height: 1.6; color: #333; }
  h1 { color: #1a1a2e; border-bottom: 2px solid #e2b04a; padding-bottom: 8px; }
  h2 { color: #2d2a26; margin-top: 1.5em; }
  .header { text-align: right; font-size: 0.9em; color: #666; margin-bottom: 2em; }
  table { width: 100%; border-collapse: collapse; margin: 1em 0; }
  th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
  th { background: #f5f5f5; }
</style></head><body>
<!-- CONTENT HERE -->
</body></html>
EOF

# Convert to PDF
npx playwright-core pdf /tmp/document.html /tmp/document.pdf --format=A4 2>/dev/null || \
  wkhtmltopdf --page-size A4 /tmp/document.html /tmp/document.pdf 2>/dev/null
```

## Guidelines
- **A4 format** for European documents, Letter for US
- **Professional tone** unless told otherwise
- **Page breaks** — use `break-inside: avoid` on logical blocks
- **Date format** — match user's locale (DD.MM.YYYY for DE, MM/DD/YYYY for EN)
