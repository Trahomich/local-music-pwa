# Snae Player

**[snaeplayer.com](https://snaeplayer.com)** - Local music player in the browser.

Play audio files stored on your device or served from your own server. Includes playlists, queue, favorites, equalizer, playback speed, offline downloads, and artwork-based theming. A self-hosted server adds personal accounts, a shared read-only music library, and playlists, favorites, and history synced across your devices.

<p align="center">
  <img src="https://raw.githubusercontent.com/minht11/local-music-pwa/main/src/routes/(marketing)/assets/hero.avif" height="400" alt="Snae Player showing the music library and playback controls" />
</p>

## Browser support

Works in all modern browsers. When the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API) is available, currently Chromium-based browsers, the app reads files directly from your chosen folder. In other browsers, files are copied into IndexedDB, which doubles the storage used.

## Music sources

Music sources are managed in **Settings → Directories** and can be combined:

- **Local folders and files** — read straight from your device (see [Browser support](#browser-support)).
- **Server library** — an audio folder served by the self-hosted server (see [Running locally](#running-locally) and [Docker](#docker)) and scanned into the same library view. Using it requires signing in (see [Accounts and synced data](#accounts-and-synced-data)).

The server library is **read-only**. The player never uploads, renames, or deletes files on the server; to change the music, edit the folder on disk and then rescan the server library entry in Settings. Removing the server source in Settings only removes its entries from the browser's local index — the files on the server are never touched.

Scanning never makes your browser download and parse the audio. The server reads tags and embedded artwork once for everyone and keeps a persistent index: the first scan of a large folder runs entirely on the server — it can take a while and shows progress — and later rescans are incremental, skipping files that have not changed. Audio itself is downloaded only when you play a track.

Supported audio formats (case-insensitive), the same for local and server sources: `.aac`, `.flac`, `.m4a`, `.mp3`, `.ogg`, `.opus`, `.wav`, `.webm`.

## Accounts and synced data

The hosted static version has no accounts: everything stays in the browser. A self-hosted server adds personal accounts with per-user data:

- **Sign up with a username and password** — no email needed. Registration is open by default; once your users exist, close it with `SNAE_ALLOW_REGISTRATION=false` (see [Configuration](#configuration)).
- **Playlists, favorites, and listening history** are stored on the server per account and follow you to every browser and device where you sign in.
- **Queue, volume, equalizer, theme, and other settings stay local** to each browser. Local folders and files never leave the device, and tracks from local sources are not synced — a synced playlist keeps such entries only in the local profile of the device where they were added.
- **Accounts are fully separated.** You never see another user's playlists, favorites, or history, and signing out or switching accounts never mixes data between profiles. Whatever you collected while not signed in stays in its own browser profile and is not copied into an account automatically.

Synced changes are applied on the server right away — there is no offline editing for playlists, favorites, and history: if saving fails, the app says so instead of pretending the change was stored. Other tabs and devices pick up the changes within about half a minute.

## Offline listening

Tracks from the server library can be downloaded for offline playback:

- **Single track** — **Download for offline** in the track menu; afterwards the same menu offers **Remove download** to free the space.
- **Whole playlist** — the **Download playlist** button on the playlist page, favorites included, with progress and a cancel option. It downloads exactly the playlist's current entries: tracks already downloaded and unchanged are skipped, and so are tracks from local folders — they are on the device already. The button is disabled for empty or local-only playlists, and cancelling keeps nothing half-downloaded.
- **Internal storage, not an export** — downloads live in the app's offline storage (the browser's IndexedDB) inside the current account's profile. Each account — and the anonymous profile — has its own downloads; you never see another user's. There is no ZIP and no copy in the system Downloads folder.
- **Space is the browser's quota** — downloads share the site's storage quota. Before a batch, the app checks the reported free space and asks the browser for persistent storage (best-effort: a refusal does not block downloading); if space runs out, you get a clear error and no half-downloaded file is kept.
- **Stale copies** — if a track changes on the server, your download is not silently deleted; it is marked as needing an update. To update it, choose **Download for offline** again while online; until you do, the offline copy remains the last version you saved, and it still plays.

The first visit, the library scan, and every download need the network. From the second visit on, the app shell itself opens offline: `/` still redirects to the library, and downloaded tracks play without a connection. While offline you can also remove downloads — but changes to playlists, favorites, and history stay online-only, with no offline editing: they simply sync again when the network returns.

After signing in, the app remembers only your user id and username — never the password or session token — so that your profile can open offline. Signing out, or the server rejecting the session once you are back online, clears that marker.

Local folder tracks are already offline and are never duplicated into the offline storage. Offline mode does not sync local files to the server and does not export tracks out of the app.

## Privacy

With the hosted version — and any purely static deployment using local folders only — your music files and library data never leave your device. The app does not collect or transmit them.

On a self-hosted server, everything likewise stays on *your own* infrastructure — no third party is involved — but data does travel over the network between browser and server (see [Security](#security)):

- Audio files and the server's tag/artwork index of them live on the server (`DATA_DIR`); the music folder itself is read-only to the player and is never modified.
- Playlists, favorites, and history are stored on the server per account; queue and settings stay in the browser (IndexedDB / local storage), in a separate browser profile per account.
- Passwords are stored only as salted hashes, sessions only as token hashes — never in plain text.

Clearing the site's data deletes the local index, settings, and offline downloads on that device — never the audio files, neither on your device nor on the server, and never your server-side account data.

Page views are counted using [GoatCounter](https://goatcounter.com/), a minimal privacy-preserving analytics tool. It is configured at build time and can be disabled — see [Configuration](#configuration).

## Security

Accounts use usernames (3–32 characters of `A–Z a–z 0–9 . _ -`, unique case-insensitively) and passwords (8–128 characters). Passwords are hashed with `scrypt` and an individual salt. Signing in creates a 30-day session in the `snae_session` cookie (`HttpOnly`, `SameSite=Strict`); the server stores only a hash of the session token. Failed sign-ins are rate-limited per IP and username, and the API never reveals whether a username exists. Mutating endpoints accept same-origin JSON requests only, and no CORS is opened.

**Transport encryption is on you.** The built-in server speaks plain HTTP. Sign-in and cookies work over HTTP, but credentials and session cookies then travel unencrypted — anyone able to sniff the traffic can hijack a session — and browsers do not treat plain HTTP (outside localhost) as a secure context. The Compose deployment serves the player over the Yggdrasil overlay network; that does not change what the browser sees. For anything beyond a trusted local network, put the player behind HTTPS — for example a reverse proxy with TLS — and set `SNAE_TRUST_PROXY=true` so the session cookie is marked `Secure`. `SNAE_SECURE_COOKIES=false` is the default precisely because the current Yggdrasil mode is plain HTTP; switch it to `true` only once HTTPS is in place — over HTTP, browsers drop `Secure` cookies and sign-in breaks. Do not expose the plain-HTTP port to the public internet; this setup is not production-grade internet security.

## Translations

The interface is available in Russian (default), English, Lithuanian, German, French, Spanish, Hindi, Japanese, and Chinese (simplified and traditional). New visitors get Russian; once you pick a language in **Settings → Language**, your choice is stored in the browser and always wins over the default.

Translations are machine-generated and won't always sound natural. Fixes and suggestions are welcome — each language is a file in [`messages/`](messages/), with [`en.json`](messages/en.json) as the reference. To add a language, also register its code in [`vite.config.ts`](vite.config.ts) and the settings language picker, then run `pnpm run i18n-check`.

## Running locally

Prerequisites: Node.js 26 and pnpm 12 (exact versions are pinned in `devEngines` in [`package.json`](package.json)).

Clone the repo, then copy `.env.example` to `.env`:

```
cp .env.example .env
pnpm install --frozen-lockfile
pnpm run build
```

The static build in `build/` can be deployed as-is on any static hosting — this is how snaeplayer.com runs: there are no accounts there, and the server library is simply disabled. To also serve a music folder through the built-in Node server, run:

```
MUSIC_DIR=/absolute/path/to/music pnpm start
```

The player and its API are now at <http://localhost:3000> (`HOST` and `PORT` change the listen address). If `MUSIC_DIR` is empty or unset, the server library is disabled, but the player itself keeps working with local sources.

With `MUSIC_DIR` set, the server starts indexing the folder in the background at startup. Its persistent data — accounts, sessions, synced playlists/favorites/history, and the music tag index — lives as SQLite files in `DATA_DIR` (`./.data` by default locally). Open the player, create your account, and if the machine is reachable by others, disable further sign-ups with `SNAE_ALLOW_REGISTRATION=false`.

Or run the development server, which serves the same API:

```
MUSIC_DIR=/absolute/path/to/music pnpm run dev
```

On first run, `pnpm run dev` or `pnpm run build` generates types for SvelteKit, auto-imports, and i18n, so run one of them before type checking.

### Adding the server library in the app

With the server running and `MUSIC_DIR` set, sign in, open **Settings → Directories** and add the server library — it appears as a single read-only entry next to your local folders. The first scan runs on the server, once for all users and devices, with progress shown in Settings. After you add or remove files in the folder on disk, rescan the entry — only new and changed files are re-read on the server. Your browser imports the parsed tags and artwork from the server's catalog instead of downloading the audio, and fetches music bytes only when you play a track.

## Docker

The image contains everything needed — no Node.js or pnpm is required on the host:

```
mkdir -p ./music   # put your audio files here; an empty folder is fine
docker compose up --build
```

The current Compose deployment also starts an Yggdrasil sidecar. The player shares its network namespace (`network_mode: service:yggdrasil`), because that is where the Yggdrasil TUN interface lives. No host port is published: open `http://[YGGDRASIL_IPV6]:3000` from another Yggdrasil node (IPv6 literals in URLs need brackets). Put your Yggdrasil configuration in `./yggdrasil/` before starting the services. To display the interface addresses, run `docker compose exec yggdrasil ip -6 addr`.

The default host folder in this Compose file is `/data/music`; set `MUSIC_DIR` to override it (for example, `./music`). It is mounted read-only as `/music` inside the container, so the player cannot modify your files. Then add the server library in Settings as described above.

Server data lives in the named volume `snae-data`, mounted at `/data`: user accounts and sessions, synced playlists/favorites/history, and the music tag index all survive container restarts and rebuilds. The index is stored there too — never in the read-only music mount. Keep the volume: `docker compose down -v` deletes it together with all accounts and the index.

Common overrides (environment variables in front of the command, or in an `.env` file next to `docker-compose.yml` — see [`.env.example`](.env.example)):

```
SNAE_PORT=8080 docker compose up --build              # listen on port 8080 in the Yggdrasil namespace
MUSIC_DIR=/path/to/music docker compose up --build    # serve a different host folder
SNAE_ALLOW_REGISTRATION=false docker compose up -d    # close sign-up after creating your users
```

Yggdrasil provides connectivity, but plain HTTP on a non-localhost address is still not a browser secure context. Use HTTPS for the remote UI; otherwise the browser may hide the app behind its unsupported-browser check even though the port is reachable.

Without Compose:

```
docker build -t snae-player .
docker run -p 3000:3000 -v /path/to/music:/music:ro -v snae-data:/data snae-player
```

The Compose service restarts unless stopped and health-checks the public `/api/health` endpoint.

## Configuration

| Variable | Applies to | Default | Description |
| --- | --- | --- | --- |
| `MUSIC_DIR` | Server | _(unset)_ | Audio folder of the server library. For `pnpm start` / `pnpm run dev`: a path on that machine — unset or empty disables the server library. For Compose: a host folder mounted read-only to `/music` in the container. |
| `DATA_DIR` | Server | `./.data` locally; `/data` in Docker | Directory for the server's SQLite files: accounts, sessions, and synced user state (`auth.sqlite`); the music tag/artwork index (`library.sqlite`). Must not be inside `MUSIC_DIR`. |
| `SNAE_ALLOW_REGISTRATION` | Server | `true` | Allow creating new accounts. Set to `false` once your users exist. |
| `SNAE_TRUST_PROXY` | Server | `false` | Trust `X-Forwarded-Proto` from a reverse proxy, so the session cookie is marked `Secure` when HTTPS is terminated there. |
| `SNAE_SECURE_COOKIES` | Server | `false` | Always mark the session cookie `Secure`. Browsers drop such cookies over plain HTTP — use with HTTPS only. |
| `SNAE_SCAN_CONCURRENCY` | Server | `4` | How many files the server tag scanner parses in parallel (`1`–`16`). |
| `HOST` | Server | `0.0.0.0`; `::` in the Compose Yggdrasil setup | Listen address of the Node server. |
| `PORT` | Server | `3000` | Port of the Node server. |
| `SNAE_PORT` | Compose | `3000` | Player port in the shared Yggdrasil network namespace. |
| `PUBLIC_FALLBACK_PAGE` | Build time | `/200.html` in Docker | SPA fallback page of the static build. |
| `PUBLIC_GOAT_COUNTER_URL` | Build time | _(empty)_ in Docker | GoatCounter analytics URL; empty disables analytics. |

Build-time variables are read from `.env` for local builds and from `--build-arg` in Docker. Runtime variables come from the environment; Compose additionally reads an `.env` file next to `docker-compose.yml`.

## HTTP API

Same-origin JSON API of the Node server. Everything except the auth endpoints and `GET /api/health` requires a signed-in session and answers `401 AUTH_REQUIRED` otherwise; errors carry a stable `error.code`. `GET /api/health` is a public liveness probe for the Docker healthcheck — it returns `200 {"status":"ok"}` and reveals nothing about users, configuration, or paths. The exact contract is specified in [`CONTRACTS.md`](CONTRACTS.md).

### Server library

Read-only access to the music folder under `/api/server-library`:

- `GET status` — whether the library is enabled, plus the scan state (`scanning` / `ready` / `error`) with progress.
- `GET catalog` — the parsed track index, built once on the server and shared by all users.
- `GET artwork/<hash>` — embedded artwork bytes, immutable and long-cached.
- `POST rescan` — start an incremental rescan (`202`); only new and changed files are re-parsed.
- `GET files`, `GET|HEAD file?path=…` — raw listing and file download with HTTP Range support, kept for playback and compatibility.

### Auth

Under `/api/auth`: `POST register`, `POST login`, `POST logout`, `GET me`.

### User state

Synced playlists, favorites, and history of the signed-in account:

- `GET /api/user-state` — the full snapshot.
- `POST /api/user-state/actions` — apply one or several changes atomically; idempotent, returns the new snapshot.

## Tech stack

SvelteKit/Svelte 5 · TypeScript · Tailwind CSS 4 · Node 26 server (runs TypeScript directly; persistence via the built-in SQLite module)
