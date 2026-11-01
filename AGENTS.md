# AGENTS.md

agent-deck is a Claude Code plugin (a "mod"). It shows every background agent in one live **Agent Deck** pane: Codex, Claude subagents and CLI harnesses such as Copilot and OpenCode. The pane also shows usage limits, the prompt cache, keep-warm and the cold-send guard. [README.md](README.md) describes it from the user's side.

## Layout

| Path | What it is |
| --- | --- |
| `hooks/register.tsx` | The mod: hooks, tools (`codex`, `agent_run`, …), the pane and the band above the prompt |
| `hooks/harness.ts` | Harness presets, argument templates, BYOK env, model queries, output parsers. No `$` calls, so it is easy to test |
| `hooks/cache.ts` | Prompt-cache state, keep-warm and the cold-send guard |
| `types/index.d.ts` | Shared types and the plugin's state atoms |
| `bin/run.mjs` | Detached runner for one harness run (`spec.json`, plus an `env.json` it deletes before starting) |
| `bin/models.mjs` | Asks a harness's CLI or API which models it has |
| `bin/launch.mjs` | Starts a CLI without a shell; shared by both scripts |
| `bin/watch.mjs` | Codex session watcher |
| `tests/agent-deck.test.tsx` | All tests |
| `.claude-plugin/plugin.json` | Manifest and version |

## Commands

```bash
claude plugin test .
claude plugin validate .
```

`tsc -p . --noEmit` works only once the engine has written `.claude-plugin/types/`, which happens when it loads the mod.

## Rules

- **Never start a CLI through a shell.** Prompts must reach the CLI unexpanded. On Windows, `launch.mjs` resolves npm `.cmd` shims to the script they wrap and refuses any other batch file.
- **Keep API keys out of run files, argv and logs.** Pass them to `bin/*.mjs` through a file the script deletes before it does anything else.
- **Put pure logic in `harness.ts` or `cache.ts`** and test it there. Test the UI with `$.ui.mount` and the keys of its controls.
- **Write UI text and docs in plain words:** what it does and what the user does next. The README covers every user-visible feature; update it in the same change.
- **Bump the version** in `.claude-plugin/plugin.json` for every change users get: minor for a feature, patch for a fix. The pane's title shows it.

## Commits and pull requests

Start every commit subject and every PR title with a [gitmoji](https://gitmoji.dev). A release commit names the version after it:

```
✨ agent-deck 0.11.0: a model picker for each harness
🐛 agent-deck 0.10.2: Send anyway shows at once that it was sent
📝 README: how to update agent-deck
```

Common ones: ✨ feature, 🐛 fix, 💄 UI, ♻️ refactor, ✅ tests, 📝 docs, 🔖 release, 🔧 config.

The subject is one short line. The body says what changed and why.
