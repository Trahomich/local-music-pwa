# Snae Player

**[snaeplayer.com](https://snaeplayer.com)** - Local music player in the browser.

Play audio files stored on your device or served from your own server. Includes playlists, queue, favorites, equalizer, playback speed, and artwork-based theming.

<p align="center">
  <img src="https://raw.githubusercontent.com/minht11/local-music-pwa/main/src/routes/(marketing)/assets/hero.avif" height="400" alt="Snae Player showing the music library and playback controls" />
</p>

## Browser support

Works in all modern browsers. When the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API) is available, currently Chromium-based browsers, the app reads files directly from your chosen folder. In other browsers, files are copied into IndexedDB, which doubles the storage used.

## Music sources

Music sources are managed in **Settings → Directories** and can be combined:

- **Local folders and files** — read straight from your device (see [Browser support](#browser-support)).
- **Server library** — an audio folder served by the self-hosted server (see [Running locally](#running-locally) and [Docker](#docker)) and scanned into the same library view.

The server library is **read-only**. The player never uploads, renames, or deletes files on the server; to change the music, edit the folder on disk and then rescan the server library entry in Settings. Removing the server source in Settings only removes its entries from the browser's local index — the files on the server are never touched.

Supported audio formats (case-insensitive), the same for local and server sources: `.aac`, `.flac`, `.m4a`, `.mp3`, `.ogg`, `.opus`, `.wav`, `.webm`.

## Privacy

With the hosted version — and any purely static deployment using local folders only — your music files and library data never leave your device. The app does not collect or transmit them.

When you add a server library, the browser downloads the audio from *your own* server over HTTP. Files stay on your infrastructure and no third party is involved, but they do travel over the network — see [Security](#security).

Either way, playlists, favorites, history, queue, and settings are stored only in the browser (IndexedDB / local storage). Clearing the site's data deletes this local index and the settings — never the audio files, neither on your device nor on the server.

Page views are counted using [GoatCounter](https://goatcounter.com/), a minimal privacy-preserving analytics tool. It is configured at build time and can be disabled — see [Configuration](#configuration).

## Security

The server has no accounts and no authorization: anyone who can reach its port can list, play, and download everything in the music folder. The API is read-only (GET/HEAD only) and never writes to that folder, but it speaks plain HTTP and is meant for trusted local networks only. Do not expose it to the public internet without external protection, such as a VPN, a firewall, or a reverse proxy with TLS and authentication.

## Translations

The interface is available in English, Russian, Lithuanian, German, French, Spanish, Hindi, Japanese, and Chinese (simplified and traditional). Switch languages in **Settings → Language**; the choice is stored in the browser.

Translations are machine-generated and won't always sound natural. Fixes and suggestions are welcome — each language is a file in [`messages/`](messages/), with [`en.json`](messages/en.json) as the reference. To add a language, also register its code in [`vite.config.ts`](vite.config.ts) and the settings language picker, then run `pnpm run i18n-check`.

## Running locally

Prerequisites: Node.js 26 and pnpm 12 (exact versions are pinned in `devEngines` in [`package.json`](package.json)).

Clone the repo, then copy `.env.example` to `.env`:

```
cp .env.example .env
pnpm install --frozen-lockfile
pnpm run build
```

The static build in `build/` can be deployed as-is on any static hosting — this is how snaeplayer.com runs, and the server library is simply disabled there. To also serve a music folder through the built-in Node server, run:

```
MUSIC_DIR=/absolute/path/to/music pnpm start
```

The player and its API are now at <http://localhost:3000> (`HOST` and `PORT` change the listen address). If `MUSIC_DIR` is empty or unset, the server library is disabled, but the player itself keeps working with local sources.

Or run the development server, which serves the same read-only API:

```
MUSIC_DIR=/absolute/path/to/music pnpm run dev
```

On first run, `pnpm run dev` or `pnpm run build` generates types for SvelteKit, auto-imports, and i18n, so run one of them before type checking.

### Adding the server library in the app

With the server running and `MUSIC_DIR` set, open **Settings → Directories** and add the server library — it appears as a single read-only entry next to your local folders. The player downloads new and changed files through the API and imports tags and artwork the same way as for local folders. After you add or remove files in the folder on disk, rescan the entry from Settings to update the library.

## Docker

The image contains everything needed — no Node.js or pnpm is required on the host:

```
mkdir -p ./music   # put your audio files here; an empty folder is fine
docker compose up --build
```

The player is at <http://localhost:3000>. The host folder `./music` is mounted read-only as `/music` inside the container, so the player cannot modify your files. Then add the server library in Settings as described above.

Common overrides (environment variables in front of the command, or in an `.env` file next to `compose.yaml` — see [`.env.example`](.env.example)):

```
SNAE_PORT=8080 docker compose up --build            # publish on host port 8080
MUSIC_DIR=/path/to/music docker compose up --build  # serve a different host folder
```

Without Compose:

```
docker build -t snae-player .
docker run -p 3000:3000 -v /path/to/music:/music:ro snae-player
```

The Compose service restarts unless stopped and health-checks the server library status endpoint.

## Configuration

| Variable | Applies to | Default | Description |
| --- | --- | --- | --- |
| `MUSIC_DIR` | Server | _(unset)_ | Audio folder of the server library. For `pnpm start` / `pnpm run dev`: a path on that machine — unset or empty disables the server library. For Compose: a host folder mounted read-only to `/music` in the container. |
| `HOST` | Server | `0.0.0.0` | Listen address of the Node server. |
| `PORT` | Server | `3000` | Port of the Node server. |
| `SNAE_PORT` | Compose | `3000` | Host port the player is published on. |
| `PUBLIC_FALLBACK_PAGE` | Build time | `/200.html` in Docker | SPA fallback page of the static build. |
| `PUBLIC_GOAT_COUNTER_URL` | Build time | _(empty)_ in Docker | GoatCounter analytics URL; empty disables analytics. |

Build-time variables are read from `.env` for local builds and from `--build-arg` in Docker. Runtime variables come from the environment; Compose additionally reads an `.env` file next to `compose.yaml`.

### Server library API

Same-origin, read-only HTTP API under `/api/server-library` (GET/HEAD only; other methods get `405`):

- `GET /api/server-library/status` — whether the server library is enabled; used for the Docker healthcheck.
- `GET /api/server-library/files` — recursive index of the supported audio files.
- `GET /api/server-library/file?path=<url-encoded-path>` — file download with HTTP Range support.

Errors are JSON with a stable `error.code`. The exact contract is specified in [`CONTRACTS.md`](CONTRACTS.md).

## Tech stack

SvelteKit/Svelte 5 · TypeScript · Tailwind CSS 4 · Node 26 server (runs TypeScript directly)
