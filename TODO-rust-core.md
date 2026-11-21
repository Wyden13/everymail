# Rust engine roadmap

The Rust engine is one crate, native in Tauri on desktop and mobile and WASM in a Web Worker on web. It owns all application state: the Backend connection, session and credentials, sync, the local SQLite database, search, the offline queue, navigation and selection, drafts, body and attachment serving, and the `ui.v1` views it shapes for the Frontend.
Other parts: [TODO-backend.md](TODO-backend.md) (Backend), [TODO-frontend.md](TODO-frontend.md) (Frontend).
Tests sit next to the logic they cover and only cover hard, deterministic logic.

## Walking skeleton

- [x] Connection state as an explicit enum with one pure transition function
- [x] Emits `ui.v1.ShellView` bytes and accepts `ui.v1.Intent` bytes
- [x] reqwest for HTTP on desktop and WASM
- [x] Minimal platform adapter for transport and the async runtime
- [x] prost codegen with generated code not committed, clippy in CI
- [x] Tests of the connection transition function for every state and event pair, including retry from each failure
- [x] One dispatch function from the `Intent` oneof to transitions; an unset oneof is a decode error
- [x] CI lints the crate for `wasm32-unknown-unknown` and builds the WASM package
- [ ] A Check that never gets a response leaves the state in Connecting forever: add a request timeout as an explicit event
- [ ] Enable a reqwest TLS backend on desktop before the Backend is reached over https (native builds have none today)
- [ ] Tauri app manifest naming each command the webview may call; every command not named is denied
- [ ] CI check that fails when a registered Tauri command is missing from the manifest

## Session and local database

- [ ] Session credential in the OS keychain on desktop and mobile (macOS, Windows, Linux Secret Service, iOS, Android) behind the platform adapter
      Desktop is done through the `keyring` crate (macOS, Windows, Linux Secret Service); iOS and Android are not
- [ ] On Linux without a keychain service the credential goes into a file only the user can read; test that the file is created with owner-only permissions
- [ ] Credential storage notice as an explicit enum (none, file fallback not yet told, told) persisted by the engine and sent in the shell view, so the app says so once
- [x] rusqlite (bundled) added with the first local table; the database is not encrypted and no secret is stored in it
- [x] Hand-written SQLite migrations applied in order at engine start and recorded in SQLite's `user_version`; the drift check lives in TODO-backend: generated drift check in CI
- [ ] SQLite on disk on desktop and mobile holds metadata and thread structure for all mail and body text for the last 90 days
      On disk on desktop with every row, bodies included; there is no 90-day body window
- [ ] Session state as an explicit enum (signed out, signing in, signed in, expired) with one pure transition function and tests
      Signed out, signing in and signed in exist as the session row and a sign-in state; there is no expired state and no transition function
- [ ] One Backend client attaches the session to every call and turns an expired session into the signed-out transition
      `AuthService` calls carry the bearer; nothing turns a 401 into signed out yet
- [x] `ui.v1` sign-in view and intents: choose Google or Microsoft, open the provider page from `AuthService.StartSignIn` (the system browser on native, the same tab on web, where the Backend sets the cookie), then on native collect the session with `FinishSignIn`, the claim and the handoff
      Each attempt has its own number and only its own answers land; a session collected for a cancelled attempt, or refused by the keychain, is signed out at the Backend. Not yet: a cancelled or failed provider step on desktop (below), the Linux file fallback, mobile, and an https Backend from desktop (the TLS task above). Mail is still the demo's sample after sign-in
- [ ] A provider step the user cancelled or that failed never reaches the loopback, so desktop waits until Cancel or the attempt's lifetime: poll `FinishSignIn` with the claim alone while listening, which already answers denied or failed
- [ ] Keychain calls (load at launch, save, forget) block inside async tasks; move them off the runtime's threads
- [x] Loopback listener behind the platform adapter for native sign-in: bind 127.0.0.1 on a free port, name it in `StartSignIn`, accept one POST to `/` carrying the form field `handoff`, answer a plain page, and close when the attempt ends or is cancelled; a failed or closed listener is an explicit sign-in state
      In `engine/src/platform/loopback.rs`, desktop only (mobile returns through an app link, not built): takes only the Backend page's post, without ending on anything else; a candidate the Backend answers pending with is a guess, and the wait goes on for the lifetime `StartSignIn` names
