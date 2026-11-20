# 101 — Design

What jay is for, what it does, and how it is built. Written 2026-11-19,
before any code, and kept up to date through the build. It now
describes jay as built (version 0.1.1).

Calls marked *(builder's call)* were made while writing this note, not
by Sean. Everything else is his. A fresh builder read it on 2026-11-19; its questions are settled
below as builder's calls. Sean approved the design, builder's calls
included, on 2026-11-19.

For installing and using jay, see the [README](../../README.md).

The plan (docs/superpowers/plans/2026-11-19-jay-v1.md) was deleted when the work was finished.

## Purpose

jay shows Jira inside VS Code and Cursor the way chirp
(`seanahn.chirp`) shows Teams:

- a sidebar of its own in the Activity Bar;
- tickets opened as editor tabs;
- a plain-text copy of the ticket in front, so the agent beside it
  knows which ticket "this ticket" means.

jay does no AI work itself. Claude (in a perch tab or the Claude Code
panel) does the reading and summarizing, using the Jira MCP server it
already has.

**The moment it exists for:** the start of a quarter. Sean's work lives
under epics, one set per quarter. When a quarter starts, its epics have
just been created and most have no assignee. Today Sean asks Claude
which epics he can take on, then has it assign epics, or tasks under
them, to him.

jay gives him a view built around epics and the quarter, for one
project at a time, showing either all the epics or only his. The rest
of the quarter works the same way: he sees his tickets in the tree,
with the ones around them, opens one in the middle, and asks Claude
about it on the right.

### Goals

- **The epic view.** A tree of epic → task → sub-task for one project
  and one quarter, as Mine or All. The default is Mine and the current
  quarter.
- **Unclaimed epics** are easy to spot at the start of a quarter.
- **The ticket tab.** The selected ticket opens in the middle, and Sean
  can edit it: comments, the description (in place, as formatted text,
  like the Jira web page) and fields.
- **The agent knows the ticket in front** with no per-session setup.
- **jay catches Sean's eye** when he's @mentioned, when someone
  comments on one of his tickets, or when a new epic appears in the
  quarter.
- **Anyone can use it.** It's published on the Marketplace for anyone
  on Jira Cloud.

### Non-goals (first version)

- Any AI inside jay.
- Creating, deleting, cloning or moving tickets.
- Boards, backlogs, saved filters, a free JQL box, or a "recent
  tickets" list *(builder's call; Sean asked for none of them)*.
  Sprints came back as a period choice (see "Periods").
- Worklogs, attachments upload, watchers, links between tickets.
- Jira Server / Data Center. Jira Cloud only *(builder's call)*.
- More than one Jira site at a time *(builder's call)*.
- Desktop notifications and sounds.

### Anti-goals

- **Writing to Jira when Sean didn't act.** jay never posts, comments,
  transitions, assigns or edits anything unless Sean does it himself.
  That includes no automatic retry that could repeat a write.
- **Losing content.** No edit may silently drop or mangle content,
  including tables, panels, images, mentions, or anything jay doesn't
  understand.
- **Overwriting someone else's change.** If a ticket changed in Jira
  after Sean started editing it, jay says so instead of saving over it.
- **Leaking a token.** jay never prints, logs or copies a token, or
  puts one in a file it writes.
- **Breaking another tool's login.** jay never writes a token file and
  never refreshes it except through the command Sean configures, which
  does its own locking. With OAuth, a reused refresh token makes
  Atlassian revoke the whole chain and log out every session.
- **Hammering Jira.** jay never fetches more than the tree needs. It
  backs off on 429 and 503, and slows down when the window isn't
  focused.

## What Sean sees

The mockups used real data and stay out of git.

```
| Activity | jay sidebar          | ticket tab (editor)        | Claude      |
|   bar    | [search…]  [DEMO▾]  [Q3 FY27▾]                    | chat        |
|   ◆ jay  | alex@example.com · Mine | All                     |             |
|          | ▾ ◆ DEMO-12          | ◆ DEMO-12 › DEMO-14 › DEMO-31            |
|          |   ▾ DEMO-14 (mine)   | Title                      |             |
|          |       DEMO-31 ◀ open | Status ▾ Assignee ▾ …      |             |
|          |       DEMO-30 (grey) | Description (editable)     |             |
|          |                      | Comments + [new comment]   |             |
```

### The sidebar

A webview view in jay's own Activity Bar container, built with
`textContent` only, like chirp's.

**The controls at the top**, in this order below the account line: the
search box, the project picker, then the period picker (Sean put search
first, 2026-11-19):

- **Mine / All**, at the end of the account line: "Signed in as
  alex@example.com (token file) · **Mine** | All" (Sean, 2026-11-19,
  during the live check). The current mode is bold. The other is a link
  that switches to it, and it can also be reached by Tab and switched
  with Enter. The separate switch row is gone. The default is Mine.
  While signed out, nothing is shown.
- **Project picker.** It lists the projects Sean can browse, with the
  last one used preselected *(builder's call)*. It starts empty, with a
  prompt to pick one, until Sean has picked a project.

  It is a type-to-filter box, not a plain dropdown, because a site can
  have hundreds of projects (Sean, 2026-11-19, during the live check):

  - **Filtering:** typing narrows the list to projects whose key starts
    with the text, or whose name contains it, ignoring case. Key
    matches come first.
  - **Recent projects:** the 5 projects used most recently (kept in
    jay's state) are listed first, under "Recent", whenever the box is
    empty or matches them.
  - **Keys:** ↑ and ↓ move through the list, Enter or a click picks a
    project, and Escape or leaving the box restores the current
    project's text without changing anything.
  - **Display:** the box shows the chosen project as `KEY — Name`. The
    list shows at most 50 rows, with a "type to narrow" line when there
    are more.
- **Period picker.** In quarter mode it offers the current quarter (the
  default), the next quarter, the previous four, and "Any quarter"
  *(builder's call)*. "Current" follows the fiscal-year setting (see
  "Quarters"). For sprints and fix versions, see "Periods".
- **Search box.** It filters the loaded tree by key or title as Sean
  types. A full ticket key that isn't in the tree (for example
  `DEMO-123`) offers "Open DEMO-123" *(builder's call)*.

  It also searches all of Jira, as Jira's own search box does (Sean,
  2026-11-19, during the live check):

  - **When it runs:** after at least 3 characters and a 400 ms pause in
    typing.
  - **The query:** JQL `text ~ "<query>" ORDER BY updated DESC`, with
    Lucene's special characters (`+ - & | ! ( ) { } [ ] ^ " ~ * ? : \ /`)
    backslash-escaped and the result escaped as a JQL string. When the
    text looks like a key, that issue is also fetched on its own and
    put first; a 404 or 400 for it (`UTF-8`, a mistyped key) is ignored.
    (`OR key = X` is not used: Jira rejects the whole query when X
    doesn't exist.) It returns at most 20 issues and covers every
    project Sean can see.
  - **Results:** they appear under the tree matches in a "Jira results"
    section, as flat rows with the same columns as the tree. Tickets
    already shown in the tree are left out of it. Clicking a row opens
    the ticket.
  - **Out of date answers:** only the latest query's results are shown.
    An answer to an older query is dropped.
  - **Errors:** a failed search shows one quiet line, "Jira search
    failed". It never touches the sign-in state or the pollers.
  - **Load on Jira:** only typing triggers it, so there's no polling.

The choices are remembered across reloads *(builder's call)*.

**The tree** has three levels: epic → task (any standard issue type:
Task, Story, Bug) → sub-task. Jira Cloud's standard hierarchy ends
there, since sub-tasks can't have children. A level above epics, where
a site has one, isn't shown.

In Mine, an epic that is included always shows its whole tree: any
epic with an item of Sean's in it appears with every task and
sub-task, and others' items show in grey.

Each row shows the columns in `jay.columns` (Sean, 2026-11-19, during
the live check). The default is `["key", "summary", "status"]`. The other choices are `type`, `priority`, `due`, `labels`
and `estimate`, the original estimate as Jira formats it, for example
`2d 4h`. The columns appear in the order listed. Unknown names are
ignored, and `summary` is always shown.

- In the sidebar, the assignee shows as a first name, or `-` when
  unassigned (Sean).
  A ticket assigned to Sean shows `me`, in green (the theme's
  `charts.green`), in the tree and in the Jira results (Sean, 2026-11-19).
- Status shows only when it isn't To Do *(builder's call)*.
- **Width matters** (Sean, 2026-11-19, during the live check). Each tree
  level is indented 8 px. A ticket in the selected project shows only
  its number in the key column (`16324`). Tickets from other projects
  (for example in Jira results) keep their full key.
- **Shared title labels are stripped** (Sean, 2026-11-20). When a
  parent's title starts with a label ending in a colon (for example
  `Acme Portal:`), a child whose title starts with the same label
  shows only the rest. The comparison ignores case and the spaces after
  the colon. This applies only to tree rows. The tooltip, the ticket tab
  and the agent file keep the full title.
- **The tooltip** on every row (tree and Jira results) shows, one per
  line: the full key and type, the full title, the assignee (or
  "Unassigned"), the status, and then the priority, due date, original
  estimate and labels when they're set (Sean, 2026-11-19).
- **The key's color shows who has the ticket** (Sean, 2026-11-19):
  - green (`charts.green`) when it's Sean's;
  - blue (`charts.blue`) when it's someone else's;
  - orange (`charts.orange`) when it's unassigned or assigned to a
    placeholder account, which means it's up for grabs.

  The default columns no longer include `assignee`. It's still
  available in `jay.columns`.
- Empty values show as `-`.

Done items stay in the tree, struck through or faded *(builder's
call)*.

**Mine** shows every chain that holds something of Sean's in the
selected project and quarter:

- an epic assigned to him;
- an epic with a task of his;
- an epic and task holding a sub-task of his, even when the task and
  epic belong to someone else.

An epic of his brings its whole tree along. Within every chain shown,
tickets that aren't his (someone else's or unassigned) still appear,
in grey, so he can see how his tickets relate to the others (Sean).
Sean's own items are shown at normal weight.

**All** shows every epic in the project and quarter, in two groups
*(builder's call, from the mockup)*:

- **Unclaimed:** no assignee, or assigned to a placeholder account
  (see "Settings"). This group comes first.
- **Claimed:** everything else.

Expanding an epic shows its tasks and sub-tasks, with Sean's in normal
weight and others' in grey.

**Caching.** The tree for each project and period is cached as files
under `~/.jay/cache/`. When the sidebar opens, it shows the cached tree
at once, then refreshes in the background (Sean). A failed refresh
leaves the cached tree in place with a quiet "Offline, retrying" line.

**Startup without waiting** (Sean, 2026-11-19, during the live check):

- **The last sign-in is remembered.** jay keeps three things in its
  state: who was signed in (accountId, name, email), a fingerprint of
  the sign-in, and the project list, all in one record, so the list is
  never taken for another sign-in's. The fingerprint is the token file's
  path, or the site plus email for an API token. It never contains the
  token.
- **The cache shows at once.** When the window opens with the same
  fingerprint, jay shows the remembered account line, the project list
  and the cached tree straight away. It then confirms who is signed in
  (`/myself`) and refreshes the project list in the background,
  without blocking the tree.
- **A different account clears the tree.** If `/myself` returns
  another account, jay clears what it showed, as on any account change,
  and drops the remembered project list. A different fingerprint shows
  nothing from the last sign-in.
- **Cache files belong to an account.** Each cache file records the
  account that wrote it, and is never shown to another account.
- **The first time, with no cache,** the tree area shows "Loading
  tickets…" while the first load runs, instead of an empty tree or
  "Nothing here". "Nothing here" appears only after a load that really
  found nothing.

Clicking a row opens the ticket in the middle. If the ticket's tab is
already open, clicking focuses it.

### The ticket tab

A webview panel per ticket, titled with the key. It shows:

- **Header:** the path (epic › task › sub-task), each part clickable;
  then the key, type and title; and an "Open in Jira" link.
- **Fields:** status, assignee, priority, due date and labels.
- **Description,** rendered from ADF.
- **Comments,** oldest first, with author and time, plus a new-comment
  box at the bottom.

Open tabs survive a window reload: jay leaves them to the editor, which
restores them. A tab restored before jay has signed in shows "Waiting
for sign-in…" and loads once the sign-in is there.

**Editing (Sean).** From the tab, Sean can:

- add a comment;
- edit his own comments;
- edit the title and description;
- change status, assignee, priority, due date and labels.

**How each edit is sent:**

- **Status** shows Jira's available transitions for the ticket, not a
  free status list. Picking one is the action that sends it. If a
  transition needs a screen with required fields, jay doesn't try to
  render it: it says so and offers "Open in Jira" *(builder's call)*.
- **Assignee** is a searchable picker over the users who can be
  assigned. It has a one-click **Assign to me** button, since claiming
  tickets is the main job *(builder's call)*.
- **Priority, due date and labels** use pickers. Picking a value sends
  it.
- **The title** is edited in a plain text box, since Jira's summary is
  plain text.
- **The description and comments** are edited in place, in the
  formatted view, as on the Jira web page (Sean chose this over
  Markdown). Nothing is sent until Sean presses Save (or Comment).
  Cancel discards the edit.

**The editor is ProseMirror** (Sean's choice). Jira's own editor is
built on it, and ADF closely matches a ProseMirror document, so content
can make the round trip without loss.

- It is the one exception to chirp's "no runtime dependencies" rule.
  One prebuilt, pinned file goes in `media/`, loaded only by the tab
  page. The extension host code stays plain CommonJS with no
  dependencies.

  Pinned build inputs (devDependencies, exact versions): esbuild
  0.28.2, prosemirror-model 1.25.13, prosemirror-state 1.4.4,
  prosemirror-view 1.43.0, prosemirror-transform 1.12.7,
  prosemirror-keymap 1.2.3, prosemirror-commands 1.7.2,
  prosemirror-history 1.5.2, prosemirror-inputrules 1.7.0,
  prosemirror-schema-list 1.6.1, prosemirror-dropcursor 1.8.4,
  prosemirror-gapcursor 1.4.1. The entry is `vendor/entry.js`; the
  bundle is committed and rebuilt only by `make vendor`, which runs
  `npx esbuild vendor/entry.js --bundle --format=iife --global-name=PM
  --minify --banner:js="/*! ... */" --outfile=media/prosemirror.js`, where
  the banner is the MIT notice spelled out in the Makefile. Full license
  texts of every bundled package are in `THIRD_PARTY_LICENSES.md`.
- The ProseMirror schema covers the ADF nodes and marks jay can show
  and edit: paragraphs, headings, lists, task lists, code blocks,
  quotes, rules, links, emphasis marks, mentions, emoji, dates and
  status lozenges.
- Anything else (tables, panels, expands, media, cards, extensions,
  and any node jay doesn't recognize) becomes an **atom node** that
  carries its original ADF unchanged. It shows as a read-only block or
  chip, and Sean can move or delete it, but not change what's inside.
  jay always emits it back byte-for-byte.
- Copy and paste inside the editor keep everything: each node and mark
  writes what it is into `data-*` attributes of its DOM (an atom its
  original ADF as JSON in `data-adf`, a mention its id and text), and
  the schema's parse rules read them back. A pasted `data-adf` that
  isn't ADF JSON makes no atom.

  Editing tables and panels in place is left for later *(builder's
  call; the rule "never lose content" holds either way)*.
- Typing `@` in the editor opens a user picker and inserts a real ADF
  mention *(builder's call)*.
- Images and other media can't be fetched without extra authentication
  in a webview. They show as a labeled placeholder with "Open in Jira"
  *(builder's call)*.

**Before saving a title, description or comment,** jay re-reads that
one field (or that one comment) and compares it with the value the tab
loaded. If it differs, jay doesn't save. It shows "Changed in Jira since
you opened it", keeps Sean's draft in the editor, and offers Reload.
After a reload, the draft is still there for Sean to re-apply, with the
current Jira text shown beside it. jay never merges on its own.

- Other changes to the ticket don't block the save: someone else's
  comment, a label, or Sean's own transition *(builder's call)*.
- The field is compared after normalizing away what Jira adds when it
  stores ADF, such as `localId`s and empty attributes *(builder's
  call)*.
- After any successful write, the tab adopts the value Jira returns as
  its new "loaded" value. If that read-back fails, the tab re-reads
  before the next save.
- **Pickers don't run this check.** Status, assignee, priority, due
  date and labels each set one value, as on the Jira web page.
- Jira can't make the check and the write one step, so an edit that
  lands in the gap between them can still be overwritten. The Jira web
  page has the same gap, and it is accepted *(builder's call)*.

**On failure** *(builder's call)*:

- **A timeout on a write** is checked by re-reading, never by
  resending. If the re-read shows what was sent (after normalizing),
  the write counts as done. For a new comment, jay looks for its own
  text among the latest comments.
- **A failed pre-save read** (offline or timeout) means jay doesn't
  save, and shows Retry.
- **401 on a write:** jay refreshes the sign-in once, then shows the
  write as failed, with Retry. A write is never resent automatically.
- **429 or 5xx on a write:** shown as failed, with Retry. 429 says
  when to try again, from `Retry-After`.
- **400, 403, 404 or 409** show Jira's message.
- The draft is never lost on any failure.

**What the tab never does:** retry a write by itself, or send while a
previous write to the same ticket is still pending.

**Mentions in the page** of Sean are highlighted.

### Quarters

The quarter is matched by settings, because every site tags quarters
differently.

- **`jay.quarter.fiscalYearStart`:** the month the fiscal year starts,
  1–12. The default is 1, the calendar year. The fiscal year is named
  by the calendar year it ends in. For example, with 5, FY27 runs May
  2026 to April 2027, so Q3 FY27 is November 2026 to January 2027.
- **`jay.quarter.patterns`:** a list of templates that mark a ticket
  as in quarter Q of fiscal year Y. A ticket matches if any template
  matches. Each template is either a `label:` template, matched exactly
  against labels, or a `summary:` template, matched as a substring of
  the title. The templates use `{YYYY}`, `{YY}` and `{Q}`.

  The default list comes from a company whose epics carry fiscal-quarter
  labels such as `FY2027Q3` and `FY27-Q3`, and a `[Q3FY27]` title tag,
  not always all three. The same forms suit many sites:

  ```json
  ["label:FY{YYYY}Q{Q}", "label:FY{YY}-Q{Q}", "summary:[Q{Q}FY{YY}]"]
  ```

  So Q3 FY27 matches the label `FY2027Q3`, the label `FY27-Q3`, or a
  title containing `[Q3FY27]`.
- **Only epics are matched.** Tasks and sub-tasks belong to the
  quarter of their epic, whatever their own labels say.
- **"Any quarter"** drops the quarter filter: all epics that aren't
  done, in the project.

The JQL jay sends uses the label templates exactly. It uses the
summary templates as a text search, then confirms them on the client,
because JQL's `~` is fuzzy.

### Periods: quarters, sprints or fix versions

Sean asked for this in the first version (2026-11-19, during the live
check), because other companies plan by sprint rather than by a
quarter label. Sean approved this section, builder's calls
included, on 2026-11-19.

**`jay.period`** chooses what the second picker lists. It holds one of
three values:

| Value | The picker lists | A ticket is in the period when |
|---|---|---|
| `quarter` (default) | the quarters described above | its epic matches the quarter patterns |
| `sprint` | the project's sprints | the ticket itself is in that sprint (Jira's Sprint field) |
| `fixVersion` | the project's versions | the ticket itself has that fix version |

**The sprint picker** *(builder's calls throughout)*:

- **Which sprints:** the active sprints of the boards that include the
  project, then up to 3 future and 3 recently closed ones. Each is
  labelled with its name and, for future and closed sprints, its state.
- **The default:** the first active sprint, or "Any sprint" when none
  is active. It follows the active sprint as sprints change, the way
  "current quarter" follows the date.
- **"Any sprint"** means `sprint in openSprints()`.
- **Where the list comes from:** Jira's Agile API
  (`/rest/agile/1.0/board?projectKeyOrId=…`, then each board's
  `/sprint`).
- **If that API is refused** (for example, an OAuth sign-in without
  Jira Software scopes), the picker says "Sprints not available with
  this sign-in" and the setting falls back to `quarter`. The sprint
  itself is filtered with plain JQL (`sprint = <id>`).

**The version picker** *(builder's calls)*:

- **Which versions:** the project's unreleased versions, in release
  order, then up to 3 recently released ones.
- **The default:** the first unreleased version.
- **"Any version"** means `fixVersion in unreleasedVersions()`.
- **Where the list comes from:** `/rest/api/3/project/<key>/versions`.

**The tree for sprints and versions.** Here the tasks, not the epics,
carry the period, so jay builds the tree upward from them:

- **Members:** jay fetches the tickets in the period, then their
  sub-tasks.
- **Epics:** the parent epic of each member is shown above it, even
  though the epic itself isn't in the period. Members without an epic
  go in a "No epic" group at the end.
- **Epics as members:** an epic that is itself in the period (a version
  can include epics) is shown with its whole tree, as in quarter mode.
- **Mine, All and grey:** these work as in quarter mode. Mine keeps the
  chains that hold something of Sean's, and other people's tickets
  stay grey. All groups epics into Unclaimed and Claimed, with "No
  epic" last.
- **New epics:** the "new epic" event applies only in quarter mode. In
  the other modes it becomes "new in this period": a ticket that wasn't
  in the period at the first load and is now. It is shown bold with a
  "new" marker, but doesn't add to the badge.

**Changing `jay.period`** swaps the picker and reloads the view. Each
mode keeps its own remembered choice.

### What catches Sean's eye

Sean approved all of this section on 2026-11-19.

There are three events. Each stays shown until Sean opens the ticket:

- **An @mention of Sean** in a comment or the description, by someone
  else. The ticket pulses, as mentions do in chirp.
- **A new comment on one of his tickets** by someone else. The ticket
  turns bold. "His" means assigned to him.
- **A new epic** in the selected project and quarter. It turns bold
  and is marked "new". Epics that were already there the first time
  jay loaded that project and quarter don't count.

Bold and pulse carry up the tree, so a collapsed epic shows that
something inside it is new. The Activity Bar badge counts mentions
plus new comments; new epics don't add to it.

"Seen" is kept by jay as the time Sean last looked at each ticket,
because Jira has no read state. It is stored in `~/.jay/seen.json`
*(builder's call)*.

A ticket counts as seen when its tab:

- opens and renders;
- is focused again;
- re-renders with new content while it's the visible tab in the
  focused window.

That last case works the way chirp marks a chat read while it's in
front *(builder's call)*. A tab that fails to load doesn't count.

**Scope** *(builder's call)*: jay notices these events on the tickets
it polls. That means the tree for the selected project and period,
plus any open tabs, plus tickets assigned to Sean anywhere on the site
(for new comments). An @mention on a ticket outside all three is not
seen. That limit is stated in the README.

## How the agent knows the ticket in front

Each open ticket tab has a plain-text file, `~/.jay/issues/<KEY>.jira`.
The agent sees it as the active file, the way it sees chirp's `.teams`
files (Sean).

- `~/.jay/current.jira` holds the ticket most recently in front in any
  window. Only the window where it's in front writes it, as in chirp.
- A `jay.activeIssueFile` command returns the path of the ticket in
  front in this window, or nothing when no jay tab is in front, so
  perch falls back to its usual context.
- **perch calls that command** from `ideContext()`, as it does for
  chirp. That change was made in perch as part of this build
  *(builder's call; chirp did the same)*.
- **Sean adds one line to `~/.claude/CLAUDE.md` himself.** jay never
  writes it. The README gives the line:

  ```
  - Jira: when I say "this ticket", "this issue" or "the epic" without a key, read ~/.jay/current.jira (written by jay); change Jira only when I say so, with the Jira MCP server and the keys in it.
  ```

**Agents other than perch** rely on that rule line, as with chirp.
Where it goes depends on the agent:

- The Claude Code panel and CLI, in VS Code or Cursor, read it from
  `~/.claude/CLAUDE.md`.
- Cursor's own agent needs the same line in Cursor Settings → Rules →
  User Rules.

The ticket tab is a webview, as chirp's conversation tab is, so
without perch no agent sees it as the active file.

**Custom-editor experiment (Sean, 2026-11-19).** This was an early
throwaway spike, before the ticket tab was built. It tested whether
making the ticket tab a `CustomEditorProvider` for
`~/.jay/issues/<KEY>.jira`, so the tab is backed by that file, lets
agents see the ticket as the active file with no rule line.

**Result, 2026-11-19, checked live with Sean in VS Code:**

- **The Claude Code panel: no.** With the custom-editor tab for
  `DEMO-1.jira` in front, it reported no open file and no open-file
  notice.
- **perch: no.** It tracks only text editors.
- **Cursor: not checked.** It runs the same Claude Code extension.

**Decision: the ticket tab stays a webview panel,** as chirp's does.
Agents other than perch rely on the rule line.

One thing learned for perch: a custom-editor tab exposes its file
through `TabInputCustom.uri`, so perch could report any such tab
without a command. jay keeps webview panels, so perch still uses
`jay.activeIssueFile`.

What the file holds *(builder's call, recommended to Sean, who
agreed)*:

- **A header:** `# Jira <type> <KEY>: <title>`, the URL, and a line
  saying the file is written by jay, with a pointer to the Jira MCP
  server for anything more.
- **The ticket in full:** status, assignee, reporter, priority, due
  date, labels, created and updated times, the description as plain
  text, and the comments with author and time. Comments are capped at
  the newest 50, with a line saying how many are left out.
- **Its place in the tree,** one line per ticket (key, status,
  assignee, title):
  - the parent chain up to the epic;
  - its children;
  - its siblings.
- **An epic's file** lists its whole tree (tasks and sub-tasks), one
  line each.
- **The full text of other tickets is not included.** Claude reads
  their own files or fetches them by key. That keeps the file small and
  correct.

Plain text from ADF: headings as `#` lines, lists as `-`, code as
indented blocks, mentions as `@Name`, and atom nodes as a short
`[table]`, `[panel: …]` or `[image]`.

The files are written atomically, with directories mode 700 and files
mode 600, using chirp's `mirror.js`.

- When a tab closes, its file is removed. `current.jira` is kept.
- `jay.agentFiles: false` turns the files off and deletes them.
- Sign Out deletes everything under `~/.jay`. Other windows sign out
  too: they notice the secrets going, or the shared signed-out flag at
  their next poll, and stop, close their tabs and forget what they hold.

## Signing in

jay supports two ways to sign in (Sean): an API token, or a token file
another tool keeps. The token file can be in either of two formats.
The sidebar shows which one is in use: "Signed in as … (API token)" or
"(token file)".

**1. API token, for everyone.**

- The **jay: Sign In** command asks for the site URL (for example
  `https://example.atlassian.net`), the email, and an Atlassian API
  token.
- The token and email go in the editor's secret storage. The site URL
  goes in the `jay.site` setting.
- Calls go to `<site>/rest/api/3/…` with basic auth.
- A 401 here means the token was revoked or has expired. jay stops
  polling and the sidebar says "API token rejected: jay: Sign In
  again". Nothing is retried *(builder's call)*.

**2. A token file: OAuth credentials.**

- The `jay.signIn.tokenFile` setting points at an OAuth credentials
  file written by a separate login tool, for example
  `~/.jira/credentials.json`. When it is set, it takes precedence over
  an API token.
- jay reads `access_token`, `cloud_id` and `jira_url` from it. Calls go
  to `https://api.atlassian.com/ex/jira/<cloud_id>/rest/api/3/…` with
  the bearer token. Browse links use `jira_url`.
- **jay never writes the file.** When the access token is within a few
  minutes of expiring (read from the JWT `exp`), or a call returns 401,
  jay runs the command in `jay.signIn.refreshCommand`, for example
  `your-login --refresh`, then re-reads the file.
  - At most one refresh runs at a time across jay's windows *(builder's
    call: a lock under `~/.jay`)*.
  - The command does the locking against other tools itself.
  - jay runs it with no terminal and stdin closed, and kills it after
    60 seconds, so a login tool that wants an interactive login can't
    hang *(builder's call)*.
  - jay goes by the command's exit code. If it exits 0 but the token in
    the file is still near expiry, jay uses that token until a call
    fails, rather than re-running the command on every call.
- jay also re-reads the file whenever it changes on disk, so a login
  from a terminal is picked up within a few seconds.
  Because file watching is unreliable outside the workspace and over
  remote connections, jay also checks the file's modification time
  every 30 seconds while signed out because of it.
- **If the refresh command fails, or isn't set and the token has
  expired,** jay stops polling. The sidebar shows "Sign in again with
  the tool that writes the token file", and jay watches the file.
- **Why jay has no OAuth app of its own:** Atlassian's token endpoint
  asks for the app's client secret to refresh, even with PKCE. A public
  extension can't keep a secret, so jay leaves refreshing to the
  command.

**3. A token file: a jira-mcp wrapper or env file (Sean, 2026-11-19,
during the live check).** Many people already run a Jira MCP server
from a jira-mcp wrapper script that holds `JIRA_URL`, `JIRA_USERNAME`
and `JIRA_API_TOKEN` in plain text. Setting `jay.signIn.tokenFile` to
that file signs jay in from it, with nothing copied:

- **Detecting the format:** a file whose first non-blank character is
  `{` is the OAuth JSON above. Any other file is read as lines of
  `NAME=value`, with an optional leading `export` and optional single
  or double quotes.
- **Reading it:** jay reads `JIRA_URL`, `JIRA_USERNAME` and
  `JIRA_API_TOKEN` from those lines. It never runs the file. Calls go
  to `JIRA_URL/rest/api/3/…` with basic auth, as with an API token, and
  browse links use `JIRA_URL`.
- **Changes:** jay re-reads the file when it changes on disk, so a
  rotated token is picked up within seconds.
- **The refresh command doesn't apply,** since a basic-auth API token
  doesn't expire like an OAuth one. A 401, or a file missing one of the
  three names, stops polling, and the sidebar says "Update the Jira API
  token in <file>".
- **jay never writes the file,** and never logs or shows the token.

With `jay.signIn.tokenFile` set, **jay: Sign In** only re-reads the
file; it doesn't ask for an API token. To switch to an API token, clear
the setting first.

## Polling

jay uses chirp's `poller.js`. Polls never overlap, run 4× slower when
the window isn't focused, and back off on 429 and 503, honoring
`Retry-After`: they wait the longer of it and the backoff (5 s,
doubling to 5 minutes), so a `Retry-After` of 0 doesn't poll at once.

Intervals *(builder's call)*:

- **Tree changes:** every 60 seconds while focused. It runs one JQL
  search for tickets in the view's project updated since the last poll,
  then fetches comments only for tickets whose `updated` moved.
- **Open tabs:** the visible tab is checked every 30 seconds. A change
  re-renders it, unless an edit is in progress; then it shows "Updated
  in Jira, Reload" instead.
- **Sean's tickets anywhere,** for new comments: every 5 minutes.

Changing the project, period or Mine/All loads that view from the
cache, then refreshes it in full.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `jay.site` | (empty) | Jira Cloud site URL, for API-token sign-in |
| `jay.signIn.tokenFile` | (empty) | Token-file sign-in (OAuth JSON, or a jira-mcp wrapper or env file); takes precedence when set |
| `jay.signIn.refreshCommand` | (empty) | Command that refreshes an OAuth token file |
| `jay.period` | `quarter` | What the second picker lists: `quarter`, `sprint` or `fixVersion` |
| `jay.quarter.fiscalYearStart` | 1 | Fiscal year start month |
| `jay.quarter.patterns` | the three templates above | How epics mark their quarter |
| `jay.placeholderAssignees` | `[]` | Display names or account ids that count as unclaimed |
| `jay.columns` | `["key","summary","status"]` | Tree and search-result columns, in order: key, summary, assignee, status, type, priority, due, labels, estimate |
| `jay.agentFiles` | true | Write `~/.jay/issues/*.jira` and `current.jira` |

`jay.site`, `jay.signIn.tokenFile` and `jay.signIn.refreshCommand` are read only from your user settings (or the remote's settings in a remote window; no `machine` scope, which remote windows would ignore), so a repo's workspace settings can't send the token elsewhere or pick a command to run.

## Diagrams

Opening a ticket and asking Claude about it:

```
 Sean        jay sidebar      jay host               Jira REST          ~/.jay files        perch / Claude    Jira MCP
  |               |               |                       |                    |                    |               |
  |-- click ----->|               |                       |                    |                    |               |
  |               |-- open(KEY) ->|                       |                    |                    |               |
  |               |               | [tab open: focus it; stop]                 |                    |               |
  |               |               |-- GET issue + comments ->|                 |                    |               |
  |               |               |<-- issue (ADF) --------|                    |                    |               |
  |               |               | [neighbours not in tree: GET parent chain, children, siblings]   |               |
  |               |               | [GET fails: tab shows error + Retry; cached copy if any; no seen; stop]          |
  |<-- tab KEY ---|---------------|                       |                    |                    |               |
  |               |               |-- write KEY.jira (temp+rename) ----------->|                    |               |
  |               |               | [tab in front in focused window: write current.jira too]       |               |
  |               |               |-- record seen(KEY) ----------------------->|                    |               |
  |               |<-- clear bold/pulse for KEY; update badge                  |                    |               |
  |-- "can I finish this by Dec?" ---------------------------------------------------------------->|               |
  |               |               |<-- jay.activeIssueFile (perch) -----------------------------------|              |
  |               |               |-- path of KEY.jira ------------------------------------------------>|              |
  |               |               |                       |                    |<-- read KEY.jira --|               |
  |               |               |                       |                    |   [needs another ticket] -- get -->|
  |<-- answer --------------------------------------------------------------------------------------|               |
```

Saving a description edit:

```
 Sean          ticket tab           jay host                   Jira REST
  |-- edit, Save -->|                    |                           |
  |                 |-- save(ADF, loadedDescription) ->|             |
  |                 |                    | [a write to KEY pending: refuse; button disabled]
  |                 |<-- pending --------|                           |
  |                 |                    |-- GET issue?fields=description ->|
  |                 |                    |   [fails/timeout: error + Retry; nothing sent]
  |                 |                    |<-- description -----------|
  |                 |                    | [normalized != loadedDescription]
  |                 |<-- "Changed in Jira since you opened it"; draft kept; Reload
  |                 |                    | [unchanged]               |
  |                 |                    |-- PUT issue {description: ADF} ->|
  |                 |                    |   [204]                   |
  |                 |                    |-- GET issue ------------->|
  |                 |                    |   [fails: mark tab "re-read before next save"]
  |                 |                    |-- rewrite KEY.jira (and current.jira if in front)
  |                 |<-- render saved; new loadedDescription         |
  |                 |                    |   [timeout]               |
  |                 |                    |-- GET issue?fields=description ->|
  |                 |                    |   [normalized == sent: treat as saved]
  |                 |<-- else: error + Retry; draft kept (no automatic resend)
  |                 |                    |   [401: refresh sign-in once; show failed + Retry]
  |                 |                    |   [400/403/404/409: Jira's message] [429/5xx: failed + Retry]
  |                 |<-- draft kept in every failure                 |
```

A call with an OAuth token file when the token is expiring, and when
the login is gone:

```
 jay host                 credentials.json        refresh command (your-login --refresh)    Atlassian
   |-- read ----------------->|                            |                                   |
   |<-- exp within 5 min -----|                            |                                   |
   |-- run (one at a time) -------------------------------->|                                   |
   |                          |<-- lock, reread -----------|                                   |
   |                          |   [already fresh: exit 0]  |                                   |
   |                          |                            |-- refresh_token grant (+secret) ->|
   |                          |                            |<-- new access + refresh ----------|
   |                          |<-- write (temp+rename, 600)|                                   |
   |<-- exit 0 ---------------------------------------------|                                   |
   |-- reread --------------->|                            |                                   |
   |-- GET /ex/jira/<cloud_id>/rest/api/3/… with bearer --------------------------------------->|
   |   [401: run refresh once, retry the GET once; a second 401 = login gone]                   |
   |   [exit 0 but file's token still expiring: use it; don't re-run until it fails]           |
   |   [command runs over 60 s: kill it; treat as failed]                                      |
   |   [command exits non-zero, or not set and token expired]                                  |
   |-- sidebar: "Sign in again with the tool that writes the token file"; stop polling; watch   |
   |   [file changes: reread, resume]                       |                                   |
```

The 401 retry applies only to reads. A write that gets a 401 is shown
as failed, with Retry, after the refresh.

## How it is built

The model is chirp's design note, especially "How it is built",
"Builder's decisions", "Rulings during the build" and "Changes from
the final review". jay follows it:

- Plain CommonJS, no bundler, no runtime dependencies (except the
  ProseMirror file above).
- `src/*.js` for the host and `media/*.js` for the page scripts.
- `node:test` plus jsdom for tests, with no network and no real token
  in any test.
- A Makefile like chirp's, with `deps check test install uninstall
  package install-vsix login publish clean`, plus `vendor` for the
  ProseMirror bundle. The Marketplace token is `~/.ssh/azure-dev.pat`.
- Publisher `seanahn`, MIT license, `engines.vscode` like chirp's.

**Copied from chirp and adapted:**

- `src/poller.js`;
- `src/mirror.js` (`~/.jay`, `.jira` files, `current.jira`);
- the sidebar webview pattern;
- the allowlist HTML sanitizer, for anything rendered as HTML;
- `test/vscodeStub.js`;
- the agent-file command and the token-file watching.

**New:**

- the Jira REST client (both sign-ins, one interface);
- the tree model (queries, Mine/All, chains, grouping, quarters and
  other periods);
- the ADF ⇄ ProseMirror schema and the ADF → plain-text writer;
- the ticket tab and its editing;
- the seen and events state.

**The modules:** `api.js` (Jira calls), `http.js` (requests, back-off,
the 401 rule), `auth.js` (API token, OAuth token file, env file),
`loader.js` (loads and caches a view), `tree.js` (Mine/All, chains,
groups), `quarters.js` and `periods.js`, `adf.js` (ADF to plain text
and normalizing), `writes.js` (each edit, its check and its failure
handling), `events.js` (seen and events), `mirror.js` (agent files),
`ticket.js` and `sidebar.js` (the two webviews' hosts), and
`extension.js` (wiring and polling). Page scripts are `media/sidebar.js`,
`media/ticket.js`, `media/ticketEditor.js` and `media/adfPm.js`.

**Facts checked during the build:**

- JQL search on Cloud is `POST /rest/api/3/search/jql` with
  `nextPageToken`. The old `/rest/api/3/search` is being retired.
- `parent` covers both epic → task and task → sub-task.
- The assignee picker uses `/rest/api/3/user/assignable/search`, and
  @mentions use `/rest/api/3/user/search`.
- An OAuth sign-in needs `read:jira-work read:jira-user write:jira-work
  offline_access` for jay to read, comment, edit and transition.

## Builder's decisions from the plan

Made while writing the plan:

- **The tree in Mine:** an epic that's included always shows its whole
  tree. That includes others' tasks under it, in grey, not only the
  chain down to Sean's item.
- **Tickets with no epic** in the quarter aren't shown, in Mine or All.
  (In sprint and version modes they go under "No epic".)
- **One load serves both modes.** jay loads the project and period
  once, and Mine is computed from it, so switching modes is instant.
- **Ordering:** epics by due date (none last), then key, newest first.
  Children by key.
- **Incremental refresh:** `updated >= "-<minutes since last + 2>m"`
  in the project. A full reload runs every 15 minutes to catch
  deletions and moves.
- **Comments** are fetched only for tickets whose `updated` moved.
- **Token-file refresh:**
  - jay refreshes 240 seconds before expiry, under the 300 a typical
    jira-mcp refresh uses, so a freshly refreshed token never looks
    "expiring" to jay;
  - the cross-window lock is `~/.jay/refresh.lock`, with locks older
    than 90 seconds treated as stale;
  - the command is killed after 60 seconds.
- **A timed-out new comment** counts as saved if a comment by Sean,
  created within 5 minutes and with the same body (under `sameAdf`),
  is found.
- **A description mention** is an event only when the description goes
  from not mentioning Sean to mentioning him.
- **The baseline:** a ticket's first observation is its "seen" time,
  so old comments never light up.
- **Building the ProseMirror bundle:** esbuild is a dev-only
  dependency, used only by `make vendor`. The extension code is never
  bundled.
- **The agent file format** is as described in "How the agent knows
  the ticket in front".

### Rulings during the build

Questions that came up while building, and how they were settled:

- **devDependencies appear when first used.** jsdom came with the
  first tests; esbuild and the pinned ProseMirror packages came with
  the editor bundle.
- **"Any quarter" is a value of its own.** The quarter functions accept
  `'any'`: the JQL gets no quarter clause, and every epic matches.
- **The custom-editor check skipped Cursor.** The Claude Code panel in
  VS Code said no, and Cursor runs the same extension, so the tab stays
  a webview. If Cursor's own agent would have seen the file, that
  rule-line-free use is lost; a later custom-editor port is still
  possible.
- **A failed refresh carries its reason.** When a token-file refresh
  fails, the sign-in throws "sign in needed" rather than quietly saying
  no, so the sidebar can say why. The request layer lets it through.
- **A file change doesn't re-run the refresh command.** After the
  command exits 0 with a still-expiring token, only a 401 runs it
  again, as the design says. A stuck token waits for the next 401.
- **Search is a read.** It is a POST, but it only reads, so it is
  marked as a read and gets the one 401 retry. Writes are never marked
  that way.
- **"Seen" is shared through the file.** A ticket marked seen in one
  window is seen by others once that window saves `seen.json`, which
  it does right away. The cost is a brief re-light in another window
  if a save is delayed.
- **The bundle carries its license.** The esbuild command adds an MIT
  banner, and `THIRD_PARTY_LICENSES.md` ships in the .vsix, because MIT
  requires the notice in shipped copies and esbuild's legal-comments
  option kept nothing.
- **`localId`s are fixed when saving.** When the editor's document is
  turned back into ADF, duplicate `localId`s get fresh ones (the first
  keeps its id), and new task lists and items get ids. This is
  deterministic and testable, unlike a ProseMirror plugin. A pasted
  block's `localId` changes on save, which is harmless.
- **The title is a plain text box,** not ProseMirror. Jira's summary
  is plain text, and marks there couldn't be saved.
- **An unfocused window may still refresh `current.jira`** for the same
  ticket. It is still that window's last ticket in front, and the
  content is only newer. Another window's later ticket is protected.
- **Reload after a conflict** re-bases only the draft whose save hit
  the conflict, and shows the current Jira text beside the kept draft.
  The "Updated in Jira" banner's Reload re-bases no draft. Nothing
  overwrites text Sean hasn't seen.
- **The poll for Sean's tickets looks back to its last success,** plus
  a minute (at most 7 days; 6 minutes on the first run), instead of a
  fixed 6 minutes. A fixed window dropped about 14 minutes on each
  unfocused cycle.
- **With a token file set, jay: Sign In only re-reads the file.** The
  file wins anyway. Someone who wants an API token clears the setting
  first.
- **Full loads also fetch descriptions,** so each ticket's "mentions
  Sean" state is set at its baseline and only a new mention counts.
  The cache file leaves descriptions out. The cost is larger full loads
  every 15 minutes.
- **Cache files are owned by the account that wrote them.** The loader
  returns nothing for another account's file. This replaced a "no
  cache" flag and keeps another account's tickets from showing. Older
  cache files without an owner are ignored once and reloaded.

## Shipping

- **Repo:** `github.com/seanahn/jay`, with commits as `Sean Ahn`.
  - Push with `GH_TOKEN=$(gh auth token --user seanahn)`.
  - Before anything goes public, scan the files and history for company
    names, colleagues' names and real ids.
  - Tests and README use made-up sites, keys and names.
- **Marketplace:** `seanahn.jay`, published with `make publish`.
- **Cursor:** not on Open VSX yet; install the .vsix by hand.

## Builder's calls (for Sean to check)

- Non-goals: boards, saved filters, JQL box, recent tickets,
  Server/DC, multiple sites.
- All view grouped into Unclaimed and Claimed.
- Quarter picker range, project picker behavior, choices remembered.
- Search box can open a key that isn't in the tree.
- "Assign to me" button; picking a field value sends it; status via
  transitions only; transition screens send you to Jira.
- Rich content jay can't edit (tables, panels, media) is kept intact
  as a block you can move or delete, but not edit inside.
- @ in the editor inserts a real mention; images show as placeholders.
- Quarter settings and their defaults; only epics carry the quarter.
- Sprint and version pickers: which ones are listed, the defaults, and
  the fall-back to quarters.
- Event scope: tree, open tabs, and Sean's tickets anywhere.
- Seen state in `~/.jay/seen.json`.
- Agent file contents, the 50-comment cap, the CLAUDE.md line.
- Poll intervals.
- jay never writes a token file; an OAuth file is refreshed by a
  command Sean configures.
- The conflict check compares only the field being saved; pickers send
  without a check; the small race with Jira is accepted.
- Focusing a tab, or new content in the visible tab, counts as seen.
- Failure handling for writes, 401s and the refresh command.
- The perch change is in scope; Sean adds the CLAUDE.md line himself.
