# Rust engine

How the Rust engine works beyond the rules in [AGENTS.md](../AGENTS.md), which holds its boundaries and what state it owns. The tasks that build this are in [TODO-rust-core.md](../TODO-rust-core.md), and what is still undecided is there as "Decide:" tasks.

## Local replica

- Desktop and mobile: SQLite on disk. It holds metadata and thread structure for all mail, and body text for the last 90 days, the same window as the Backend. Older bodies come through the Backend on demand
- Web: SQLite in memory, one per tab, filled from the Backend on load. Nothing persists in the browser and tabs do not coordinate. The web app needs a connection, and has no offline queue: an action taken without a connection fails at once
- The database is not encrypted; the operating system's disk encryption covers it. No secret is stored in it
- Local search is SQLite FTS5, updated in the same transaction as the mail row. Search by meaning comes from the Backend

## Backend port and the demo Backend

- Everything the Backend does for the engine goes through one trait, the Backend port. The engine applies a local change to its SQLite replica in one transaction and reports it; work only the Backend can do (sending, agent runs, model output, sync, permission and cap decisions, due-time jobs such as snooze and scheduled sends) is requested through the port and comes back as updates
- Until the real Backend exists, a demo implementation in `engine/src/demo/` plays it with scripted behaviour and a sample world delivered after sign-in. The hosts inject it; nothing outside that module knows it exists. It is replaced by the real Backend, not extended
- Short-lived results of an action are one mechanism: outcomes (done or failed, per target) and one notice (undo or info), both sent in the shell view
- What is open, expanded or being entered is engine state where it mixes with data (forms, replaced keys, expanded runs), and each typed field carries a revision that tells the Frontend when to drop what was typed

## Session

- Desktop and mobile keep the session credential in the operating system's keychain
- Desktop sign-in binds the loopback, names its port in `StartSignIn`, and opens the page `StartSignIn` returns in the system browser itself, after checking it is the provider's own over https (`accounts.google.com` or `login.microsoftonline.com`); a page that fails the check or cannot be opened is a sign-in failure the user sees. It then waits on 127.0.0.1 for a POST to `/` carrying `handoff` as a form field, for as long as `StartSignIn` says the attempt lives. The engine keeps the claim in memory, collects the bearer token with the claim and the handoff through `FinishSignIn`, which names the user's email with it, keeps the token in the keychain and sends it with every `AuthService` call. This is the one local listener the engine runs
- Desktop's Backend URL must be the Backend's public origin, the one its callback page is served from (`PUBLIC_ORIGIN`): the listener takes the handoff only from a page of the origin of that URL. In development that is the Vite dev server `tauri dev` starts, `http://localhost:5173`, which proxies the Backend's calls and `/auth/`; the app defaults to it, and `EVERYMAIL_BACKEND_URL` overrides it
- Each sign-in attempt has its own number. The answers about it (its step, its failure, its session) carry the number and land only while that attempt is waited on. A cancel or a newer attempt drops the listener's `End`, which ends its wait. A session `FinishSignIn` releases for an attempt no longer waited on, or that the keychain refuses, is ended at the Backend with `SignOut`, and nothing of it is kept
- The listener binds 127.0.0.1 on a port the OS picks, before the port is named in `StartSignIn`, and sets no reuse option: Linux and macOS then let no other socket bind that address and port, and Windows refuses a second bind of a specific address to any user, so `SO_EXCLUSIVEADDRUSE` would add nothing
- Every page in the browser can reach 127.0.0.1, so a request counts only when it is exactly what the Backend's page sends: `POST /`, `Host: 127.0.0.1:<port>` (which defeats DNS rebinding), `Origin` equal to the Backend's origin, `Content-Type: application/x-www-form-urlencoded`, and a body that is the one field `handoff` of 43 base64url characters. Anything else gets a 400 with no detail and no CORS grant, `OPTIONS` included, and the listener goes on, so no page can end a sign-in. Only a candidate, the caller or the attempt's lifetime ends a wait
- The listener cannot tell a real handoff from a guessed one. The wait hands each candidate back with the listener; the engine sends it to `FinishSignIn`, where a wrong handoff answers pending and leaves the attempt as it was, and waits again. A guess can neither end the wait nor lock out the real handoff
- One connection is served at a time, with a 16 KiB head, a body of exactly the one field and 5 seconds per connection; the OS holds the next ones. A request carrying `Transfer-Encoding` or any of the four checked headers twice is refused. The answer to a candidate is a plain page saying to return to EveryMail, with `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'`, `X-Content-Type-Options: nosniff` and `Connection: close`
- The handoff is never logged, has no debug form and is not kept once a candidate is handed back. It is not zeroed: the protobuf encoding and the HTTP client that carry it to `FinishSignIn` make copies the engine cannot reach
- Not defended: a program on the same machine can keep the listener busy, or see the port and post first, and so stall a sign-in. It cannot finish one: a handoff it takes still needs the claim, which only the app holds in memory. A program that can read the app's memory, as the same user often can, is out of reach of any listener
- On a Linux setup with no keychain service the credential goes into a file only the user can read, and the app says so once
- On web the Backend sets an HttpOnly cookie, so the credential never enters JavaScript or WASM memory. The engine checks the provider's page the same way and names it in the sign-in view, and the Frontend goes to it in the same tab, since the engine's Worker cannot navigate. The engine started after the callback learns it is signed in from `GetSession`
- Both start a signed-out launch by asking `GetSession`, and sign out with `SignOut`; the platform layer's `sign_in_return` is the one place that chooses the same tab or the loopback

## Drafts

- A draft is saved locally at once and synced through the Backend, so it appears on the user's other devices and agents can see it. It is not written to the provider's Drafts folder

## Message bodies on web

- A Service Worker answers body and attachment URLs by asking the engine Worker for the bytes. The iframe loads an ordinary same-origin URL, as it does on desktop through the custom URI scheme, and the Frontend code is the same on both
- On web the iframe carries no `sandbox` attribute, because Chromium does not send a sandboxed iframe's load through a Service Worker. The Service Worker's response carries `Content-Security-Policy: sandbox allow-scripts` instead, which gives the body the same opaque origin with scripts only. The engine supplies that header value; desktop keeps the attribute and sends the header too
- The body URL carries the engine's theme as a query part, so a theme change reloads each body. The Service Worker passes everything after `/body/`, query included, to the engine

## Desktop shell

- Tauri commands are denied by default: an app manifest names each command the webview may call
- Windows and macOS ship through the Microsoft Store and the Mac App Store, which also deliver updates. Linux ships from the first release through an install script fetched with curl, which also updates. The script checks a GPG signature on the release's SHA256SUMS file, then the hash, before it installs anything

## Body height

- The engine appends one small trusted script to each served body, allowed by a per-response nonce, that reports the body's height to the page. Every other script stays blocked by the sanitizer and the content policy
- The message is a bare number of CSS pixels: the body element's height, posted on load and on every resize. The page accepts it only from the iframe's own window

## Mobile

- Tauri 2 mobile: the same Frontend and the same crate, compiled natively for iOS and Android. No second interface
- The phone apps go out through TestFlight and Play testing first, and to the public stores once the product is past alpha