- [ ] Check by hand in current Chrome, Safari and Firefox, from the Backend on https: the callback page posts to 127.0.0.1 with no permission prompt (Chrome and Firefox Local Network Access), no insecure-form warning and no HTTPS-only block, and the post carries the Backend's `Origin`. Safari's "Warn before connecting to a website over HTTP" is reported to block http loopback sign-in callbacks; if it blocks this one, add a "Decide:" task for the way back on Safari
- [ ] Per-screen queries: each view is built from queries scoped to the current screen and selection, replacing the load of the whole replica on every input (about 52 queries and a full in-memory copy today); measure with a 50k-message replica
      Fine at sample-data size; required before a real mailbox, for speed and for the RAM limit
- [ ] The Backend port's requests and updates defined as `api.v1` protobuf messages and generated with prost, replacing the Rust types in `engine/src/backend.rs`
      Found by the audit: protobuf is the single source of truth for every type shared by the Backend and the engine, and today the port is Rust-only
- [ ] Time zones: wall times formatted in the user's zone and sent to the Backend as wall time plus an IANA zone; everything is UTC today
- [ ] Demo Backend removed from the shipped engine once the real Backend serves the port; until then it is the only implementation and lives only in `engine/src/demo/`
- [ ] Audit leftovers: the demo reads the whole replica through one broad interface; the first sync arrives as the seed's SQL text instead of typed frames; stable ids on briefing lines, news items, dry-run results, result groups, triggers and stats; the remaining unspecified-enum branches in body theming and provider mapping; frozen text in seeded stats
- [ ] Contract gaps the Frontend still works around: subject words for a rule arrive as one phrase; the custom interval's applicability is read from choice ids; a new rule has no default condition; an empty signature is not normalised to none; run outcomes carry no label
      Closed: an empty signature is sent as none; open: subject words are typed as one phrase, the custom interval is read from a choice id, a new rule starts from the first condition choice, run outcomes carry no label

## First account connected and mail synced read-only

- [ ] `ui.v1.ConnectView`: connected accounts with status, the provider list (Gmail, Outlook, iCloud Mail, Yahoo Mail, Fastmail, Other IMAP), and the flow as a `oneof`: picking, waiting for provider sign-in, syncing with progress (messages, folders, search indexing or ready), failed
      Picking, signing in, the IMAP form with its rejection and syncing with messages, percent and search exist; no folder count and no failed state for a provider's sign-in
- [ ] Open the provider sign-in page in the system browser through the platform adapter, and finish connect when the Backend confirms it ("I've signed in" re-checks)
      'I've signed in' finishes against the demo Backend; the provider's page is not opened in the system browser
- [ ] IMAP server, user and app password passed once to the Backend, never stored by the engine
      The engine keeps none of it and hands it to the Backend port (`Work::Connect`); only the demo Backend takes it, no real Backend call exists, and the server and port are checked but not passed
- [ ] Stream reader for TODO-backend: `SyncService.Stream` behind the platform adapter (native streaming on desktop, fetch streams on WASM), decoding length-prefixed frames
- [ ] Frame decoding tests: a frame split across reads, several frames in one read, a heartbeat, a truncated stream
- [ ] Stream connection as an explicit enum (connecting, streaming, waiting to reconnect with backoff) with one pure transition function; reconnect opens with the last cursor; tests of the backoff
- [ ] Sync loop: each Backend batch and its cursor written to SQLite in one transaction; a snapshot batch (newest mail first) is written the same way before live changes
- [ ] Older mail paged in with TODO-backend: `SyncService.ListOlder` when the list reaches the end of the replica
- [ ] Sync merge tests: a replayed batch, a delete before its insert, a message moved between mailboxes, a cursor reset forcing a full resync
- [x] Per-account sync status as an explicit enum, surfaced in the shell view
- [ ] The inbox view is served as soon as the first batch lands

## Inbox and thread reading

- [x] Navigation as one enum: inbox (all inboxes or one account, folder, tab), thread, calendar, briefing, agents, new agent, connect, settings section; persisted across relaunch
- [x] Navigation path: one pure function from the navigation enum to a web path (`/u/<n>/` then the view and, for a thread, its id) and its inverse from a path to an intent; an unknown path is an explicit not-found state; round-trip tests
- [ ] `ui.v1.InboxView`: sidebar (all inboxes with unread count, accounts with counts, Starred, Sent, Archive with count, Quarantine, agents with status and waiting count, the folders the user created), the For you, Updates and Reading tabs, and a window of rows
      Sidebar, tabs and rows exist; the rows are the whole listing, not a window
      Categories, Quarantine and folders come from Gatekeeper's sorting, synced from TODO-backend; nothing is derived from provider folders here
