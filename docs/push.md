# GitHub push delivery

Polling works with your existing GitHub login. The optional Cloudflare relay holds signed events while your Mac sleeps. Set it up for one GitHub repository.

1. Set `GITHUB_REPOSITORY` in `wrangler.jsonc` to `owner/repo` and deploy with Wrangler from an approved Cloudflare account.
2. Generate two separate values with `openssl rand -hex 32`. Use `wrangler secret put` to store them as `GITHUB_WEBHOOK_SECRET` and `BRIDGE_TOKEN`.
3. Have an owner install a GitHub App on the repository with **Pull requests** read access. Point the app’s webhook at `https://<relay-host>/github`, use the webhook secret, and subscribe to **Pull request**, **Pull request review**, and **Pull request review comment**.
4. Open **Settings → Push relay** in PR Chat and enter the relay URL and bridge token.
5. After GitHub sends a signed delivery and all active links are subscribed, run `pr-chat cutover`.

The relay stores PR and event IDs so it can replay deliveries. Chat IDs and worktree paths stay on your Mac. GitHub delivery history can be used to resend events that missed the relay.
