---
name: Code Project
description: Build, debug, and manage code projects
triggers: code, programming, build project, create app, debug, fix bug, refactor, deploy, git, npm, python project, node project
priority: 4
category: development
---

# Code Project Skill

When working on code projects:

## Workflow
1. **Understand** — read existing files, README, package.json before changing anything
2. **Plan** — explain what you'll do before doing it
3. **Implement** — write clean, well-structured code
4. **Test** — run the code, check for errors, verify it works
5. **Document** — update README if you made significant changes

## Guidelines
- **Read before write** — always understand existing code structure first
- **Small commits** — one logical change per step
- **Error handling** — always handle errors, never ignore them
- **Types** — use TypeScript types, avoid `any` where possible
- **Test after changes** — run `node --check`, build, or test suite

## Common Patterns
```bash
# Node.js project
cat package.json | head -20    # understand the project
npm run build                   # verify it builds
npm test                        # run tests

# Python project
cat requirements.txt            # dependencies
python3 -m py_compile file.py   # syntax check
python3 -m pytest               # run tests

# Git
git status                      # check state
git diff --stat                 # see changes
git log --oneline -5            # recent history
```