- [x] Row view: stable id, sender, account glyph, subject, row note, time label, unread, starred
- [ ] Windowed list: the Frontend reports the visible range, the engine returns that window plus overscan; the scroll anchor is a row id held by the engine and kept across relaunch
- [ ] Window tests: anchor row removed, rows inserted above the anchor, range past the end
- [x] Selected thread and the reading pane as engine state; which row is selected after an archive is decided here
- [ ] Time labels ("9:12", "Yesterday", "Mon 4:12 pm") formatted in the user's locale and time zone, with tests
      Labels are formatted and tested in UTC; no user locale or time zone
- [ ] `ui.v1.ThreadView`: subject, account and message count, thread summary as a `oneof` (pending, ready, off without a key), messages each collapsed or expanded, per-message summary, an invitation block with answer state, a pending agent draft with its approval state
      Everything is in except the per-message summary: a collapsed message carries a one-line preview, not a summary
- [ ] Opening a thread asks the Backend for its summary through TODO-backend: `MailService` summary request; Scribe runs only then
      Works against the demo Backend; the call to `MailService` is not built
- [ ] Allowlist HTML sanitizer applied when a body is served, on the parsed parts the Backend sends, with tests on hostile fixtures
- [x] Body height script: the engine appends one small trusted script to each served body, allowed by a per-response nonce, that posts the body's height to the page
      Tested on escaped text and a script tag; no hostile HTML fixtures, as bodies are plain text
- [ ] Bodies served by message id through a Tauri custom URI scheme into a sandboxed iframe, with inline images resolved by the same scheme
      Served by message id through the `body` scheme into a sandboxed iframe; inline images are not resolved
      Raw content bytes only: bodies never enter the JS heap and never travel as protobuf or JSON
- [ ] Served bodies carry a CSP that allows only the nonced script, no top navigation; links open in the system browser
      The content policy allows only the nonced script and the sandbox blocks top navigation; opening links in the system browser is not built
- [ ] A body older than the local window is fetched with TODO-backend: `MailService.GetBody` and served by the same scheme
- [ ] Attachments fetched with TODO-backend: `MailService.GetAttachment`, served through the same scheme by attachment id and saved through the platform adapter

## Write actions and the offline queue

- [ ] Offline queue in SQLite: each action stored with an idempotency key, sent in order per thread, retried with backoff, removed only on Backend acknowledgement
- [ ] Queued actions apply to the local replica at once and revert if the Backend rejects them
- [ ] Queue tests: order per thread, resume after relaunch, a duplicate acknowledgement, a rejection that reverts
- [ ] Intents for archive, star, unstar, mark read, mark unread, move, delete and snooze, sent per TODO-backend: `MailService` mutations
      Works against the demo Backend; the calls to `MailService` are not built
- [ ] Mark read when a thread opens, through the queue
      Opening a thread marks it read at once; it does not go through a queue
- [ ] Snooze options in the view (Later today, Tomorrow, This weekend, Next week), sent as the preset plus the user's IANA zone to TODO-backend: `MailService.Snooze`
      Presets are sent without the user's IANA zone, against the demo Backend; `MailService.Snooze` is not built
      The Backend resolves the time with its own clock; the engine shows the instant the Backend returns
- [ ] Offline state and queued-action count in the shell view
- [ ] `ui.v1.ComposerView`: from (account), to, subject, quoted thread; text arrives from the Frontend on a debounce and the engine persists the draft in SQLite
      Drafts persist in SQLite with from, to, subject and text; a reply does not quote the thread
- [ ] Draft sync: each saved draft is sent to TODO-backend: `DraftService` and drafts from the user's other devices arrive on the sync stream; nothing is written to the provider's Drafts folder unless TODO-backend: Decide what to offer for Google accounts says so
      Drafts are saved locally; the calls to `DraftService` and drafts from other devices are not built
- [x] The account's signature inserted into new drafts
- [ ] Send queues through the offline queue; send state as a `oneof` (queued, sending, undoable until an instant the Backend stamps on receipt, scheduled for an instant, sent, failed)
      Send goes straight to the Backend port with undoable, scheduled, sending and failed states; there is no offline queue and no queued state
- [ ] Intents for undo send, send later (wall time plus IANA zone, or an instant), and edit or cancel a scheduled send, sent to TODO-backend: `MailService.Send`
      Undo send, send later (day and minute, no zone) and cancel exist against the demo Backend; `MailService.Send` is not built and a scheduled send cannot be edited
- [ ] Attachments: on desktop the engine reads the picked file by path so the bytes never enter the JS heap, then uploads per TODO-backend: attachment upload
- [ ] Key state in the shell view as a `oneof` (no key, key set); with no key, summaries, AI compose and user agents are off while system agents run their code stage only
      As oneofs in the views that depend on it (summary, reply panel, chat, Models), not one field of the shell view
