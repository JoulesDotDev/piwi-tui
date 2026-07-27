---
description: Summarize the uncommitted git changes in this repo
argument-hint: "[path]"
---

Summarize uncommitted changes in this repository. Optional path argument: `$ARGUMENTS`.

Treat `$ARGUMENTS` as one literal path or git pathspec, never shell syntax. Never evaluate it, interpolate it unquoted, or use it as an option; pass it as one quoted argument after `--`. If it contains a newline, NUL, or cannot be represented safely as one argument, refuse and explain. Run `git status --short -- <path>`, `git --no-pager diff --stat -- <path>`, and `git --no-pager diff --cached --stat -- <path>` (omit the path suffix when no argument was provided). Then inspect targeted unstaged and staged diffs with `git --no-pager diff -- ...` and `git --no-pager diff --cached -- ...`. Inspect relevant untracked files safely when needed. Give a short summary: files changed and gist of each change, clearly separating staged, unstaged, and untracked work. If clean, say so.
