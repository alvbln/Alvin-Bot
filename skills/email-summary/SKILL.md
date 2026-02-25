---
name: Email Summary
description: Create professional email summaries and daily digests
triggers: email summary, email digest, mail zusammenfassung, mails zusammenfassen, email übersicht, inbox summary, email report
priority: 5
category: productivity
---

# Email Summary Skill

When creating email summaries or daily digests:

## Workflow
1. **Fetch emails** using available tools (osascript for Apple Mail, himalaya for IMAP)
2. **Summarize YOURSELF** — you ARE the AI, do NOT call external LLM APIs
3. **Structure** the output clearly (by account, by priority, by topic)
4. **Deliver** in the requested format (text, PDF, or both)

## Summary Guidelines
- **1-2 sentences per email** — capture the core message, skip fluff
- **Language:** Match the user's preferred language
- **Prioritize:** Flag urgent/action-required emails prominently
- **Group by:** Account → Read status (unread first) → Time

## Apple Mail Access (macOS)
```bash
osascript -e '
tell application "Mail"
  set output to ""
  repeat with acct in accounts
    set acctName to name of acct
    repeat with mb in mailboxes of acct
      if name of mb is "INBOX" then
        set msgs to (messages of mb whose date received > (current date) - 1 * days)
        repeat with m in msgs
          set output to output & acctName & " | " & sender of m & " | " & subject of m & " | " & (date received of m as string) & " | " & (read status of m as string) & linefeed
        end repeat
      end if
    end repeat
  end repeat
  return output
end tell'
```

## PDF Generation
If a PDF is requested, create an HTML file and convert it. Use a clean, professional design.
