---
description: A short briefing from this project's tasks and boards
---

Give me a concise, adaptive briefing for this project. Use only available tools; if an expected project tool is unavailable or blocked (for example because the project is untrusted), say so once under **Environment** and do not bypass it by reading its files directly.

1. Call `now` to anchor today's date.
2. When available, call `task_list`, `board_list`, `todo` with `{ "action": "read" }`, and `plan_read`.
3. Check whether this is a Git work tree with the safe read-only command `git rev-parse --is-inside-work-tree`; only if it is, run `git status --short`. Do not run project scripts, installs, tests, or network commands.

Write only relevant non-empty sections, in this order:

- **Focus** — active quick checklist and/or plan, with the next unfinished step when clear.
- **Due** — overdue and due-today agenda tasks.
- **In progress** — notable board work.
- **Workspace** — concise Git state, only in a Git work tree.
- **Environment** — unavailable/blocked resources or an important limitation, only when relevant.
- **Next** — one to three concrete next actions.

If there is no work state yet, say so in one friendly line and suggest the most useful first action. Keep the whole report brief, skimmable, and evidence-based. Do not invent items or claim guard/agent status you cannot verify.
