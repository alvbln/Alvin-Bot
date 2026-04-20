---
name: webcheck
description: Use when the user wants a security/SEO audit of a website, says "webcheck", "check die seite", "security audit", "site audit", "pruef mal", or provides a domain/URL to analyze. Runs DNS, SSL, headers, performance, tech stack, data leaks, and SEO checks via CLI tools.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash
  - Grep
  - Agent
  - WebSearch
  - WebFetch
---

# WebCheck — Website Security & SEO Audit

Fuehrt einen umfassenden WebCheck-Style Audit durch — komplett via CLI, kein externer Service noetig.

## Trigger

- "webcheck fuer X", "check mal X", "security audit X", "wie steht X da"
- Jede Domain/URL die der User zur Analyse gibt

## Audit-Checks (alle via Bash)

### 1. DNS Records
```bash
DOMAIN="example.com"
dig +short $DOMAIN A && dig +short $DOMAIN AAAA && dig +short $DOMAIN MX
dig +short $DOMAIN NS && dig +short $DOMAIN TXT && dig +short $DOMAIN CAA
dig +short www.$DOMAIN CNAME
```

### 2. SSL/TLS
```bash
echo | openssl s_client -connect $DOMAIN:443 -servername $DOMAIN 2>/dev/null | \
  openssl x509 -noout -subject -issuer -dates -ext subjectAltName
```

### 3. HTTP Headers + Security Headers (7-Check)
```bash
curl -sI https://$DOMAIN | grep -iE "strict-transport|content-security|x-frame|x-content-type|x-xss|referrer-policy|permissions-policy|x-powered-by|server:"
```

Pruefen: X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy, HSTS, Permissions-Policy, CSP

### 4. Performance
```bash
curl -s -o /dev/null -w "TTFB: %{time_starttransfer}s | Total: %{time_total}s | Size: %{size_download}B | HTTP: %{http_code}" https://$DOMAIN
```

### 5. IP + Geolocation
```bash
IP=$(dig +short $DOMAIN A | head -1)
curl -s "https://ipapi.co/$IP/json/" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{d.get(\"city\")}, {d.get(\"country_name\")} | {d.get(\"org\")}')"
```

### 6. robots.txt + Sitemap
```bash
curl -s https://$DOMAIN/robots.txt | head -20
curl -s https://$DOMAIN/sitemap.xml | head -20
```

### 7. Tech Stack (HTML Source Analysis)
```bash
curl -s https://$DOMAIN | python3 -c "
import sys; html = sys.stdin.read().lower()
techs = {'React':'react' in html, 'Next.js':'__next' in html or '_next' in html,
  'Vite':'vite' in html, 'Tailwind':'tailwind' in html,
  'Stripe':'stripe' in html, 'WordPress':'wp-content' in html,
  'Umami':'umami' in html or 'analytics.alev' in html,
  'GA4':'gtag' in html or 'googletagmanager' in html}
for k,v in techs.items():
  if v: print(f'  ✅ {k}')
"
```

### 8. Domain WHOIS
```bash
whois $DOMAIN | grep -iE "registrar|creation|expiry|updated|status" | head -10
```

### 9. Redirect Chain
```bash
curl -sIL https://www.$DOMAIN | grep -E "^HTTP|^location|^Location"
```

### 10. Data Leaks + Security
```bash
# Secrets in HTML
curl -s https://$DOMAIN | grep -oiE "(api[_-]?key|secret|token|password)[[:space:]]*[:=][[:space:]]*['\"][^'\"]{8,}" | head -5
# Mixed Content
curl -s https://$DOMAIN | grep -c "http://" 
# SRI
curl -s https://$DOMAIN | grep -c "integrity="
# Cookies
curl -sI https://$DOMAIN | grep -i "set-cookie"
```

## Report Format

```
## 🔍 $DOMAIN — WebCheck Report

### Server & Netzwerk
| Check | Ergebnis | Status |
[IP, Server, HTTP/2, TTFB, Size, Redirects]

### SSL/TLS
[Issuer, Valid until, SAN, HSTS, Mixed Content]

### Security Headers — X/7
[Table mit allen 7 Headers]

### DNS
[Alle Records + CAA/DNSSEC Status]

### Tech Stack
[Erkannte Technologien]

### SEO & Crawlability
[robots.txt, sitemap, meta tags, schema, leaks, SRI]

### Domain
[Registrar, created, expires, auto-renewal]

### Score: XX/100
[Zusammenfassung + Quick Wins]
```

## Scoring

| Bereich | Max Punkte |
|---------|-----------|
| Security Headers (7/7) | 25 |
| SSL/TLS + HSTS | 15 |
| DNS (CAA, SPF, DKIM, DMARC) | 15 |
| Performance (TTFB <200ms) | 10 |
| SEO (robots, sitemap, schema, meta) | 15 |
| No Data Leaks | 10 |
| Tech/Config (HTTP/2, redirects) | 10 |

## Quick Fixes

Nach dem Audit immer konkrete Empfehlungen mit Prioritaet:
- 🔴 HOCH — Security-relevant, sofort fixen
- 🟡 MITTEL — SEO/Best-Practice, bei Gelegenheit
- 🟢 NIEDRIG — Nice-to-have

Falls DNS-Provider-Login noetig (CAA, DKIM, DMARC): CDP Chrome nutzen falls Session aktiv, sonst User fragen.
