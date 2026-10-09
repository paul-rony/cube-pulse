# Cube Pulse

A Cube app that keeps track of the agent sessions open in your Cube, for when many run at once across projects:

- **Working now, ready for you, earlier**: every Claude Code and Codex session open in Cube, grouped by state, newest
  first, filterable by project.
- **What each is up to**: two lines per session (what it is working on; where it stands or what it needs from you),
  written by a small model from its recent conversation, and rewritten only when the session has moved on.
- **What each made**: images, pages, videos, PDFs and 3D models it wrote, or named and changed while open, with
  thumbnails and a viewer. "Made lately" gathers them across all sessions.
- **One session, without leaving Pulse**: its conversation on the middle page, your messages, its replies and the steps
  it took in between (folded into one line each), following it live while it works, with earlier history a page at a
  time. Beside it, its summary and everything it made. Pulse shows sessions; it does not type into them.

Pulse only looks. It reads Cube's catalog (the daemon's `catalog.json`: titles, folders, which sessions are working
and which have finished a turn) and each session's own transcript (`~/.claude/projects/…`, `~/.codex/sessions/…`),
following transcripts as they grow and starting long ones near their end. The only thing it runs is the small model
for summaries (Haiku through Claude Code, or Codex's lightest model), signed in as those already are.

## Running it

```sh
PORT=4771 node server.mjs
```

Summaries are kept in `~/.local/state/cube-pulse` (`PULSE_STATE`). If Cube's daemon folder is somewhere unusual, set
`CUBE_DAEMON_DIR`. Plain Node, no dependencies.

Cube's catalog file is not a published interface, so a Cube update can change it; Pulse reads only a few fields of it.
