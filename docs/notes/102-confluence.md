# 102 — Confluence

Confluence pages in jay, beside Jira. Written 2026-11-20, during
brainstorming, before any code. **Approved and built (2026-11-20).**
Calls marked *(builder's call)* were made while writing this note.
Everything else is Sean's. What changed during the build is in
"Rulings during the build" at the end, and in place below. For
installing and using it, see the [README](../../README.md#confluence).

This note extends [101](101-design.md); everything there still holds
unless this note says otherwise.

## Purpose

Confluence pages reach Sean as references, and today each one means a
trip to the browser, with Claude unable to see the page unless he pastes
it in:

- links in a Teams chat, such as a teammate's living requirements page
  or the setup page everyone goes back to when something breaks;
- pages he published himself;
- most often, pages a Jira ticket points to while Claude helps him
  triage, and Confluence links in Claude's own replies.

jay adds Confluence beside Jira. The same sidebar switches between the
two, a page opens in the middle pane, where it can be read, edited and
commented on, and the page in front is written to a plain-text file so
Claude knows which page "this page" means.

Confluence is Atlassian's too: same site (`<site>/wiki`), same account,
and the same API token or OAuth login. Atlassian's own VS Code extension
has no Confluence view, which is why this lives in jay.

### Goals

- A Jira | Confluence switch in jay's sidebar.
- A Confluence side modelled on Confluence's own left panel: a space
  box, a title search, and the space's page tree.
- Pages open in a tab, readable, editable in place, with comments.
- Links to Confluence pages open in jay instead of the browser: in
  Claude's replies in perch, and in Jira tickets.
- The page in front is a file Claude can read.
- @mentions of Sean on Confluence are flagged.

### Non-goals (first version)

- Creating, moving, copying or deleting pages; page permissions;
  attachments upload; templates.
- Creating new inline comments (comments anchored to a text
  selection). Existing ones are shown *(builder's call)*.
- Blog posts and whiteboards, databases and other non-page content:
  they show in the tree as items that open in the browser *(builder's
  call)*.
- Notifications other than mentions.

### Anti-goals

The anti-goals of 101 hold here too:

- nothing is written to Confluence unless Sean acts;
- a page edit never silently loses content, macros included;
- jay never saves over someone else's newer version;
- tokens are never leaked.

## The sidebar

- **The switch:** `Jira | Confluence` at the top of jay's sidebar.
  jay remembers the side across reloads *(builder's call)*.
- **The header** follows the switch: JIRA or CONFLUENCE (Sean).
- **The container title,** the Activity Bar tooltip, becomes "Jira
  and Confluence" (Sean).

The Jira side is unchanged. The Confluence side has, top to bottom:

- **The account line,** as on the Jira side, without Mine | All.
- **A search box:**
  - It filters the loaded page tree by title as Sean types.
  - After 3 characters and a 400 ms pause, it also searches all of
    Confluence by title and text, using CQL
    (`siteSearch ~ "<query>" AND type = page`). Up to 20 results show
    under "Confluence results", as on the Jira side.
  - A pasted Confluence URL, including a short link `/wiki/x/…`,
    offers "Open this page".
- **A space box,** like the project box:
  - type-to-filter by space key or name;
  - the 5 most recently used spaces first;
  - personal spaces included *(builder's call)*.
- **Mentions,** a small section that shows only when there are
  unseen mentions (see "Mentions").
- **My pages** (Sean): the pages Sean created, in any space, newest
  first.
  - It is a collapsible section (Sean). It is collapsed by default, and
    jay remembers whether it is open *(builder's call)*.
  - It uses CQL `creator = currentUser() AND type = page`, shows 25
    with "More", and refreshes when expanded and every 15 minutes while
    open *(builder's call)*.
  - Each row shows the title and space. Its tooltip shows the path and
    space only; the listing has no author or date, and fetching them
    per row would cost a request each *(ruling during the build)*.
- **The page tree** of the chosen space, nested as in Confluence:
  folders, pages and their children. It is collapsible like My pages
  and open by default *(builder's call)*.
  - Top-level items load with the space. Children load when a branch is
    expanded, since a space can hold thousands of pages.
  - The loaded part is cached under `~/.jay/cache/` per space, owned by
    the account that loaded it, as for Jira.
  - Each row shows the title. Its tooltip shows the full path and
    space only, for the same reason. Folder names in the path show as
    "…" *(ruling during the build)*.

Recent and Starred, as in Confluence's own panel, are useful but wait
for later *(builder's call)*.

## The page tab

A page opens as its own tab in the middle pane: jay's own webview, since
Atlassian's extension has none for Confluence. Clicking a page that's
already open focuses its tab.

- **Header:** the space › parent path, the title, the author, and when
  it was last updated, by whom. An "Open in Confluence" link.
- **Body:** rendered from the page's Atlassian Document Format (ADF,
  the same format as Jira's descriptions), with the same renderer.
  Macros and other content jay can't edit show as labeled blocks.
- **Editing** works like jay's ticket description: in place, as
  formatted text, with ProseMirror and the lossless atoms of 101. Edit,
  then Save or Cancel. The title is edited in a plain box, as for
  tickets.
- **Conflicts:** Confluence numbers every version, and a save must
  name the next number. jay saves with the version the draft started
  from plus one.
  - If Confluence refuses (409, someone saved first), jay shows "Changed
    in Confluence since you opened it", keeps the draft, and offers
    Reload, which shows "Confluence now has:" beside it, as for tickets.
  - The same rules as 101 apply: never resent automatically, one write
    at a time per page, and a timeout checked by re-reading, never by
    resending.
- **Comments (page comments):**
  - shown below the body, oldest first, with their replies nested;
  - Sean can add a comment, reply to one, and edit his own;
  - nothing is sent until he presses the button;
  - `@` inserts a mention, as on the Jira side.
- **Inline comments** already on the page are listed with the
  highlighted text quoted, and can be replied to. Creating new ones is
  out of scope.
- **One Save for title and body** *(builder's call)*: Confluence saves
  a page whole (title, body, version together). If both are being
  edited, one Save sends both; a title-only save sends the body as
  loaded, and the version check refuses it if the body changed since.
- **Staying current** *(builder's call)*: as for tickets in 101, the
  page in front is re-read every 30 seconds (version number only, then
  the page when it changed). While an edit is open, a change shows
  "Updated in Confluence, Reload" and the draft is kept.
- **Pages jay won't edit** *(builder's call)*: pages still on the
  legacy editor (saving their converted body would rewrite legacy
  macros) and live pages (they save continuously, without the version
  model) open read-only with "Edit in Confluence". So do pages whose
  status isn't `current` (archived, for one): no editor and no comment
  box, since saving sends status `current` and could un-archive the page
  *(ruling during the build)*.

## Links into jay

- **In perch (Claude's replies and Sean's messages):** a Confluence URL
  on the jay site shows as a link. perch makes a plain click open it
  through jay (`jay.openPage(url)`). Ctrl/Cmd-click still opens the
  browser. Without jay, links behave as today (Sean). perch 0.7.35 did
  this for Claude's replies; 0.7.36 made the web addresses in Sean's own
  messages links too (Sean).
- **In Jira tickets:**
  - The ticket tab lists the Confluence pages the ticket references
    under "Confluence pages": links in its description and comments,
    plus Jira's own remote links to Confluence ("mentioned in").
  - Clicking one opens it in jay.
  - The ticket's `.jira` file lists them too, with their titles and
    URLs, so Claude sees them while triaging.
  - Tickets normally open in Atlassian's extension (101's default
    `jay.ticketView`), which jay can't change. There the list isn't
    shown and links go to the browser; the `.jira` file still lists
    them, which is what Claude reads *(builder's call)*.
- **Short links** (`/wiki/x/<id>`) are decoded locally: the tiny id
  encodes the page id. If decoding fails, the link opens in the browser
  *(builder's call; following the redirect doesn't work on the OAuth
  sign-in)*.
- **perch's contract** *(builder's call)*: jay adds `jay.siteUrl()` so
  perch knows which links are jay's. `jay.openPage(url)` returns true
  when jay opened it (including an error tab for 403/404), and false
  when it couldn't: signed out, Confluence turned off, or not a page.
  On false, perch opens the browser.
- **Links to other sites** or non-page content open in the browser.

## How the agent knows the page in front

As for tickets:

- Each open page has a plain-text file, `~/.jay/pages/<space>-<id>.confluence`.
- The page in front is copied to `~/.jay/current.confluence`.
- `jay.activePageFile` returns the open page's file, for perch's IDE
  context.

perch adds an entry for jay's page tab (viewType `jay.page`, label
"Confluence page"). Sean adds one line to `~/.claude/CLAUDE.md` *(the
wording is the builder's call)*:

```
- Confluence: when I say "this page" without a link, read ~/.jay/current.confluence (written by jay); change Confluence only when I say so.
```

**What the file holds:**

- a header with the title, URL, space, page id, version, author and
  last-updated time;
- the path from the space home;
- the body as plain text, using the ADF → text writer of 101, with
  macros as `[macro: <name>]`;
- the page comments with author and time, capped at the newest 50,
  with inline comments quoted;
- the page's children, one line each with title and id;
- the Jira keys the page mentions.

## Mentions

- **What counts:** an @mention of Sean on any page or comment, in any
  space, made by someone else (Sean).
- **How jay finds them:** a CQL search, `mention = currentUser()`,
  newest first, every 5 minutes. It runs 4× slower when the window is
  unfocused, with the same backoff as 101's pollers *(builder's call)*.
- **The first run sets a baseline,** so old mentions don't light up,
  the same rule as 101.
- **What is new** *(builder's call)*: CQL returns content that mentions
  Sean now, not mention events. A mention is new when a page or comment
  id appears in the results that wasn't there before. Later edits to
  content already in the set don't light it up again. "Someone else"
  is judged by the comment's author, or the page's last editor; content
  Sean wrote or last edited is skipped.
- **How they show:** a "Mentions" list at the top of the Confluence
  side, newest first.
  - Each entry shows the page title, who mentioned Sean, and when. It
    pulses until opened, and counts in the Activity Bar badge.
  - There is no "Confluence: N mentions" line on the Jira side: the
    Activity Bar badge already counts Confluence mentions on both sides
    *(ruling during the build; the earlier design had such a line)*.
- **Opening one** opens the page and scrolls to the comment when the
  mention is in a comment. That marks it seen in `seen.json`, shared
  across windows, as in 101. Opening a page by any route, or bringing
  its tab to the front, also marks that page's mentions seen
  *(ruling during the build)*.

## Signing in

The same sign-in as Jira, no second login:

- **API token, and the jira-mcp wrapper file:** basic auth against
  `<site>/wiki/api/v2/…` and `<site>/wiki/rest/api/…` (CQL search).
- **OAuth token file:** calls go to
  `https://api.atlassian.com/ex/confluence/<cloud_id>/wiki/…`.
  - The login tool that writes the token file saves the `scope` from
    Atlassian's token response in it. jay reads it:
    - no granular Confluence scopes: the Confluence side shows "This
      sign-in can't use Confluence yet" (Jira is unaffected);
    - granular read scopes but no write scopes: pages are read-only,
      Edit and comment are disabled with "This sign-in can't edit
      Confluence", and no write is attempted;
    - granular write scopes: everything works.
    *(builder's call)*
  - Confluence's v2 API accepts only its *granular* OAuth scopes, not
    the classic ones (`read:confluence-content.all`, …).
  - **Sean's ruling:** the OAuth app and its login tool ask for the
    granular scopes beside the classic ones (which a Confluence MCP
    server may still use). jay therefore uses one API, v2, on every
    sign-in. The scopes jay needs, checked against Atlassian's
    published per-operation scopes:
    - pages: `read:page:confluence`, `write:page:confluence`;
    - the tree: `read:hierarchical-content:confluence`;
    - a page's ancestors: `read:content.metadata:confluence`;
    - spaces: `read:space:confluence`;
    - comments: `read:comment:confluence`, `write:comment:confluence`;
    - users: `read:user:confluence`;
    - CQL search (v1): the classic `search:confluence`.
  - Without them, the Confluence side shows "This sign-in can't use
    Confluence yet" until the user logs in again with them.
- **A Jira-only API token:** Atlassian's newer tokens can be limited to
  Jira. A 401 or 403 from `/wiki` while Jira works shows "Confluence
  isn't available with this sign-in" on the Confluence side. It is not
  treated as a sign-out, and the mentions poller stops
  *(builder's call)*. A 404 on the probe (a site without Confluence)
  shows "Confluence isn't available with this sign-in" too, and a 401
  that can't be refreshed (an API token, an env file) is the same, never
  a Jira sign-out *(rulings during the build)*.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `jay.confluence.enabled` | true | Show the Jira \| Confluence switch and poll mentions |

The space, side and recent spaces are remembered in jay's state, like
the Jira project.

## Diagrams

Opening a Confluence link from a Claude reply:

```
 Sean         perch page        perch host         jay host                 Confluence           ~/.jay files
  |-- click link ->|                 |                  |                          |                     |
  |                |   [ctrl/cmd-click: open browser; stop]                         |                     |
  |                |-- openPage(url) |                  |                          |                     |
  |                |---------------->|  [not on jay.siteUrl(), or jay missing: open browser; stop]       |
  |                |                 |-- jay.openPage ->|                          |                     |
  |                |                 |                  | [signed out / Confluence off / not a page: return false]
  |                |                 |<-- false --------|  → perch opens browser   |                     |
  |                |                 |                  | [short link: decode tiny id; fails → false]    |
  |                |                 |                  | [page already open: focus its tab; return true]|
  |                |                 |                  |-- GET page (ADF), path, children ------------>|  |
  |                |                 |                  |-- GET footer + inline comments -------------->|  |
  |                |                 |                  |<-- page v12, comments -----|                     |
  |                |                 |                  | [403/404: error tab + Open in Confluence; no file; return true]
  |<-- tab "Title" (page) -------------------------------|                          |                     |
  |                |                 |<-- true ---------|                          |                     |
  |                |                 |                  |-- write <space>-<id>.confluence (temp + rename) ->|
  |                |                 |                  |   [tab in front, window focused: copy to current.confluence]
  |                |                 |-- jay.activePageFile ->|  (perch IDE context) |                     |
  |                |                 |<-- path ---------|                          |                     |
```

Saving an edit when someone saved first:

```
 Sean        page tab            jay host                      Confluence
  |-- Save ----->|                     |                             |
  |              |-- save(ADF, base v12) ->|                         |
  |              |                     | [a write to this page pending: refuse]
  |              |                     |-- PUT page {version: 13} ->|
  |              |                     |   [200]                     |
  |              |<-- saved; base v13 -|                             |
  |              |                     |   [409: version 13 exists]  |
  |              |<-- "Changed in Confluence since you opened it"; draft kept; Reload
  |-- Reload --->|                     |-- GET page (latest) ------->|
  |              |<-- "Confluence now has:" beside the draft; base = latest
  |              |                     |   [400: Confluence rejected the body]
  |              |<-- failed, with Confluence's message; draft kept |
  |              |                     |   [401: refresh token once, resend once; still 401: failed + Retry]
  |              |                     |   [429/5xx: failed + Retry after Retry-After; never automatic]
  |              |                     |   [timeout]                 |
  |              |                     |-- GET page version 13 ----->|
  |              |                     |   [v13 exists with our body: saved] [else: failed + Retry, no resend]
  |              |                     |   [OAuth read-only sign-in: never sent; edit disabled up front]
```

Comments follow 101's comment rules: one write at a time, and a
timeout is checked by looking for Sean's own text among the newest
comments (or the edited comment's version), never by resending.

## How it is built (builder's calls, to settle at plan time)

As built, in `src/`: `confluence.js` (the api), `pageLinks.js` (link
parsing and short links), `pageWrites.js` (page and comment writes),
`pageMirror.js` (the page file for the agent), `pageTree.js` (tree and
My pages loader), `mentions.js` (the mentions poller), `page.js` (the
page tab host) and `confluenceSide.js` (the sidebar's Confluence side);
in `media/`: `page.js` and `page.css`. The perch side is perch 0.7.35
(branch `confluence-links`). Setting: `jay.confluence.enabled`.
Commands: `jay.openPage`, `jay.siteUrl`, `jay.activePageFile`.

- **API:** Confluence Cloud REST v2, on every sign-in (Sean's ruling on
  scopes, above).
  - Spaces: `/wiki/api/v2/spaces`.
  - Pages: `/pages/{id}?body-format=atlas_doc_format`.
  - Tree: `/pages/{id}/direct-children`, which includes folders.
  - Space root: `/spaces/{id}/pages?depth=root`.
  - Comments: `/pages/{id}/footer-comments` and `/inline-comments`.
  - Update: `PUT /pages/{id}` with `version.number`.
  - v1 is used for CQL search: `/wiki/rest/api/search?cql=…`.
  - Check each of these against the current docs at plan time.
- **Reuse from 101:**
  - the http client, auth, poller, mirror, events/seen, writes
    (pending guard, timeout read-back);
  - the ADF tools, the ProseMirror schema, the sidebar page with its
    combobox, and the ticket tab's editor code.

  The Confluence pieces are new modules beside them: a Confluence api,
  a page-tree loader, a page tab, and a mentions poller.
- **perch:** a `jay.openPage` route for Confluence URLs on the jay
  site, and a `jay.page` entry for IDE context, both in perch 0.7.x.
- **Tests:** made-up data only, as in 101.

## Decisions made while planning (builder's calls)

These were checked live against Sean's site on 2026-11-20, with reads
only. They are recorded here because the plan is deleted at merge.

- **Bodies:** v2 returns a page's ADF as a JSON string, in
  `body.atlas_doc_format.value`. It has no display names, so names come
  from `POST /wiki/api/v2/users-bulk` and are cached per sign-in.
- **Short links:** `/wiki/x/<tiny>` is the page id as little-endian
  bytes in URL-safe base64 (`-` for `/`, `_` for `+`). Decoding was
  checked on a real page.
- **Mentions:** CQL `mention = currentUser()` returns both pages and
  comments. A comment's page is `content.container.id`, and who last
  changed it is `content.version.by`.
- **Legacy and live pages:** on new-editor pages, the `editor` property
  is absent. jay treats a page as legacy only when that property is
  `v1`, and as live when `subtype` is `live`. Confirm this on a known
  legacy page during the build.
- **Access by sign-in:**
  - an API token or env file: full;
  - a token file: from its `scope` field: `write:page:confluence` gives
    full, `read:page:confluence` gives read, and anything else gives
    none.
- **Refusals:** a second 401 on `/wiki`, after one refresh, or a 403 on
  the first spaces call, means "Confluence isn't available with this
  sign-in". It never signs Jira out.
- **Pollers:**
  - the page in front: every 30 s;
  - Mentions: every 5 min, 50 hits;
  - My pages: every 15 min, and only while the section is open, 25 at a
    time.
- **The tree cache:** `~/.jay/cache/confluence-<spaceId>.json`, owned
  by the account that wrote it.
- **State kept between reloads:** `jay.side`, `jay.space`,
  `jay.recentSpaces` and `jay.confluence.open` (`{ mine: false, tree:
  true }`) in global state.
- **@mentions** in page comments use Jira's user search; the accounts
  are the same.
- **Jira tickets:**
  - page titles come from the remote link's title, else from one
    `titles()` call per ticket (not up to 10 page reads);
  - blog posts and other non-page links aren't listed;
  - a failure to read them never fails the ticket.
- **perch:** it falls back to the browser only for `https:` links on
  the jay site.

## Rulings during the build

Questions that came up while building, and how they were settled:

- **No "Confluence: N mentions" line on the Jira side.** The Activity
  Bar badge already counts Confluence mentions.
- **Tree and My pages tooltips show path and space only.** The listing
  has no author or date, and a request per row is too dear. Mention rows
  do show who mentioned Sean and when.
- **Links in Sean's own messages in perch:** perch showed them as plain
  text, so perch 0.7.35 covered Claude's replies only. Sean confirmed the
  design's line, and perch 0.7.36 links them too.
- **The space's home page is "Overview"** (0.2.1). When the home page is
  on the tree's top level, it shows first as "Overview" and its children
  are the top level, as in Confluence's own sidebar; other top-level pages
  follow them. The tree no longer shows the space name twice.
- **Loading shows on the section header** (0.2.2): while the space's tree
  or My pages loads, its header shows "Loading…", even when cached rows
  are already on screen or the section is collapsed. A page's own branch
  already showed "Loading…" under it.
- **The Confluence side hid Jira's controls only in tests** (fixed in
  0.2.1): `.controls { display: flex }` overrode the browser's `[hidden]`
  rule, so the key search, project and period boxes showed on the
  Confluence side. `sidebar.css` now starts with `[hidden] { display:
  none !important; }`, as `ticket.css` does.
- **Pages whose status isn't `current` are read-only**, with "Edit in
  Confluence" and no comment box. A save sends `current` and could
  un-archive the page. A missing status counts as current.
- **A probe 404 shows "Confluence isn't available with this
  sign-in".** A site without Confluence is not an error to retry.
- **Ticket page titles come from remote links, else one `titles()`
  call.** Up to 10 page reads delayed the ticket render.
- **Folder names in a page's path show as "…".** `titles()` reads pages
  only, and a folder isn't a page.
- **`commentId` comes only from `?focusedCommentId`.** Confluence's
  comment permalinks carry both it and a `#comment-<id>` fragment; a
  fragment alone is not trusted.
- **Opening a page, or bringing its tab to the front, marks its
  mentions seen.** A page Sean is looking at has no unseen mentions
  left.
- **A 401 that can't be refreshed never signs Jira out.** With an API
  token or env file, Confluence shows "not available" instead.

## Shipping

- The work is on branch `confluence` in github.com/seanahn/jay. It is
  not pushed or merged yet; Sean decides.
- The plan `docs/superpowers/plans/2026-11-20-jay-confluence.md` was
  last present at a3db14cc62f51198d3b0588e93f6cc66f65c3237.
- The version is 0.2.0.

To check live before publishing:

- the legacy-page signal (editor property `v1`) on a real old-editor
  page;
- the URL form for whiteboards and databases in the tree.

Back to the [README](../../README.md#confluence).
