# jay

Jira Cloud in VS Code and Cursor. jay gets a sidebar of its own with a
tree of epic → task → sub-task for one project and one period, and
each ticket opens as an editor tab you can read and edit.

jay has no AI in it. It keeps a plain-text copy of the ticket in front,
so an agent beside it (Claude Code, the Claude CLI, or any agent that
reads files) knows which ticket "this ticket" means, and can summarize
it or change it with a Jira MCP server.

jay is not made by or affiliated with Atlassian.

- **Sidebar:** jay's icon in the Activity Bar. A search box, a project
  picker and a period picker, then the tree. The badge counts mentions
  and new comments.
- **Ticket tabs:** the path, title, fields, description and comments,
  all editable in place. Nothing is sent to Jira until you act.

## Install

- **VS Code:** install **jay** (`seanahn.jay`) from the Marketplace.
- **Cursor:** jay isn't on Open VSX yet. Get the .vsix (the Marketplace
  page's **Download Extension** link, or `make package` in a checkout),
  then install it by hand with **Extensions: Install from VSIX…**.

## Signing in

jay works with Jira Cloud only. There are three ways to sign in:

| Way | How | When to use it |
| --- | --- | --- |
| **An API token** | Run **jay: Sign In**. It asks for your site (for example `https://example.atlassian.net`), your email and an [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens). | The usual way. The email and token go in the editor's secret storage; the site goes in `jay.site`. |
| **An OAuth token file** | Set `jay.signIn.tokenFile` to a credentials JSON file another login tool writes, with `access_token`, `cloud_id` and `jira_url`. Optionally set `jay.signIn.refreshCommand` (for example `your-login --refresh`). | If another tool already signs you in to Jira with OAuth. jay runs the command when the token is about to expire, then re-reads the file. |
| **A jira-mcp wrapper or env file** | Set `jay.signIn.tokenFile` to a file with `JIRA_URL`, `JIRA_USERNAME` and `JIRA_API_TOKEN` lines, such as the wrapper script you start a Jira MCP server with. | If you already have that file. jay reads the three lines; `export` and quotes are fine. |

- When `jay.signIn.tokenFile` is set, it wins over an API token.
- jay reads a token file, re-reading it when it changes. It never runs
  it and never writes it.
- **jay: Sign Out** deletes the API token from secret storage and the
  files under `~/.jay`, in every window. It never touches a token file.
- The sidebar's account line says which sign-in is in use, for example
  "Signed in as alex@example.com (API token)".

## The sidebar

- **Search:** typing filters the tree by key or title. After 3
  characters, jay also searches all of Jira and lists other matches
  under "Jira results". A full key, such as `DEMO-123`, offers "Open
  DEMO-123".
- **Project picker:** type to filter by key or name. Your 5 most
  recent projects come first.
- **Period picker:** a quarter, a sprint or a fix version (see
  "Periods").
- **Mine | All**, at the end of the account line. Mine shows every
  epic that holds something of yours, with its whole tree; other
  people's tickets show in grey. All shows every epic, Unclaimed first,
  then Claimed.
- **Columns:** each row shows the columns in `jay.columns`. The
  default is key, summary, assignee and status; you can add type,
  priority, due, labels and estimate.

The tree is cached, so it shows at once when the window opens, then
refreshes in the background.

## Confluence

jay also shows Confluence, with the same sign-in. A `Jira | Confluence`
switch at the top of the sidebar picks the side. The Confluence side has
a search box, a space box, your mentions, your pages and the space's page
tree. Clicking a page opens it as a tab, where you can read it, edit it
and comment, for example on `https://example.atlassian.net/wiki/spaces/ENG/pages/12345`.

The page in front is written to `~/.jay/current.confluence`. To let an
agent use it, add a line like this to your CLAUDE.md:

```
- Confluence: when I say "this page" without a link, read ~/.jay/current.confluence (written by jay); change Confluence only when I say so.
```

