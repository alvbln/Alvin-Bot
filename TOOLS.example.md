# Custom Tools

> Define your own tools here. The bot parses this file automatically.
> Each `##` heading creates a new tool. The heading text becomes the tool name.
>
> **Supported fields:**
> - First line after heading = description
> - `` `command` `` in a code block = shell command (use `{{param}}` for parameters)
> - **Type:** `http` for HTTP tools (default: `shell`)
> - **URL:** endpoint for HTTP tools
> - **Method:** GET, POST, PUT, DELETE (default: GET)
> - **Headers:** `Key: Value` (one per line)
> - **Body:** request body for POST/PUT
> - **Timeout:** `30s`, `5m`, or milliseconds (default: 30s)
> - **Parameters:** list with `- name (type): description`

## deploy
Deploy the application to production
```
ssh server 'cd /app && git pull && pm2 restart all'
```
**Timeout:** 60s

## disk_usage
Check disk usage on the system
```
df -h / | tail -1
```

## quick_note
Append a note to a file
```
echo '{{text}}' >> ~/notes.txt
```
**Parameters:**
- `text` (string, required): The note text to append

## server_health
Check if the server API is responding
**Type:** http
**URL:** https://api.example.com/health
**Method:** GET
