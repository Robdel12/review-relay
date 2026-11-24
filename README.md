# Review Relay

I kept checking GitHub to see whether someone had responded to a review. The chat where I did the work already had the context, so I built a way to link it to the PR once and come back when there’s something to do.

![Review Relay dashboard with example pull requests, deliveries, and watch history](docs/dashboard.png)

## What it watches

- **Your PRs.** Changes requested, reviews with written feedback, and new inline review comments from other people.
- **PRs you review.** Review and re-review requests assigned to your GitHub account.

Each watch starts with new activity after you link the PR. Approval keeps it open for another round. Closing or merging moves the link to History. You can stop a watch anytime.

## How it works

Review Relay uses your existing `gh` login to check linked PRs every two minutes. Click the polling status in the toolbar to change the interval. Links and delivery history live in SQLite on your Mac.

Review Relay adds a follow-up to the linked Codex chat's queue. If the chat is closed, open it in Codex to pick up the follow-up. This keeps the chat's stop and steer controls available where it runs. Claude Code picks up waiting feedback when you resume the linked session or send your next prompt. With `terminal-notifier` installed, you also get a macOS notification when feedback arrives.

For your own PR, the agent can work through feedback in a clean checkout at the current PR head. For a PR you review, it checks what changed and drafts findings in the session. GitHub reviews, replies, and pushes are yours to send. Keep the dashboard on your Mac and use author watches with repositories and reviewers you trust.

### Watch lifecycle

```mermaid
flowchart TD
    Link["Link a PR to a session"] --> Watch["Watch for new activity"]
    Watch --> Event{"What happened?"}
    Event -->|"New feedback or review request"| Agent{"Which agent?"}
    Agent -->|"Codex"| Codex["Queue a follow-up in the chat"]
    Agent -->|"Claude Code"| Claude["Hold feedback for the next prompt or resume"]
    Codex --> Watch
    Claude --> Watch
    Event -->|"PR merges, closes, or you stop watching"| History["Move the link to History"]
```

## Get started

You’ll need macOS, Node 24+, a signed-in GitHub CLI, and either the Codex desktop app or Claude Code. Run these from this checkout.

```sh
npm ci
npm link
pr-chat init
PR_CHAT_GH="$(command -v gh)" pr-chat start
```

`pr-chat init` adds hooks and installs the skill for both agents. Pass `codex` or `claude` to set up just one. It keeps existing skills and other hooks. In Codex, use `/hooks` to trust new hooks. If your Codex delivery CLI is installed elsewhere, set `PR_CHAT_CODEX` to its absolute path when starting the app.

Open the [dashboard](http://127.0.0.1:4317) to see your watches and their delivery history. Keep the app running while you want it to check GitHub.

## Link from a chat or the terminal

Use `$pr-chat` in Codex or `/pr-chat <PR URL>` in Claude Code. You can also run `pr-chat link <PR URL>` from either agent. The hooks can link new PRs opened through `gh pr create`, including several opened by one command, and review prompts with `$pull-request-review` and a single PR reference.

From a separate terminal, pass a session reference explicitly.

```sh
pr-chat link https://github.com/owner/repo/pull/123 'codex://threads/<chat-id>'
pr-chat link https://github.com/owner/repo/pull/456 'claude:<session-id>'
pr-chat list
pr-chat unlink https://github.com/owner/repo/pull/123
```

Add `--worktree /absolute/path` if the PR has its own checkout. In the dashboard, **Open chat** opens Codex, and **Copy resume command** gives you the command to reopen a Claude Code session from its checkout.

The **Delivery log** shows whether a follow-up is waiting, queued in Codex, handed to Claude Code, or failed. For an active watch, **Requeue** sends an accepted follow-up again and **Retry** attempts a failed delivery.

## Development

The reviews domain lives in `api/domains/reviews`. Cricket loads its routes, service, and two state machines. The machines take the current state and an event and return the next state. Cricket manages the SQLite connection. Review Relay runs its inbox migrations during setup. The service saves transitions in a transaction. Jobs poll GitHub, queue Codex feedback, and send desktop notifications. The worker runs inside the app and reads pending work from SQLite after a restart. Its local queue coalesces wakeups for polling and delivery.

Run `npm run inspect` to see the routes, machines, and jobs. Run `npm test` to exercise the watch and delivery flow through the local app. CI runs `npm run check` before the tests to check formatting, lint rules, and the Cricket app.

There’s also an [optional push relay](docs/push.md) if you want GitHub webhooks.
