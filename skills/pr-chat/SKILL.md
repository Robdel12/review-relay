---
name: pr-chat
description: Link a GitHub pull request to the current Codex chat, check its watch status, or stop watching it in PR Chat.
---

# PR Chat

When invoked on its own, link the PR already identified in this chat. Ask for the GitHub PR URL if the target is unclear.

- **Watch:** Run `pr-chat link "$pr_url"` from the current chat. The CLI uses `CODEX_THREAD_ID` and infers the role from the active `gh` login. If the ID is unavailable, pass the current chat's verified deep link as the second argument. If a different chat already watches the PR, surface the conflict.
- **Verify:** Confirm the PR number, role, and open status from the link output or `pr-chat list`.
- **Stop:** When asked to stop watching, run `pr-chat unlink "$pr_url"`. This stops delivery and keeps the link visible in History.

PR Chat stops watching when GitHub reports the PR merged or closed. Approval leaves the watch active for another review round. A reopened PR can be linked again.
