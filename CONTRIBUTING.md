# Contributing to Alvin Bot

Thanks for your interest in contributing! Here's how you can help.

## Getting Started

1. **Fork** the repository
2. **Clone** your fork: `git clone https://github.com/YOUR_USERNAME/alvin-bot.git`
3. **Install** dependencies: `npm install`
4. **Create** a branch: `git checkout -b feature/your-feature`

## Development

```bash
# Build
npm run build

# Run in development
npm run dev

# Run tests
npm test
```

## Project Structure

- `src/` — Core bot source code
- `src/handlers/` — Message and command handlers
- `src/providers/` — AI provider integrations
- `src/platforms/` — Messaging platform adapters
- `src/services/` — Background services (cron, memory, etc.)
- `web/` — Dashboard web interface
- `electron/` — Desktop app wrapper
- `plugins/` — Plugin system

## Guidelines

- **TypeScript** — All source files should be TypeScript
- **Conventional Commits** — Use `feat:`, `fix:`, `docs:`, `chore:` prefixes
- **No breaking changes** without discussion in an issue first
- **Tests** — Add tests for new features when applicable
- **Lint** — Run `npm run lint` before submitting

## Pull Requests

1. Update documentation if you change behavior
2. Keep PRs focused — one feature/fix per PR
3. Write a clear description of what changed and why
4. Reference any related issues

## Reporting Bugs

Open an [issue](https://github.com/alvbln/alvin-bot/issues) with:
- Steps to reproduce
- Expected vs actual behavior
- Node.js version and OS
- Relevant logs (redact any API keys!)

## Feature Requests

Open an issue with the `enhancement` label describing:
- The use case
- Proposed solution
- Alternatives considered

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating, you agree to uphold this code.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
