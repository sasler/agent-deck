# agent-deck

A Claude Code mod that puts every background agent in one live **Agents** pane: OpenAI Codex runs, Claude subagents, GitHub Copilot, OpenCode, Google Antigravity and any other coding-agent CLI you add. The pane also shows your Claude and Codex usage limits and the state of the main conversation's prompt cache, and it can keep that cache warm while you're away.

## What it shows

At the top of the pane sit three controls: **♨ Keep warm**, **⇄ Routing** and **⚙ Settings**. Under them come the prompt cache, the usage limits, then the agent cards. **⚙ Settings** opens the settings in a pane of their own (see [Settings](#settings)), so the deck stays in view.

- **Usage limits.** Each provider's limits as a meter with a percentage and a reset countdown. Claude comes first, followed by the other providers in alphabetical order (Antigravity, Codex, Copilot) — in the expanded rows, the folded one-line summary and ⚙ Settings → **Usage meters**:
  - Claude's 5-hour and weekly windows, and every other limit your plan reports, such as a Team or Enterprise plan's spend limit or a weekly Opus limit;
  - Antigravity's weekly and 5-hour limits for each model group (Gemini, Gemini 4 Argon, Claude & GPT), the same numbers agy's `/usage` shows. A small switch at the right of the **Antigravity** title picks how many show: **Basic** (the default) shows Gemini's 5-hour and weekly limits, **Gemini** adds Gemini 4 Argon, and **All** shows every one. agent-deck remembers the choice, and the folded one-line summary counts only the limits that show. agent-deck asks agy itself every ten minutes and after each Antigravity run, while an Antigravity harness is switched on. It never reads your Google sign-in. To ask, agy opens a session, so agent-deck keeps reopening one session rather than adding a new empty conversation to agy's history each time;
  - Codex's limits, read live from the Codex CLI (`codex app-server`) at session start, every ten minutes while the built-in Codex is switched on, and on **↻ Refresh**, falling back to Codex's newest session file if the CLI cannot answer. Live runs continue to update the meters as Codex writes them, and an older session file never replaces a newer live reading;
  - Copilot's monthly AI credits, read through the GitHub CLI (`gh api copilot_internal/user`).

  Within each provider, the 5-hour limit comes before the weekly one.

  The **Usage limits** header has three controls:
  - **▾ / ▸** folds the meters into one line with each provider's highest percent, and opens them again;
  - the view switch picks **All**, **Used here** (the providers this session used) or **Selected**. It is the same setting as ⚙ Settings → **Usage meters**, where you also pick which providers **Selected** shows, and the Antigravity view;
  - **↻ Refresh** reads every provider's limits again now — for Codex, live from the Codex CLI (falling back to its last session file if needed) — and says **Refreshing…** while it does.

  A reading older than 15 minutes says how old it is, for example `updated 3h ago`. When a window's reset time has passed since the reading, the meter shows `0%` dimmed with **reset since this reading** instead of a countdown. If Codex could not be read live, the pane shows one dim line saying why with a **Retry** button.
- **Prompt cache.** Whether the cache is warm or cold and how long it has left. It also estimates what a cold re-write of the current context would cost compared with a warm turn, and shows whether keep-warm is on.
- **Keep-warm.** Pick 2, 4 or 6 hours with **♨ Keep warm** at the top of the pane, or type `/keepwarm 90m`. agent-deck then sends a tiny tool-less request just before the cache would expire, so a coffee break doesn't cost you a full re-write.
- **Cold-send guard.** When the context is 50k tokens or more and the cache has gone cold, agent-deck holds your first message back once and shows the price. Press **Send anyway** in the band above the prompt (or send it again) to go ahead, or **Discard** it. After **Send anyway** the band says at once that it was sent and that the cache is being re-written, since that can take a while before the reply starts. Change this with `/cache guard refuse|warn|off`.
- **Live agent cards.** Each running agent gets a card with:
  - a header line with the agent, its model by name (as the model pickers show it, for example `Gemini 4 Neon (High)` or `Opus 5.5`), its reasoning effort, how it stands and how long it has run, and the task's title under it
  - the tools it is running
  - the latest output: its last 12 lines, newest at the bottom, so an open card stays a fixed size. **Show all** shows every line the card kept, **Show less** goes back
  - tokens in and out, cache-hit rate and an API-equivalent cost
  - the AI credits a Copilot run used, with a breakdown by concrete model, including Fusion and subagent work; missing billing is shown as not reported, and incomplete billing as a subtotal

  Finished cards collapse into a list. The pane keeps a session's cards when the session is reopened.

## Settings

Open the **Agent Deck** pane (`/agent-deck`, or the **Agents** button above the prompt), then click **⚙ Settings** at the top right. The settings open in a pane of their own, **Agent Deck settings**, next to the deck, which stays open in its own tab. In the desktop app, ⤢ on the pane makes it larger. The deck's title shows the version that is running.

A row of tabs at the top switches between the sections:

- **Harnesses**: Codex and the other coding-agent CLIs, each on a card with its **On/Off** switch and **Edit**;
- **Task routing**: who does each kind of work (see [Task routing](#task-routing-who-does-which-kind-of-task));
- **Usage meters**: which providers' limits show, and the Antigravity view;
- **Codex**: how Codex runs, and which Codex CLI it starts.

**Done** closes the settings pane, and so does Escape. Where a second pane can't open, the settings show in the deck itself until you press **Done**.

## Harnesses: Copilot, OpenCode, Antigravity, Gemini, Cursor and more

Under ⚙ Settings → **Harnesses** you can:

- **Add** a harness from a preset (Copilot, OpenCode, Antigravity, Gemini CLI, Cursor Agent, Claude Code) or as a **Custom** command.
- **Edit** a harness's command, arguments, default model, color and output format.
- **Switch** each harness on or off.
- **Pick a model** for each harness. The edit form asks the harness which models it can run as it opens and offers them in one **Model** dropdown: the CLI's default first, **Other…** last to type an id, and ↻ to ask again. The list comes from:
  - Copilot: its ACP server (`copilot --acp --stdio`), which reports the models your account has, with their price category (low, medium or high);
    it also offers **Auto** and **Copilot Fusion** Standard and Max. Fusion selections, including ones saved by earlier versions of agent-deck, run as `--model auto --auto-tier hydrafusion` or `hydrafusion-max`, with `--experimental`. The CLI checks whether your account supports that profile. A rejected profile or a routing fallback is shown on the card rather than hidden;
  - OpenCode: `opencode models`;
  - Antigravity: `agy models`, which lists the Gemini, Claude and other models your plan has, one id per effort level (for example `gemini-4-neon-high`);
  - Codex (custom harness): Codex's own model cache;
  - Claude Code: its aliases and current model ids;
  - a harness on your own API: the API's `/models` endpoint.

  Gemini, Cursor and custom CLIs have no way to list their models, so the form shows a field to type the id. The listed models are also offered to Claude in the `agent_run` tool.

On first start, agent-deck adds the presets whose CLI it finds on your PATH.

Claude starts a harness with the `agent_run` tool, for example: "have Copilot write the tests for this module in the background". Each run:

- runs as its own detached process, so it survives a plugin reload or a dropped session;
- streams into a card in the pane;
- delivers its final report back to the conversation as a new message when it finishes, once, even when agent-deck reloads meanwhile or a second copy of it (a dev copy beside the release) watches the same runs.

`agent_result` reads a run on demand.

**Copilot routing and spending.** In a Copilot harness's edit form, **Auto routing profile** selects Efficiency, Balance, Intelligence, or a Fusion preview profile and switches the model to Auto. Leave it at the CLI's default to keep the CLI's own choice. **AI credit limit** sets `--max-ai-credits` (minimum 30), a session-wide soft limit that includes subagents and hidden model work. A response can exceed it before the next call is blocked. Claude can override these settings through `agent_run`'s `autoTier` and `maxAiCredits` inputs. Auto and Fusion are GitHub routing features, not BYOK features.

Fusion's draft, critique, and revision phases show as separate activities with the model doing the work when the CLI reports them. Intermediate phase drafts are not delivered as the final report. The CLI's JSON stream may omit usage events, so agent-deck also asks for `--usage-output-file` and reads its final per-model totals before marking the run finished. Checkpoints and final totals replace running totals, so phases and subagents are not counted twice. Per-model usage is included in the completion report as well as the card. If you set a custom usage file in Arguments, don't share it between concurrent runs.

**Codex** has three modes, chosen under ⚙ Settings → **Codex** (Codex's **Edit** button under Harnesses opens it too):

- **Built in.** The `codex` and `codex_result` tools, with model, effort, sandbox and resume. It also gives a live card for every Codex run, including ones started in a terminal or the Codex app, and the Codex usage meters.
- **Custom harness.** Codex runs through `agent_run` like any other harness, from a `codex exec --json` command you can edit.
- **Off.** For people who don't use Codex.

On first start, the built-in Codex is on if `codex` is on your PATH. Its On/Off button switches it any time.

**Which Codex CLI runs use.** You may have more than one Codex installed: the npm one (`npm i -g @openai/codex`), the standalone installer's, WinGet's. agent-deck looks at all of them and starts the newest, not just the first one on your PATH. An old Codex doesn't know the newest models. It also checks npm for the latest published version and tells you when yours is older. agent-deck looks again every ten minutes at most, so this doesn't slow down runs. The **Codex** tab shows which Codex runs start with, every other one it found, and these controls:

- **Codex path** starts a Codex of your choice instead. You can also set the `CODEX_PATH` environment variable, which wins over this field.
- **Look again** checks for installs right away.
- **Update Codex (npm)** runs `npm i -g @openai/codex@latest`.

Each run's card shows the Codex version and path it started with, and so does its report.

**Before a run starts**, agent-deck checks the model against the chosen Codex's own model list (`codex debug models`). If Codex doesn't know the model, the run doesn't start, and you see which Codex has the model, or that an update is out. This check is skipped when your `config.toml` sets another `model_provider`.

**Long steps show while they run.** A card lists Codex's tool calls as they start, including code-mode cells and `wait` calls that can run for minutes, so you see the step it is on, not just "thinking…". If Codex writes nothing for two minutes, the card says so. That usually means Codex is stuck on the step still shown as running.

**When a run fails**, its report and `codex_result` show Codex's actual error, for example `model_not_found`, a usage limit or a sandbox error, not just `codex exited 1`.

**Antigravity** runs Google's Antigravity CLI (`agy`) headless with `--output-format stream-json`. Its card shows each tool step as it runs (a command shows as `$ …`), the reply as it streams, and the tokens of every step, cache reads included. Claude can continue an earlier conversation by passing its id as `agent_run`'s `resume` (agy's `--conversation`). A failed run reports agy's own error, for example an unknown model. Antigravity gives no price, so its cards show tokens without a cost. Its usage limits show with the other meters.

**Your own API (BYOK).** Copilot and Claude Code harnesses can send their model calls to an API you choose instead of their own service, the way Copilot's *bring your own key* works: the CLI's agent still runs on your machine, with its tools and file edits, and only the model calls go to your endpoint. Add the **Copilot (own API)** preset, or open any Copilot or Claude Code harness's **Edit** form, and set **Model API**:

- **OpenAI-compatible**: OpenAI, OpenRouter, or a local Ollama, vLLM or LM Studio (`http://127.0.0.1:11434/v1`), with Chat Completions or Responses wire format;
- **Azure OpenAI**, with Chat Completions or Responses wire format;
- **Anthropic**, or an Anthropic-compatible gateway (the only kind Claude Code takes).

Then give the **API base URL** and **API key**, and set the default model to the id the API expects. The model has to support tool calls and streaming. agent-deck passes these to the CLI as environment variables (`COPILOT_PROVIDER_*` and `COPILOT_MODEL`, or `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`). The key is kept in agent-deck's settings as plain text. A run gets it through a file in its folder that the runner deletes before the CLI starts, so it isn't left in run files or shown in the command.

If startup fails and the temporary credentials file cannot be cleared, the error gives its path so you can remove it.

For Copilot's Anthropic provider, the API root and a URL ending in `/v1` both work; Copilot adds `/v1` to its requests.

For Copilot, **Base model id** and **Deployment / wire model** are optional. Use them when an Azure deployment or fine-tuned model has a different name from its base model: for example, default model `gpt-5.4`, base model `gpt-5.4`, deployment `my-gpt-deployment`. They set `COPILOT_PROVIDER_MODEL_ID` and `COPILOT_PROVIDER_WIRE_MODEL`, so the CLI can use the base model's tool support and token limits while sending your deployment name to the API. A different per-run model override uses that model for both instead of the saved mapping. With Responses, you can also select **WebSockets** transport. Leave these fields empty for the usual HTTP path and selected model.

When a Copilot harness has its own Model API settings, its runs ignore inherited `COPILOT_PROVIDER_*` variables, including credentials and key-refresh commands, so they cannot mix with that endpoint. Without those settings, the CLI's existing environment and configuration still apply. Copilot's `--secret-env-vars` marks `COPILOT_PROVIDER_API_KEY` as secret, whether set in the harness or inherited: Copilot redacts it from output and removes it from shell and MCP environments. This does not change your global CLI settings.

Runs start without a shell, so nothing in a prompt is expanded or re-quoted. On Windows, an npm `.cmd` shim starts as the Node script it wraps; any other `.cmd`/`.bat` is refused, so point the command at the program itself.

The arguments are a template. `{prompt}`, `{model}`, `{session}`, `{cwd}` and `{effort}` are filled in, and a flag whose value is empty is dropped along with its placeholder. For example, `--model {model}` disappears when no model is set. The edit form shows the exact command it will run.

**Reasoning effort.** `agent_run` takes an `effort` for a harness whose CLI has a setting for it, and a route can set one (see Task routing). agent-deck puts the CLI's own flag in front of the prompt:

| CLI | Flag | Levels |
| --- | --- | --- |
| Copilot | `--reasoning-effort` | none, minimal, low, medium, high, xhigh, max (what works depends on the model) |
| Claude Code | `--effort` | low, medium, high, xhigh, max |
| Antigravity | `--effort` | low, medium, high, xhigh, max |
| OpenCode | `--variant` | minimal, low, medium, high, xhigh, max (each provider takes its own) |
| Codex (custom harness) | `-c model_reasoning_effort=` | minimal, low, medium, high, xhigh |

Gemini and Cursor have no effort setting, so they get no effort. A custom CLI gets one where you put `{effort}` in its arguments. Antigravity's model ids also name an effort (`gemini-4-neon-high`); `--effort` sets it for the run.

| Preset | Command | Output read |
| --- | --- | --- |
| Codex | `codex exec --json --skip-git-repo-check …` | Codex exec JSON (custom mode) |
| Copilot | `copilot -p {prompt} --output-format json --allow-all-tools …` | Copilot JSON events, including AI credits |
| Copilot (own API) | the same, with a Model API set | Copilot JSON events |
| OpenCode | `opencode run --format json …` | OpenCode JSON events, including cost |
| Gemini | `gemini -p {prompt} --output-format stream-json --yolo …` | Gemini stream-json |
| Antigravity | `agy --output-format stream-json --dangerously-skip-permissions … -p {prompt}` | Antigravity stream-json, including tokens |
| Cursor | `cursor-agent -p {prompt} --output-format stream-json --force …` | Cursor stream-json |
| Claude Code | `claude -p {prompt} --output-format stream-json --verbose …` | Claude stream-json |
| Custom | anything | plain text |

> **Permissions.** The presets run the agents headless with their "allow all tools" flag (`--allow-all-tools`, `--yolo`, `--force`, `--dangerously-skip-permissions`). That lets a background agent edit files and run commands without asking. Narrow the flags in the edit form if you want less, for example Copilot's `--allow-tool` and `--deny-tool`, or Antigravity's `--mode accept-edits` (edits only) or `--mode plan` (read-only) in place of `--dangerously-skip-permissions`.

## Task routing: who does which kind of task

Pick an agent and model for each kind of task, and Claude hands that work to them. For example, implementation goes to Codex, code review to Copilot on Claude Opus, research to Antigravity on Gemini, and UI design to a Claude subagent.

Set it up under ⚙ Settings → **Task routing**. Each kind of task has a card: its name and what it covers, a **Remove** button, and under them **Agent**, **Model** and **Effort** side by side. On a narrow pane the three wrap onto more lines.

- The cards start with **implement**, **review**, **research**, **image** and **ui**. Add your own at the bottom: type a name, for example `tests` or `docs`, and press **Add** (or Enter). **Remove** the ones you don't need.
- For each task, pick the **Agent**: any harness, the built-in **Codex**, or a **Claude subagent**. Then pick its **Model**, or leave it at the agent's default:
  - a harness offers the models its CLI reports, by name (for example `Gemini 4 Neon (High)`), with the model's id in a dim line under the field. agent-deck asks the CLI again when you pick the harness and when you open Settings (at most every ten minutes), and **↻** at the end of the Model field asks right away;
  - Codex offers the models of the Codex CLI it starts;
  - a Claude subagent offers Fable, Opus, Sonnet and Haiku, named with the version each runs.

  Where there is no list, type the model id.
- Pick its **Effort** (Default, Low, Medium, High, Extra high, Max, as the agent takes them), or leave it at the default: a harness whose CLI has an effort flag (the table above), the built-in Codex (minimal to xhigh) or a Claude subagent (low to max, the Agent tool's effort). Where the agent has no effort setting, the card says **No effort setting** instead. Picking another agent clears the model and effort.
- The **On/Off** button next to **Task routing**, or **⇄ Routing on/off** next to ⚙ Settings in the main view, switches routing on or off. `/agent-deck routing on`, `off` and `status` do the same from the prompt.

When routing is on, Claude gets a short note with your picks along with your next message. The note says which agent, model and effort gets each kind of task (for example `agent_run with task "ui" (Antigravity, model claude-opus-5-5-high, effort high)`), and that Claude keeps quick questions and small edits itself. The note goes out again after a compaction or `/clear`, and again whenever you change a pick. When you switch routing off, Claude is told so with your next message. Claude starts a routed harness with `agent_run` and the task's name (`task: "review"`), and agent-deck fills in the harness, model and effort. An explicit harness, model or effort that Claude passes still wins. `agent_run` reads your current picks each time it is called, so it follows them right after agent-deck reloads too.

A task routed to an agent that is switched off or missing shows a warning on its card. If Claude tries it, the run doesn't start, and Claude is told to ask you before using another agent.

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
- **The agent CLIs you want to use**, installed and signed in: `codex`, `copilot`, `opencode`, `agy`, and so on. Sign in to Antigravity once by running `agy` in a terminal.
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
| `/agent-deck routing [on \| off \| status]` | Switches task routing on or off, or lists who does each task |
| `/keepwarm [2h \| 90m \| off \| status]` | Keeps the prompt cache warm for a window (bare: 2h) |
| `/cache [status \| guard refuse \| guard warn \| guard off]` | Shows the cache state and sets the cold-send guard |

## Notes

- **Cache state is an estimate**, tracked from your requests on the cache's time-to-live (1 hour by default; 5 minutes is picked up on a model switch). Nothing asks the server.
- **Dollar figures are API-equivalent prices.** On a subscription they are a yardstick, not your bill.
- **Copilot costs are reported in AI credits**, not converted to dollars. Older request-based billing fields are ignored. BYOK charges are billed by your provider; the CLI may not report them, and agent-deck does not guess them from an unknown model or treat missing billing as a free run.
- **Current Copilot flags need a recent CLI.** Use `copilot update` if it rejects an Auto profile, WebSockets, or an AI credit limit. Fusion is a preview and can still be unavailable for your account or organization; agent-deck does not bypass those checks.
- **Keep-warm pings use tokens.** Each one is a short cache read, a small fraction of what a cold re-write costs.
- **A run needs its working folder to exist.** When the folder passed as `cwd` is missing, the run fails at once and says so.
- **Run files live under `~/.claude/agent-deck/`.** Each run keeps its prompt, events and report there.
- **Strata cards are optional.** agent-deck also shows requests to a local model server at `127.0.0.1:8080` when one is running. Without it, nothing happens.

## Credits

The prompt-cache status, keep-warm and cold-send guard follow the idea of [**cache-tax** by karanb192](https://github.com/karanb192/cache-tax). Thanks for the inspiration.

The Antigravity harness builds on what [**antigravity-for-claude-code** by yuting0624](https://github.com/yuting0624/antigravity-for-claude-code) (MIT) worked out about running `agy` headless: the prompt as `-p`'s value at the end, stdin detached, `--dangerously-skip-permissions` for unattended runs, and `--conversation` to resume. Thanks!

## Development

```bash
claude plugin validate .
claude plugin test .
node --test tests/runner.test.mjs
```

The engine writes the API types into `.claude-plugin/types/` when it loads the mod. After that, `tsc -p . --noEmit` type-checks it.

## License

MIT
