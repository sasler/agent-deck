# agent-deck

A Claude Code mod that puts every background agent in one live **Agents** pane: OpenAI Codex runs, Claude subagents, GitHub Copilot, OpenCode and any other coding-agent CLI you add. The pane also shows your Claude and Codex usage limits and the state of the main conversation's prompt cache, and it can keep that cache warm while you're away.

## What it shows

- **Usage limits.** Each provider's limits as a meter with a percentage and a reset countdown:
  - Claude's 5-hour and weekly windows;
  - Codex's limits, read from its session files;
  - Copilot's monthly premium requests, read through the GitHub CLI (`gh api copilot_internal/user`).

  Under ⚙ Harnesses → **Usage meters** you choose which ones show: all connected, only those used in this session, or a selection.
- **Prompt cache.** Whether the cache is warm or cold and how long it has left. It also estimates what a cold re-write of the current context would cost compared with a warm turn.
- **Keep-warm.** Pick 2, 4 or 6 hours in the cache box, or type `/keepwarm 90m`. agent-deck then sends a tiny tool-less request just before the cache would expire, so a coffee break doesn't cost you a full re-write.
- **Cold-send guard.** When the context is 50k tokens or more and the cache has gone cold, agent-deck holds your first message back once and shows the price. Press **Send anyway** in the band above the prompt (or send it again) to go ahead, or **Discard** it. After **Send anyway** the band says at once that it was sent and that the cache is being re-written, since that can take a while before the reply starts. Change this with `/cache guard refuse|warn|off`.
- **Live agent cards.** Each running agent gets a card with:
  - its model and reasoning effort
  - the tools it is running
  - the latest output
  - tokens in and out, cache-hit rate and an API-equivalent cost
  - Copilot's premium requests, for Copilot runs

  Finished cards collapse into a list.

## Harnesses: Copilot, OpenCode, Gemini, Cursor and more

Open the **Agent Deck** pane (`/agent-deck`, or the **Agents** button above the prompt), then click **⚙ Harnesses**. The pane's title shows the version that is running.

- **Add** a harness from a preset (Copilot, OpenCode, Gemini CLI, Cursor Agent, Claude Code) or as a **Custom** command.
- **Edit** a harness's command, arguments, default model, color and output format.
- **Switch** each harness on or off.
- **Pick a model** for each harness. The edit form asks the harness which models it can run as it opens and offers them in one **Model** dropdown: the CLI's default first, **Other…** last to type an id, and ↻ to ask again. The list comes from:
  - Copilot: its ACP server (`copilot --acp --stdio`), which reports the models your account has, with their premium-request multiplier;
  - OpenCode: `opencode models`;
  - Codex (custom harness): Codex's own model cache;
  - Claude Code: its aliases and current model ids;
  - a harness on your own API: the API's `/models` endpoint.

  Gemini, Cursor and custom CLIs have no way to list their models, so the form shows a field to type the id. The listed models are also offered to Claude in the `agent_run` tool.

On first start, agent-deck adds the presets whose CLI it finds on your PATH.

Claude starts a harness with the `agent_run` tool, for example: "have Copilot write the tests for this module in the background". Each run:

- runs as its own detached process, so it survives a plugin reload or a dropped session;
- streams into a card in the pane;
- delivers its final report back to the conversation as a new message when it finishes.

`agent_result` reads a run on demand.

**Codex** has three modes, chosen with Codex's **Edit** button in the Harnesses list:

- **Built in.** The `codex` and `codex_result` tools, with model, effort, sandbox and resume. It also gives a live card for every Codex run, including ones started in a terminal or the Codex app, and the Codex usage meters.
- **Custom harness.** Codex runs through `agent_run` like any other harness, from a `codex exec --json` command you can edit.
- **Off.** For people who don't use Codex.

On first start, the built-in Codex is on if `codex` is on your PATH. Its On/Off button switches it any time.

**Your own API (BYOK).** Copilot and Claude Code harnesses can send their model calls to an API you choose instead of their own service, the way Copilot's *bring your own key* works: the CLI's agent still runs on your machine, with its tools and file edits, and only the model calls go to your endpoint. Add the **Copilot (own API)** preset, or open any Copilot or Claude Code harness's **Edit** form, and set **Model API**:

- **OpenAI-compatible**: OpenAI, OpenRouter, or a local Ollama, vLLM or LM Studio (`http://127.0.0.1:11434/v1`), with Chat Completions or Responses wire format;
- **Azure OpenAI**;
- **Anthropic**, or an Anthropic-compatible gateway (the only kind Claude Code takes).

