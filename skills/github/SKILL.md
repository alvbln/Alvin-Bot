---
name: GitHub
description: Manage GitHub issues, PRs, and repos via gh CLI
triggers: github, gh, issue, pull request, pr, repository, repo, merge, branch
priority: 6
category: development
---

# GitHub via gh CLI

Use the GitHub CLI (`gh`) for all GitHub operations.

## Issues
```bash
gh issue list
gh issue create --title "Title" --body "Body"
gh issue view 123
gh issue close 123
```

## Pull Requests
```bash
gh pr list
gh pr create --title "Title" --body "Body"
gh pr view 123
gh pr merge 123
gh pr checks 123
```

## Repository
```bash
gh repo view
gh repo clone owner/repo
gh release list
gh release create v1.0.0
```

## Search
```bash
gh search issues "query" --repo owner/repo
gh search prs "query"
```
