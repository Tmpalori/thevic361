# Claude Code instructions

This repo's agent instructions live in [`AGENTS.md`](./AGENTS.md). Read that file before making changes.

It covers:

- Architecture (collector → candidates → admin → Railway Postgres → live site)
- The `--candidates-only` invariant and why `docs/events.json` is *not* the source of truth
- File layout, run/test commands, conventions
- Don't-touch list and PR checklist
- Environment variables (full reference in `RAILWAY.md`)

The same content is mirrored for Cursor in `.cursorrules`.
