# DraftLoop

Review local HTML drafts like a shared document, then hand the feedback back to
the Copilot session that wrote them.

- Type changes directly in the page.
- Select text, or right-click a diagram or image, to comment.
- See every saved version in History, compare versions, and restore one.
- Copilot reads comments and inline changes through MCP, edits the draft, and
  replies. The page refreshes with the new version.

The goal is to keep the review in the session that already has the context.
DraftLoop stores feedback; it does not run its own AI agent.

## Requirements

Node.js 22 or later. No packages to install. Tested with Microsoft Edge.

## Use

```powershell
node cli.mjs serve                  # run the local server (keep it running)
node cli.mjs open path\to\draft.html
node cli.mjs status
node cli.mjs feedback path\to\draft.html
```

In a Copilot session, use the `draftloop` skill. It starts the server (in a
Herdr pane when available), opens the draft, and handles the review loop.

## Connect Copilot

These commands change your Copilot configuration for every session:

```powershell
copilot skill add C:\git\draftloop\skills
copilot mcp add draftloop -- node C:\git\draftloop\cli.mjs mcp
```

Both read this folder directly, so updates apply without reinstalling. Restart
Copilot (`/restart` keeps the current session) to load the MCP tools.

## MCP tools

| Tool | Purpose |
|---|---|
| `list_review_documents` | Drafts, latest version, open comments, edit lock |
| `get_review_feedback` | Open comments and the user's inline changes |
| `begin_document_edit` | Lock the editor; returns the file to edit |
| `finish_document_edit` | Save the edit as a new version and unlock |
| `cancel_document_edit` | Discard the edit and unlock |
| `reply_to_review_comment` | Reply, and optionally resolve |

## Data

- `<draft>.draftloop\` next to each draft: versions, comments, edit lock.
- `~/.draftloop\`: registry of drafts and the running server's address
  (`DRAFTLOOP_HOME` changes it).

Every saved change is kept as a full copy of the draft. Nothing is deleted.

## Security

The server listens on `127.0.0.1` only and checks the host name. API calls need
a random token created at startup and passed in the editor link. Drafts are shown
with a content security policy that blocks scripts and remote requests.

## Limits in 0.0.1

- One user, one machine. No live co-editing.
- Diagrams and images take comments as a whole; edit them through Copilot.
- Comments that span edited text may lose their highlight; the comment stays.
- History compares visible text, not layout or styles.

## Tests

```powershell
npm test
node test/browser.e2e.mjs <draft.html> <screenshot-folder>
```

The browser check uses a temporary copy of the draft and headless Edge or Chrome.