Then give the **API base URL** and **API key**, and set the default model to the id the API expects. The model has to support tool calls and streaming. agent-deck passes these to the CLI as environment variables (`COPILOT_PROVIDER_*` and `COPILOT_MODEL`, or `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`). The key is kept in agent-deck's settings as plain text. A run gets it through a file in its folder that the runner deletes before the CLI starts, so it isn't left in run files or shown in the command.

Runs start without a shell, so nothing in a prompt is expanded or re-quoted. On Windows, an npm `.cmd` shim starts as the Node script it wraps; any other `.cmd`/`.bat` is refused, so point the command at the program itself.

The arguments are a template. `{prompt}`, `{model}`, `{session}` and `{cwd}` are filled in, and a flag whose value is empty is dropped along with its placeholder. For example, `--model {model}` disappears when no model is set. The edit form shows the exact command it will run.

| Preset | Command | Output read |
| --- | --- | --- |
| Codex | `codex exec --json --skip-git-repo-check …` | Codex exec JSON (custom mode) |
| Copilot | `copilot -p {prompt} --output-format json --allow-all-tools …` | Copilot JSON events, including premium requests |
| Copilot (own API) | the same, with a Model API set | Copilot JSON events |
| OpenCode | `opencode run --format json …` | OpenCode JSON events, including cost |
| Gemini | `gemini -p {prompt} --output-format stream-json --yolo …` | Gemini stream-json |
| Cursor | `cursor-agent -p {prompt} --output-format stream-json --force …` | Cursor stream-json |
| Claude Code | `claude -p {prompt} --output-format stream-json --verbose …` | Claude stream-json |
| Custom | anything | plain text |

> **Permissions.** The presets run the agents headless with their "allow all tools" flag (`--allow-all-tools`, `--yolo`, `--force`). That lets a background agent edit files and run commands without asking. Narrow the flags in the edit form if you want less, for example Copilot's `--allow-tool` and `--deny-tool`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install agent-deck --marketplace sasler/agent-deck
```

From a shell:

```bash
claude plugin install agent-deck --marketplace sasler/agent-deck
```

In the desktop app, click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `sasler/agent-deck`, then **Add plugin**.

**Requirements**
- **Node.js on your PATH.** It runs the Codex watcher and the background runner.
- **The agent CLIs you want to use**, installed and signed in: `codex`, `copilot`, `opencode`, and so on.
- **The GitHub CLI (`gh`), signed in,** for the Copilot usage meter.

## Update

agent-deck is not in the official plugin directory: this repository is its own marketplace, named `agent-deck`. To get a new version, refresh that marketplace, then update the plugin:

```bash
claude plugin marketplace update agent-deck
```

```bash
claude plugin update agent-deck@agent-deck
```

Then restart Claude Code, or run `/reload-plugins`. At the prompt, `/plugin` → **Marketplaces** → `agent-deck` does the same, and can switch on auto-update, which is off by default for marketplaces other than Anthropic's.

## Commands

| Command | What it does |
| --- | --- |
| `/agent-deck` | Opens the Agents pane |
| `/keepwarm [2h \| 90m \| off \| status]` | Keeps the prompt cache warm for a window (bare: 2h) |
| `/cache [status \| guard refuse \| guard warn \| guard off]` | Shows the cache state and sets the cold-send guard |

## Notes

- **Cache state is an estimate**, tracked from your requests on the cache's time-to-live (1 hour by default; 5 minutes is picked up on a model switch). Nothing asks the server.
- **Dollar figures are API-equivalent prices.** On a subscription they are a yardstick, not your bill.
- **Keep-warm pings use tokens.** Each one is a short cache read, a small fraction of what a cold re-write costs.
- **Run files live under `~/.claude/agent-deck/`.** Each run keeps its prompt, events and report there.
- **Strata cards are optional.** agent-deck also shows requests to a local model server at `127.0.0.1:8080` when one is running. Without it, nothing happens.

## Credits

The prompt-cache status, keep-warm and cold-send guard follow the idea of [**cache-tax** by karanb192](https://github.com/karanb192/cache-tax). Thanks for the inspiration.

## Development

```bash
claude plugin validate .
claude plugin test .
```

The engine writes the API types into `.claude-plugin/types/` when it loads the mod. After that, `tsc -p . --noEmit` type-checks it.

## License

MIT
