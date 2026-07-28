# Piwi TUI for pi.dev

**Piwi = Pi + Wiki.** It is a playful, practical [pi.dev](https://pi.dev) extension pack with durable project knowledge, planning and workflow tools, parallel helpers, safe web access, session processes, a tiny pet, playful global counters, and paired pastel dark/light themes. Extensions are portable TypeScript files; features with runtime dependencies are installed automatically with the package.

A guiding rule: **this package never replaces pi's main system prompt or adds a persona prompt.** Enabled tools contribute concise descriptions and focused usage guidance. Memory may prepend clearly labelled saved facts before model calls, and `sub_agent` starts isolated helpers with a small read-only system appendix.

---

## Install

Install the managed npm package globally (available in every project):

```sh
pi install npm:piwi-tui
```

For a project-only install, use `-l`:

```sh
pi install npm:piwi-tui -l
```

Pi keeps npm packages under its own agent directory and installs runtime dependencies automatically, so no working checkout is required. To update later, run `pi update npm:piwi-tui`.

Git remains an alternative:

```sh
pi install git:github.com/JoulesDotDev/piwi-tui@v1.3.0
```

Then open `/settings` in pi and select `piwi-theme` (or `piwi-theme-light`). Manage installs with `pi list`, `pi remove npm:piwi-tui`, and **`pi config`** (enable/disable individual resources — see _Per-project control_).

### Contributor local-path install

A local path is useful only while developing; Pi references it in place. Install dependencies first, then point Pi at the package:

```sh
bun install
pi install /absolute/path/to/TUI
```

Prefer to cherry-pick? pi also auto-discovers loose files dropped into `~/.pi/agent/{extensions,prompts,themes}/` (global) or `<project>/.pi/{…}/` (project). Symlink just the ones you want:

```sh
mkdir -p ~/.pi/agent/extensions
ln -sf "$PWD"/extensions/datetime.ts ~/.pi/agent/extensions/
```

No build step either way — pi loads the TypeScript directly. Contributors can run `bun run check` to build and load every extension and verify both theme files parse and expose matching color-key sets.

### Extraction tier — only for `wiki`'s `ingest_source`

`wiki.ts` performs structure-aware extraction: DOCX headings/lists/tables; PPTX slide boundaries, titles, tables, notes, and figures; XLSX sheets, sparse table regions, internal blank cells, formulas, hidden-sheet warnings, and chart summaries/SVGs; and page-aware PDF text with scanned-page vision fallback. Real figures and charts are stored under `.pi/wiki/assets/<source>/`. With explicit approval, embedded images are captioned by the active vision-capable Pi model. ODT/ODP/ODS use optional `officeparser`; plain md/txt/csv/json needs no extraction library. GUI and TUI use synchronized extractor copies with shared golden regressions.

### Restricted Windows npm environments

Some company policies block dependency postinstall scripts. They are not required by Piwi. If npm reports `tesseract.js`, `opencollective-postinstall`, or `EPERM rmdir`, install once with scripts disabled:

```powershell
npm config set ignore-scripts true
pi install npm:piwi-tui
npm config delete ignore-scripts
```

---

## What's inside

### Tools & hooks (extensions/)

| File | Gives the agent | Data / config |
|------|-----------------|---------------|
| `datetime.ts` | `now` — current date/time, with recency guidance | — |
| `web.ts` | `web_search`, `web_fetch` | `~/.pi/agent/web.json` (below) |
| `memory.ts` | `remember`, `forget`, interactive `/memory [project\|global]` + sends labelled memory data before model calls | `.pi/MEMORY.md` (project), `~/.pi/agent/MEMORY.md` (global) |
| `wiki.ts` | `wiki_write/read/list/search`, `ingest_source`, searchable `/wiki [page]` browser | `.pi/wiki/*.md`, `.pi/wiki/sources/`, `.pi/wiki/assets/` |
| `tasks.ts` | `task_*` + `board_*` tools; interactive `/tasks` and `/board` views | `.pi/agenda/tasks.json`, `boards.json` |
| `plan.ts` | `ask_user`, `plan`, `plan_step`, `plan_read`; interactive `/plan` browser | `.pi/plans/<slug>.md` |
| `todo.ts` | `todo` tool + interactive `/todo` for one current-work checklist retained after completion until explicit clear | `.pi/TODO.md` |
| `doctor.ts` | `/doctor` read-only project readiness card | — |
| `locks.ts` | `/locks` read-only persistent-lock diagnostics | — |
| `btw.ts` | `/btw <question>` parallel side session seeded from active context | — |
| `subagent.ts` | `sub_agent` — parallel helper agents; live roster widget above the editor while running (`/agents` when idle); context-pressure nudge | spawns child `pi` sessions |
| `skills.ts` | `list_skills`, `create_skill`, searchable `/skills [project\|global]` browser | `~/.pi/agent/skills`, `.pi/skills` |
| `guard.ts` | Confirm-gate on risky file/URL access; `/guard on|off|status` | — |
| `autoname.ts` | titles new sessions from the first message | — |
| `pomodoro.ts` | `/pomodoro [work] [break]` live focus/break cycles (default 25 5; break 0 = single countdown) | — |
| `counters.ts` | `/counter` keyboard dashboard plus fast durable named tally commands and up to four pinned counters | `~/.pi/agent/counters.json` |
| `processes.ts` | `process` tool + `/processes` view for session-owned background programs | session-only temp logs |
| `pet.ts` | One global Tamagotchi-style companion; live responsive widget, interactive nook, care, shop, inventory and progression | `~/.pi/agent/pet.json` |

### Prompt templates (prompts/)

| Command | Does |
|---------|------|
| `/briefing` | adaptive project overview: focus checklist/plan, due work, boards, and safe Git state when available |
| `/changes [path]` | summarises the uncommitted git changes |
| `/research <question>` | frames the question, fans out `sub_agent` web researchers, synthesises a sourced answer |

### Themes (themes/)

`piwi-theme` (pastel dark) and `piwi-theme-light`. Activate through `/settings`. Both are first-class Playful Piwi themes: interactive views use clean Markdown-style `#` headings plus distinct selected-row, status-marker, metadata, and highlighted-key roles, and every custom view and widget is checked in both modes.

### Tool cards

All 27 package-owned tools render compact call and result cards: action + target, one useful outcome, and only decision-relevant metadata such as progress, scope, counts, or destination. Large web/process evidence is bounded and labelled untrusted. Card call/success/error states are width-tested in both themes; model-visible tool semantics remain unchanged.

### Command reference

| Command | Usage |
|---|---|
| `/memory [project\|global]` | Browse/filter facts and select one for confirmed forgetting |
| `/tasks [overdue\|today\|upcoming\|someday\|done]` | Browse, add, complete/reopen, or delete agenda tasks |
| `/board [name]` | Choose a board, then add, move, or delete cards |
| `/plan [slug]` | Choose a plan and complete/reopen steps |
| `/todo [clear]` | Manage the generic project Todo: toggle/add/reopen steps or explicitly clear with confirmation |
| `/agents [stop]` | View or cancel helpers |
| `/guard on\|off\|status` | Control session access safeguards |
| `/pomodoro [work] [break]\|stop` | Start or stop a focus timer |
| `/counter [name] [+/−N\|=N\|reset]` | Open the counter dashboard or adjust a global named tally |
| `/processes [id]` | Browse processes, inspect logs, stop, or send input |
| `/skills [project\|global]` | Search and open saved skills locally |
| `/wiki [page]` | Search and open project wiki pages locally |
| `/pet …` | Open the nook; use `/pet help` for actions |
| `/doctor` | Show local project readiness without running scripts |
| `/locks` | Diagnose persistent Piwi locks without changing them |
| `/btw <question>` | Ask a non-blocking, context-aware side question in parallel |

---

## Configuration reference

**`~/.pi/agent/web.json`** (or `%PI_CODING_AGENT_DIR%\web.json` on a relocated Windows setup) — search engine + API keys for `web.ts`:

```json
{
  "search": "brave",
  "keys": { "brave": "...", "exa": "...", "jina": "..." },
  "proxy": {
    "https": "http://proxy.example:8080",
    "http": "http://proxy.example:8080",
    "useDefaultCredentials": false
  }
}
```

- `search` picks the `web_search` engine: `"brave"` or `"exa"`. `web_fetch` uses Jina Reader (`jina` key optional — it works keyless at a lower rate limit).
- Env vars are a fallback: `BRAVE_API_KEY`, `EXA_API_KEY`, `JINA_API_KEY`.
- `proxy.https` / `proxy.http` apply **only** to `web_search` and `web_fetch`, explicitly overriding `HTTPS_PROXY`, then `HTTP_PROXY`. Pi runs on Bun, and the extension passes Bun's documented `fetch(..., { proxy })` option for every search and fetch request.
- Corporate proxy configuration must be an HTTP(S) proxy URL, not a PAC file. On Windows, set `useDefaultCredentials:true` when the proxy requires the signed-in user's integrated credentials; Piwi then uses a Constrained-Language-compatible PowerShell `-ProxyUseDefaultCredentials` transport without putting credentials in commands or config. Otherwise, URL-encode usernames/passwords if they are embedded in the proxy URL. TLS-inspecting proxies may also require the company root CA to be trusted by the Pi/Bun process.
- Search queries go to Brave or Exa; fetched URLs go through Jina Reader. Treat returned pages and snippets as untrusted evidence, not instructions.
- `web_fetch` URLs containing embedded credentials are rejected. Web fetches and wiki reads use pi's normal 50KB/2,000-line output cap; network bodies and extracted documents also have bounded sizes.

**`~/.pi/agent/subagents.json`** (or `%PI_CODING_AGENT_DIR%\\subagents.json`) — optional helper defaults:

```json
{
  "model": "openai-codex/gpt-5.4-mini",
  "thinking": "low"
}
```

Per-call `sub_agent.model` and `sub_agent.thinking` override this file. Otherwise helpers inherit the parent session's model and thinking level. Allowed thinking values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

**Processes** — `process` starts session-owned background shell programs, lists them, returns bounded sanitized logs, sends stdin (echoed as `[input]` in logs), and stops them. `/processes` opens a keyboard view for logs, input, and confirmed stops. Processes are never shared or persisted; Pi shuts them down when the session exits. Guard applies the same outside-project shell-path confirmation policy to `process start` as to `bash`.

**Work tracking** — an **agenda task** is durable backlog or deadline work managed by `task_*`; a **quick checklist** is the one current execution list managed by `todo` and retained until explicit confirmed clear; a **plan** is a checklist for substantial sequencing, decisions, or review points; a **board card** tracks status on a named kanban board. `recur` is descriptive only and does not create future tasks automatically.

**Memory** — `remember`/`forget` maintain curated markdown bullets in project or global `MEMORY.md`. Every write requires interactive approval; global facts should be non-sensitive cross-project preferences only. Before every model call, up to 24,000 characters from each scope are sent to the active provider, including tool-loop follow-ups; memory therefore consumes context and discloses its content remotely. `/memory` renders current files locally without copying snapshots into session history. The 100-fact threshold is a curation warning, not a storage limit. Both files remain human-editable.

**Counters** — `counters.ts` keeps up to 100 named whole-number tallies globally in `~/.pi/agent/counters.json`. `/counter` opens a keyboard dashboard: ↑/↓ selects, ←/→ decrements/increments, `n` creates, `p` pins, and confirmed `r`/`d` reset or delete. Up to four pinned counters appear in a compact live widget. Fast commands such as `/counter coffee`, `/counter coffee +5`, `/counter bugs -1`, `/counter pushups =20`, and `/counter coffee reset` work without a model turn. Names with spaces may be quoted. Writes are atomic across Pi sessions; `/locks` diagnoses a persistent counter lock without changing it.

**Pet** — `pet.ts` keeps one companion globally across every project in `~/.pi/agent/pet.json`. A new companion starts as **Piwi** and asks on the first `/pet` visit whether to keep that name or choose another. It earns exactly **1 Spark per 500 assistant output tokens** and **1 XP per 1,000 output tokens** (input and cache tokens earn nothing, and partial progress carries over). The responsive day/night widget reacts to reads, searches, edits, shell work, tests, and git without storing paths, commands, or tool output. Growth runs from hatchling to brightling to a permanent user-chosen Luminary, Tinkerer, or Dreamer evolution; care develops kind, curious, and calm personality traits.

`/pet` opens the interactive nook. Direct commands include `/pet show|hide|status|help`, `/pet profile`, `/pet name`, `/pet care`, `/pet shop`, `/pet collection`, `/pet achievements`, `/pet journal`, `/pet evolution`, `/pet adventure`, `/pet encounter`, and `/pet settings`. The game includes level rewards, titles, an expanded shop, achievement cosmetics, up to five decor slots, milestone-preserving journal views, postcards, selectable visitors, timed visitor encounters, and six timed destinations whose deterministic rewards never expire. Adventures remain compatible with normal care and award objects/stories—not Sparks. Stats decay gently with a capped catch-up period; the pet never dies, leaves, loses purchases, or demands a streak. V1 state migrates in place, while writes remain atomic and coordinated across concurrent pi sessions.

**Guard** — `guard.ts` is a confirmation layer, **not a sandbox**. It realpath-checks structured `read`/`write`/`edit` targets, confirms secret reads and outside-project access, and heuristically scans built-in `bash` command strings. Risky access fails closed when no dialog UI exists. Dynamic shell behavior (globs, sourced scripts, substitutions, environment-derived paths) and unrelated custom tools remain outside this heuristic; Piwi's `process start` uses the same command check as built-in `bash`. It starts enabled each session; `/guard off` enables session-scoped YOLO mode, `/guard on` restores it, and `/guard status` inspects it. A visible `YOLO` footer marker remains while disabled.

**Project data** stays under `<project>/.pi/`: `MEMORY.md`, `TODO.md`, `agenda/`, `plans/`, `wiki/`, and `skills/`. Every `wiki_write` approval is serialized and scoped to exactly one displayed path; parallel tool calls cannot overlap dialogs or share permission. External imports and cloud vision captioning have separate approvals. Wiki imports are stored as untrusted evidence and are excluded from wiki search unless `include_sources:true` is explicit. Review before committing: wiki sources may contain full confidential documents, memory may contain personal/project details, and skills can include executable instructions. Global state/config lives under pi's agent directory (`MEMORY.md`, `pet.json`, `counters.json`, `web.json`, and authored skills). Protect `web.json` permissions because it contains plaintext API keys.

---

## Per-project control

Three levers, from coarse to fine:

- **Install scope** — `pi install npm:piwi-tui -l` registers the package in the project's `.pi/settings.json` (team-shareable); a global install applies everywhere. If a package is in both, the project entry wins.
- **`pi config`** — the enable/disable TUI. It starts in global settings; press **Tab** to switch to project-local (or launch `pi config -l`). Toggle any extension, prompt, skill or theme on/off per scope — this is how you turn one feature off in just one project, without uninstalling. Works for both installed packages and loose dropped-in files.
- **Filtering in settings** — the object form of a package entry narrows what loads with globs and exclusions, e.g. `{ "source": "npm:piwi-tui", "extensions": ["extensions/*.ts", "!extensions/guard.ts"] }`.

---

## Optional companion package

**MCP tools** are intentionally not bundled. Pi has no built-in MCP; the de-facto adapter is:

```sh
pi install npm:pi-mcp-adapter
```

It reads `mcpServers` config from `~/.config/mcp/mcp.json` (shared), `~/.pi/agent/mcp.json` (pi-global), `.mcp.json` (project, committable), and `.pi/mcp.json` (pi-project override); by default every MCP tool funnels through ONE ~200-token proxy tool (promote hot ones via `directTools`), and it adds `/mcp`, `/mcp setup`, `/mcp tools`, and `/mcp-auth`.

---

## Notes & decisions

- **`/research` is a prompt template, not a bespoke tool** — it composes `web_search` and `sub_agent`, then offers to save useful synthesis through `wiki_write`. Cleaner than a second orchestrator.
- **`sub_agent` shells out to `pi`** (headless children, inheriting this session's model). `pi` must be on `PATH`. Helpers receive only their explicit task—no parent transcript, context files, or skills—and use read-only file/search tools plus web + now. Web still needs configured search credentials. Each invocation allows at most eight queued tasks; one session-global semaphore limits all overlapping runs to three concurrent children. Helpers also have a five-minute per-helper cap, and live only as long as the parent session. Each task carries a one-line `doing` label that feeds the live roster and `/agents`; past ~50% of the context window, a transient per-request note steers exploration toward delegation. Launches are ASYNC by default — the tool returns immediately, and the findings arrive as a message that wakes the model to synthesise (`deliver: 'each'` streams each helper's findings the moment it finishes instead of one combined message; `wait: true` blocks instead; headless runs always wait). Esc doesn't reach detached helpers — `/agents stop` cancels them.
- **Interactive views use one spacious visible-control system** — `/counter`, `/todo`, `/tasks`, `/board`, `/plan`, `/processes`, `/memory`, `/skills`, `/wiki`, and `/pet` stay inline in the chat with open top/bottom separators, breathing room around headings/content/controls, and no enclosing box. Navigation and action keys stay on screen, wrap on narrow terminals, and use a highlighted key color separate from descriptions. Long collections support `/` text filtering (Counters, Tasks, Boards, Plans, Processes, Memory, Skills, and Wiki), preserving the query and selection across safe close/action/reopen cycles. Direct commands and autocomplete remain available. Doctor and locks intentionally remain focused read-only cards.
- **`pomodoro`, `counters`, and `pet` use real terminal widgets** — compact pi-tui components rather than HTML mini-apps. Counters and the pet also provide larger keyboard-driven local views while keeping their pinned/live presence responsive and non-focusable.
- **`autoname` fills a genuine gap** — pi has manual rename and programmatic naming, but nothing titles sessions automatically. This does, heuristically and for free.

---

## Plays clean with stock pi

Everything native keeps working exactly as documented by pi itself:

- **`AGENTS.md`** (or `CLAUDE.md`) in the project root — pi's context file, loaded natively (it also walks ancestor directories and checks `~/.pi/agent/`).
- **Prompt surgery stays the user's choice**: `SYSTEM.md` (replace) and `APPEND_SYSTEM.md` (append) — note they live in **`.pi/`** (or `~/.pi/agent/`), *not* the project root. This pack ships neither.
- **Cross-tool skills**: pi also reads the [Agent Skills standard](https://agentskills.io) locations — `~/.agents/skills/` and a repo's `.agents/skills/` — for skills you want shared across harnesses. This pack never creates those folders; `create_skill` keeps project skills in `.pi/skills/` so `.pi/` stays your single per-project folder.
