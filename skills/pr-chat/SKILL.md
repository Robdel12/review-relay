---
name: pr-chat
description: Link a GitHub pull request to the current coding session, check its watch status, or stop watching it in Review Relay.
---

# Review Relay

When invoked on its own, link the PR already identified in this chat. Ask for the GitHub PR URL if the target is unclear.

- **Watch:** Run `pr-chat link "$pr_url"` from the current session. The CLI uses `CODEX_THREAD_ID` or `CLAUDE_CODE_SESSION_ID` and infers the role from the active `gh` login. If the ID is unavailable, pass the verified Codex chat link or `claude:<session-id>` as the second argument. If another session watches the PR, surface the conflict.
- **Verify:** Confirm the PR number, role, and open status from the link output or `pr-chat list`.
- **Stop:** When asked to stop watching, run `pr-chat unlink "$pr_url"`. This stops delivery and keeps the link visible in History.

Review Relay stops watching when GitHub reports the PR merged or closed. Approval leaves the watch active for another review round. A reopened PR can be linked again.
