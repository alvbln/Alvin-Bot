# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 3.x     | ✅ Yes             |
| < 3.0   | ❌ No              |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT** open a public GitHub issue
2. **Email** security concerns to **alvbln7@gmail.com**
3. Include a description of the vulnerability and steps to reproduce

## What to Report

- Authentication or authorization bypasses
- API key exposure in logs or responses
- Injection vulnerabilities (command injection, prompt injection)
- Insecure default configurations
- Dependencies with known vulnerabilities

## Response Timeline

- **Acknowledgment:** Within 48 hours
- **Assessment:** Within 1 week
- **Fix:** Depending on severity, typically within 2 weeks

## Security Best Practices for Users

- Never commit your `.env` file or API keys to version control
- Use strong passwords for the web dashboard (`WEB_PASSWORD`)
- Keep your Alvin Bot installation updated to the latest version
- Run behind a reverse proxy (nginx) with HTTPS in production
- Restrict network access to the dashboard port