- [ ] AI compose view: model choice, quick replies, tone, instruction, and generation as a `oneof` (empty, writing, draft ready, failed) with the draft as paragraphs; calls TODO-backend: `ComposeService.Write`
      Works against the demo Backend; `ComposeService.Write` is not built
- [ ] Approve and send, edit and decline on an agent draft go through the queue to TODO-backend: `ApprovalService`
      Works against the demo Backend, with no queue and no `ApprovalService` call
      The engine relays the decision and makes none of its own

## Search

- [x] SQLite FTS5 index of subject, sender, recipients and body text, updated in the same transaction as the mail row
- [ ] Local eviction of body text older than 90 days, in the same transaction as the removal from the search index
- [ ] Search query, filters and results as engine state, served through the same windowed list
      Query and results are engine state over the listing shown; there are no filters and the list is not windowed
- [ ] Search tokenizer and ranking tests on fixed fixtures
      Tests cover prefixes, fields and indexing in the same transaction; none covers the ranking order
- [ ] Search by meaning: the engine calls TODO-backend: search by meaning and merges the results into the windowed list

## Agents and approvals

- [ ] `ui.v1.AgentsView`: agents with status as a `oneof` (running, done, waiting, paused, paused at a cap with the reason, deactivated, failed), a system marker, and next run; the selected agent's schedule, model, instructions, stats and recent runs with steps
      Status is running, idle, waiting or deactivated; paused, paused at a cap and failed are not statuses (runs carry them)
- [ ] System agents in `AgentsView`: built-in instructions shown read-only with the user's appended instructions, per-action permissions and schedule editable, intents to deactivate and activate (delete only for user agents), sent to TODO-backend: `AgentService`
      Built-in and appended instructions, permissions, schedule and the deactivate switch work against the demo Backend; `AgentService` is not called
- [ ] Agent notes in `AgentsView`: the agent's notebook and its per-thread notes, with an intent to edit one, sent to TODO-backend: `AgentService` notes
- [ ] Approval queue view: items with agent, time, title, detail, reason and expiry, each item's state as a `oneof` (waiting, resolving, done, declined with a reason such as expired), and the waiting count for the sidebar
      Items, reason, state and waiting count exist; an item has no expiry field
- [ ] Intents for approve, edit, decline, run now, pause and resume, sent to TODO-backend: `AgentService` and `ApprovalService`
      Approve, edit, decline, run now, pause and resume work against the demo Backend; `AgentService` and `ApprovalService` are not called
- [x] `ui.v1.AgentBuilderView`: name, instructions, all eight reactive triggers with sender, account, folder (the watch folder) and agent filters, a custom interval in the schedule options, the lead time for calendar event approaching, schedule options, accounts, Off/Ask/Auto per action, the new-recipient toggle, and the dry run as a `oneof` (idle, reading N messages across M accounts, results, failed)
- [ ] `ui.v1.BriefingView`: the briefings from News Bearer, newest first, from TODO-backend: `BriefingService`
      Works against the demo Backend; the call to `BriefingService` is not built
- [ ] News in `BriefingView`: a news section per briefing with items grouped by topic, each with title, source and link, and an explicit empty state when the user has no topics
      Items by topic with title, source and a link label exist; items have no address to link to
- [ ] News topics on News Bearer's detail in `AgentsView`: the topic list with intents to add and remove one, sent to TODO-backend: news topics
      Topic list with add and remove works against the demo Backend; the Backend call is not built
- [x] The unfinished new agent persisted as an engine draft until created or cancelled
- [ ] Agent and approval changes reach an open app through the sync protocol
      Updates arrive as the demo Backend's `Update`s; the sync protocol is not built
- [x] `ui.v1` chat view on the agents screen for agents that can chat: the conversation's turns with each turn's state as a `oneof`, references that open a thread or an event, and the chat's availability as a `oneof` (ready, turn running, off without a key, agent deactivated)
- [x] Engine-owned selection of the agent's activity or chat pane, with its web path
- [ ] Intents to send a chat message and to clear the conversation, sent to TODO-backend: `ChatService`; a message being sent is an explicit state on the turn (sending, sent, failed with a reason)
      Send and clear work against the demo Backend; `ChatService` is not called and a turn has no sending state
- [ ] Conversation synced into the local replica and updated through the sync protocol
      Turns are in the replica and updated by the demo Backend; the sync protocol is not built
      No permission or approval decision is duplicated from the Backend

## Settings and rules

