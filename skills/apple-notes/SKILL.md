---
name: Apple Notes
description: Read, create, and search Apple Notes via AppleScript
triggers: apple notes, notes app, notizen, note, notes, apple notizen
priority: 5
category: productivity
---

# Apple Notes

Access Apple Notes.app via AppleScript (macOS only).

## Read Notes
```bash
osascript -e 'tell application "Notes" to get name of every note in default account'
```

## Search Notes
```bash
osascript -e 'tell application "Notes" to get name of every note of default account whose name contains "search term"'
```

## Create Note
```bash
osascript -e 'tell application "Notes" to make new note at folder "Notes" of default account with properties {name:"Title", body:"Content"}'
```

## Read Note Content
```bash
osascript -e 'tell application "Notes" to get body of note "Note Title" of default account'
```
