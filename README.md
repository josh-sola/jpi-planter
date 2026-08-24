# jpi-planter

A Pi coding-agent extension that reports session state to
[Planter](https://github.com/josh-sola/jrepo/tree/main/claude-planter), the
macOS overlay that shows a plant per coding session so you can tell at a
glance which one needs you.

## What it does

The extension writes Planter's provider-neutral state records for interactive
Pi TUI sessions. JSON, print, and RPC sessions do not create records. It
tracks:

- **Lifecycle** — session start, whether the agent is working or waiting for
  you, and session shutdown (including reloads).
- **Subagents** — work delegated to pi-subagents counts as the session
  working, not waiting.
- **Background tasks** — work started through pi-background-tasks. Starts
  have no broadcast, so the extension polls once per second and may take up
  to a second to show new work.
- **User questionnaires** — a pending ask-user-question prompt marks the
  session as needing your attention.

These integrations talk over public event-bus protocols and stay inactive
when their packages are absent. Pi has no general event for every permission
or input prompt, so prompts from other integrations show up as the session's
normal working or waiting state rather than a dedicated "blocked" state.

Records are written under
`${PLANTER_STATE_DIR:-${CLAUDE_PLANTER_DIR:-~/.claude/planter}}`. The
`PLANTER_COLOR`, `PLANTER_LABEL`, and `PLANTER_TAB_INDEX` environment
variables apply to Pi the same way they do to other Planter providers.
Sessions started without them get Planter's normal automatic defaults.

You need the Planter app installed separately for any of this to be visible.

## Install

```sh
pi install git:github.com/josh-sola/jpi-planter
```

## Development

```sh
npm install
npm test
pi -e .   # load this checkout as an extension in a Pi session
```
