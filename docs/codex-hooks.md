# Codex setup

Run `pr-chat init codex` to install the skill and add hooks to your existing configuration. Review and trust new hooks in Codex with `/hooks`.

## Manual setup

With `pr-chat` on your PATH, copy the [skill](../skills/pr-chat/SKILL.md) to `~/.codex/skills/pr-chat/SKILL.md`. Invoke `$pr-chat` in a chat that already knows its PR, or include the PR URL.

Add these entries to `~/.codex/hooks.json`, merging them with any hooks you already have. Replace `pr-chat` with its absolute path if Codex uses a different PATH.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "pr-chat hook", "async": true, "timeout": 25 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          { "type": "command", "command": "pr-chat hook", "async": true, "timeout": 25 }
        ]
      }
    ]
  }
}
```

Review and trust the hooks in Codex with `/hooks`. A prompt with `$pull-request-review` and one PR links a review chat. A `gh pr create` invocation links the new PR to its chat when the author and checkout match. Review Relay keeps an existing link until you stop it.