Set `jay.confluence.enabled` to `false` to hide the switch and stop
polling for mentions. With an OAuth token file, the login that wrote it
must have granted Confluence's granular scopes (such as
`read:page:confluence`), and saved them as `scope` in the file; without
them the Confluence side says "This sign-in can't use Confluence yet".
Jira is unaffected.

Design and rulings: [docs/notes/102-confluence.md](docs/notes/102-confluence.md).

## Periods

`jay.period` chooses what the period picker lists.

**Quarters** (the default) are matched on epics. Tasks and sub-tasks
belong to their epic's quarter.

- `jay.quarter.fiscalYearStart` is the month your fiscal year starts
  (1 is the calendar year). The fiscal year is named by the year it
  ends in.
- `jay.quarter.patterns` lists how epics mark their quarter: `label:`
  templates match a label exactly, and `summary:` templates match part
  of the title. They use `{YYYY}`, `{YY}` and `{Q}`.

For example, if your fiscal year starts in May and epics carry a label
like `FY2027Q3` or a title like `Backups [Q3FY27]`, set:

```json
"jay.quarter.fiscalYearStart": 5,
"jay.quarter.patterns": ["label:FY{YYYY}Q{Q}", "summary:[Q{Q}FY{YY}]"]
```

Q3 FY27 is then November 2026 to January 2027.

**Sprints** lists the active sprints of the project's boards, then a
few future and recently closed ones. It needs Jira Software; if the
sign-in can't read boards, jay falls back to quarters.

**Fix versions** lists the project's unreleased versions, then a few
recently released ones.

For sprints and versions, the tickets carry the period, and jay shows
each one under its epic, with "No epic" last.

## Which view opens a ticket

`jay.ticketView` decides what a click opens, in the tree, in "Jira
results" and on "Open KEY".

- **`jay` (the default):** jay's own ticket tab.
- **`atlassian`:** the issue page of Atlassian's own
  extension, "Atlassian: Jira, Rovo Dev, Bitbucket"
  (`atlassian.atlascode`). jay keeps its sidebar.
- **A soft dependency:** jay doesn't require that extension. If it
  isn't installed, or its command fails, jay opens its own tab instead
  and says "Opened in jay's view: <reason>" once per window.
- **When the Atlassian page loses its sign-in:** if its page stays
  "Jira Issue" for 15 s while jay can read the ticket, jay closes it and
  opens the ticket in its own tab. It offers **Restart extensions** once
  (it never restarts by itself, since that restarts every extension in
  the window). Clicks then go to jay's tab until you restart, or run
  **jay: Use the Atlassian View Again** after signing in again there.
- **Where it opens:** in the first (leftmost) editor group, whichever
  group you last clicked in.
- **The agent still knows the ticket.** On each click jay fetches the
  ticket and writes `~/.jay/issues/<KEY>.jira` and `current.jira`, as
  for its own tab. While the Atlassian page of a ticket jay opened is the
  active tab, it is the ticket in front; closing that page removes its
  file.
- **`jay`:** jay's own ticket tab, described below. Set
  `"jay.ticketView": "jay"` in your settings to always use it, for
  example if the Atlassian extension changes.

## Editing in the tab

