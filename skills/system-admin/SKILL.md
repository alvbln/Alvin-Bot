---
name: System Administration
description: Server management, deployment, monitoring
triggers: server, deploy, deployment, pm2, nginx, ssh, vps, docker, systemctl, service, logs, monitor, disk space, cpu, memory usage
priority: 3
category: devops
---

# System Administration Skill

When managing servers and deployments:

## Health Check Pattern
```bash
# System overview
uptime && free -h && df -h / && top -bn1 | head -5

# PM2 processes
pm2 list && pm2 logs --lines 10 --nostream

# Nginx
nginx -t && systemctl status nginx

# Docker
docker ps && docker stats --no-stream
```

## Deployment Checklist
1. **Build** locally first — never deploy broken code
2. **Backup** config files before changing them
3. **Test** after deploy — check logs, hit endpoints
4. **Rollback plan** — know how to undo your changes

## Guidelines
- **Always check before changing** — read config files before editing
- **Backup first** — `cp file file.bak-$(date +%Y%m%d-%H%M%S)`
- **PM2 env vars** — use `ecosystem.config.cjs` + `--update-env`, never raw `pm2 start`
- **Logs first** — when debugging, always check logs before guessing
- **One change at a time** — don't change 5 things and wonder which broke it