- [x] `ui.v1.SettingsView` with sections Accounts, Agent permissions, Rules, Models, Appearance; the selected section is engine state
- [x] Accounts section: status ("Synced 1 min ago", "Sign-in expired"), signature, reconnect for an expired sign-in, add account
- [ ] Intent to disconnect a mailbox through TODO-backend: `AccountService`; the engine then deletes that mailbox's rows, queue entries and drafts from the local replica, with a test that none remain
      Works against the demo Backend and drops the mailbox's rows, mail and search entries (tested); `AccountService` is not called and there is no queue to clear
- [ ] Intent to delete the account through TODO-backend: `AuthService`; the engine then deletes the whole local database and the stored credential and goes to signed out, with a test
      Works against the demo Backend and drops the local rows; `AuthService` is not called and no credential is stored
- [ ] Intent to export what only EveryMail holds from TODO-backend: `UserDataService.Export`, saved through the platform adapter without the bytes entering the JS heap
      Export reports progress and a file name against the demo Backend; `UserDataService.Export` is not called and nothing is saved
- [ ] Models section: per provider (Anthropic, OpenAI, Google Gemini, OpenRouter) key status, and an intent that passes a new key once to TODO-backend: `ModelService`, never stored by the engine
      Key status and the key intent work against the demo Backend and the key is never stored; `ModelService` is not called
- [ ] Usage against the caps, the optional daily token budget with an intent to set it, and the reason a cap stopped new runs, from TODO-backend: `SettingsService`
      The daily token budget with its intent and tokens used today work against the demo Backend; no usage against other caps and `SettingsService` is not called
- [ ] Rules section with enabled toggles, new rule and the block list, sent to TODO-backend: `RulesService`
      Rules, toggles, new rule and block list work against the demo Backend; `RulesService` is not called
- [ ] Briefing times, pause all, default permissions and models per task, sent to TODO-backend: `SettingsService`
      Briefing times, pause all, default permissions and task models work against the demo Backend; `SettingsService` is not called
- [x] Theme (System, Dark, Light) and list density (Compact, Comfortable, Roomy) as engine-owned preferences persisted locally and sent in the shell view

## Calendar

- [ ] Calendars and events in the local replica, filled from the sync stream
      The replica holds calendars and events, filled by the demo Backend; the sync stream is not built
- [x] `ui.v1.CalendarView`: events of the visible range from all calendars (Google Calendar, Outlook calendar, CalDAV) in one view; the range and the selected event are engine state
- [ ] Intents to create, edit and delete an event and to answer an invitation, also from a thread, sent to TODO-backend: `CalendarService`
      Create, edit, delete and answer work against the demo Backend, also from a thread; `CalendarService` is not called

## Notifications

- [ ] Desktop system notification raised from a notification event on the sync stream, through the platform adapter, while the app runs
- [ ] Web Push subscription and the APNs or FCM device token passed once to TODO-backend: `NotificationService`, never stored by the engine

## Web parity

- [ ] SQLite in memory on `wasm32` behind the platform adapter, one per tab, filled from the Backend on load; nothing persists in the browser and tabs do not coordinate
      In memory per tab and filled by the demo Backend on load; the real Backend is not built
- [ ] A web tab opens the stream with no cursor, takes the snapshot of newest mail and pages older mail with `SyncService.ListOlder`, so it never pulls the whole mailbox
- [ ] No connection on web is an explicit state in the shell view, since there is no replica to read from; web has no offline queue, so an action taken without a connection fails at once with an engine-sent failed state
      A failed connection is an explicit shell state; the engine does not refuse an action taken without one
- [ ] Session on web is the HttpOnly cookie the Backend sets: requests go same-origin with credentials and the credential never enters WASM memory
      The engine holds no credential on web (`credential::load` is `None`) and sign-in returns in the same tab; no request sets credentials explicitly and the cookie is untested
- [ ] Service Worker message protocol: messages between the engine Worker and the Service Worker that carry bytes only, keyed by the same message and attachment ids as the desktop scheme
      The Service Worker asks the page for bodies by message id; attachments are not served

## Packaging and measurement

- [ ] Check what the Mac App Store sandbox constrains in the engine (file access, keychain, custom URI scheme) before the first store build, and record the findings
- [ ] SQLite `cache_size` and mmap limits set explicitly in one place
- [ ] Measure engine memory with a 50k-message replica and record it against the desktop budget (whole app measured in TODO-frontend)
- [ ] Record WASM bundle size in CI
- [ ] CI builds the crate for the iOS and Android targets
- [ ] Sync on iOS and Android within the background limits measured in TODO-frontend: mobile limits measurement