- **Fields:** status (Jira's transitions for the ticket), assignee
  (with **Assign to me**), priority, due date and labels. Picking a
  value sends it.
- **Title, description and comments:** edited in place, as formatted
  text. Nothing is sent until you press Save or Comment. You can edit
  your own comments.
- **Content jay can't edit,** such as tables, panels and images, is
  kept exactly as it is. You can move or delete it, but not edit
  inside it.
- **Conflicts:** before saving, jay re-reads the field. If it changed
  in Jira since you opened it, jay doesn't save; it keeps your draft and
  offers Reload.
- **Failures:** jay never resends a write by itself. Your draft is
  kept, with Retry.

## Notifications

A ticket lights up until you open it:

- **A mention of you** in a comment or the description: the ticket
  pulses.
- **A new comment** by someone else on a ticket assigned to you: the
  ticket turns bold.
- **A new epic** in the project and quarter: bold, marked "new".

jay sees these only on the tickets it polls: the tree, your open tabs,
and tickets assigned to you anywhere on the site. A mention on a ticket
outside those isn't seen.

## The agent hook

Each open ticket is written as plain text to `~/.jay/issues/<KEY>.jira`,
and `~/.jay/current.jira` is the one most recently in front. To have
your agent use it, add this line to `~/.claude/CLAUDE.md` (jay never
writes it):

```
- Jira: when I say "this ticket", "this issue" or "the epic" without a key, read ~/.jay/current.jira (written by jay); change Jira only when I say so, with the Jira MCP server and the keys in it.
```

- **Claude Code** (panel or CLI, in VS Code or Cursor) reads it from
  `~/.claude/CLAUDE.md`.
- **Cursor's own agent:** add the same line in Cursor Settings → Rules
  → User Rules.
- **perch** picks up the ticket in front automatically, through the
  `jay.activeIssueFile` command.
- Other extensions can call the hidden `jay.openTicket` (key) and
  `jay.projectKeys` commands; perch uses them to link ticket keys in
  Claude's replies.

## What jay writes to disk

Everything is under `~/.jay`, with directories mode 700 and files mode
600:

- `cache/`: the cached trees. Each file belongs to the account that
  wrote it and is never shown to another.
- `issues/*.jira`: one file per open ticket tab (jay's, or an
  Atlassian page jay opened), removed when the tab closes.
- `current.jira`: the ticket most recently in front.
- `seen.json`: when you last looked at each ticket.

Set `jay.agentFiles` to `false` to stop writing `issues/` and
`current.jira`; they are deleted when you do. **jay: Sign Out** deletes
all of these. jay never writes a token file.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `jay.site` | (empty) | Your Jira Cloud site URL, for API-token sign-in |
| `jay.signIn.tokenFile` | (empty) | A token file another tool keeps: OAuth JSON, or a jira-mcp wrapper or env file. Wins when set |
| `jay.signIn.refreshCommand` | (empty) | A command that refreshes an OAuth token file |
| `jay.period` | `quarter` | What the period picker lists: `quarter`, `sprint` or `fixVersion` |
| `jay.quarter.fiscalYearStart` | `1` | The month the fiscal year starts, 1 to 12 |
| `jay.quarter.patterns` | `["label:FY{YYYY}Q{Q}", "label:FY{YY}-Q{Q}", "summary:[Q{Q}FY{YY}]"]` | How epics mark their quarter |
| `jay.placeholderAssignees` | `[]` | Display names or account ids that count as unclaimed, for example `["Team Queue"]` |
| `jay.columns` | `["key", "summary", "assignee", "status"]` | Row columns, in order; also `type`, `priority`, `due`, `labels`, `estimate` |
| `jay.ticketView` | `atlassian` | What a click opens: `atlassian`, the Atlassian extension's issue page (jay's tab if it isn't installed or fails), or `jay`, jay's own tab |
| `jay.agentFiles` | `true` | Write each open ticket to `~/.jay` for an agent |
| `jay.confluence.enabled` | `true` | Show the Jira \| Confluence switch and poll Confluence mentions |

`jay.site`, `jay.signIn.tokenFile` and `jay.signIn.refreshCommand` are read only from your user settings (or the remote's settings in a remote window); a workspace's `.vscode/settings.json` can't change them.

## Development

```
make install     # links this checkout into VS Code / code-server; reload the window
make test        # offline tests: no network, no real token
make package     # a .vsix
make vendor      # rebuilds the committed ProseMirror bundle, media/prosemirror.js
```

## Design

What jay is for and the decisions behind it:
[docs/notes/101-design.md](docs/notes/101-design.md).

## License

MIT. The ticket editor bundles ProseMirror (MIT); its license texts are
in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
