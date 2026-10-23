# Cablegram Community Server — Self-Hosting Guide

## 1. What This Is

- A self-hosted control-plane server for a household: pair phones and TVs, sync a plain library, control playback, and stream from phone LAN or your own Telegram channel.
- Why run it: you operate your own control plane so your household devices communicate only with infrastructure you control.
- Community is the open-source core (`edition: "community"`). See `GET /api/server` for the active feature set.

## 2. What Is Not Included in Community

Community excludes hosted-only plugins:
- Artwork enrichment (automatic posters, backdrops, and bundled profile packs)
- AI title matching and external catalog lookup
- Closed-caption sync and lookup services
- Remote media relay (phone-local media plays when phone and TV share a home network; Telegram sources play anywhere the TV is signed in to Telegram)
- Web URL video extraction
- External object/cloud bucket connections
- Billing, quotas, and email-based sign-in

`GET /api/server` reports:
```json
{
  "api_version": 1,
  "edition": "community",
  "server_version": "0.1.0",
  "auth": { "mode": "device" },
  "features": {
    "artwork": false,
    "ai_title_resolution": false,
    "subtitles": false,
    "relay": false,
    "web_import": false,
    "cloud_storage": false,
    "telegram": true,
    "lan_playback": true,
    "profile_lock": true
  },
  "legal": null
}
```

## 3. Requirements

- **Container host:** Docker 24+ and Docker Compose v2 on `linux/amd64` or `linux/arm64` (minimum 1 vCPU, 512 MB RAM, 2 GB disk).
- **Bare metal (without Docker):** Node.js >= 22.
- **Network:** Phone and TV on the same LAN for phone-local video playback; an HTTPS reverse proxy if phones reach the server away from home.
- **Clients:** Cablegram Android Phone, iOS Phone, Android TV, TV Web, or Web Remote supporting `api_version: 1` (`GET /api/server`).

## 4. Installation

### Option A: Docker Compose with Caddy (HTTPS)

1. Copy `docker-compose.yml` and `.env.example` (as `.env`).
2. Set `CABLEGRAM_DOMAIN` and `PUBLIC_BASE_URL` in `.env`, then start:
   ```bash
   docker compose up -d
   ```

### Option B: LAN-Only HTTP

1. In `docker-compose.yml`, uncomment `ports: ["3000:3000"]` on the `cablegram` service and stop the `caddy` service (or run `docker compose up -d cablegram`).
2. Set `REQUIRE_TLS=false` and `PUBLIC_BASE_URL=http://<lan-ip>:3000`.

### Configuration Reference

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `PORT` | `3000` | No | HTTP listen port |
| `PGLITE_DIR` | `/data` | No | Directory for the embedded PGlite database, `secrets.json`, and `backup.sock` |
| `PUBLIC_BASE_URL` | *(request host)* | Recommended | Canonical base URL (`https://...` or `http://<lan-ip>:3000`) |
| `TRUST_PROXY` | `false` (`true` in the Compose file) | No | Trust `X-Forwarded-For`/`X-Real-IP` for per-client rate limits. Enable only when the server is reachable through the proxy alone |
| `REQUIRE_TLS` | `true` in production | No | Rejects plain `http` `X-Forwarded-Proto` requests when `true` |
| `WEB_APP_ORIGINS` | *(empty)* | No | Comma-separated origins allowed by CORS for Web Remote or TV Web |
| `TELEGRAM_API_ID` | *(empty)* | Optional | Telegram API ID from `https://my.telegram.org` |
| `TELEGRAM_API_HASH` | *(empty)* | Optional | 32-hex Telegram API hash |
| `JWT_SECRET` | Auto-generated in `/data/secrets.json` | No | Override signing secret (min 32 chars) |
| `PIN_PEPPER` | Auto-generated in `/data/secrets.json` | No | Override HMAC secret (min 32 chars) |

### Secret Initialization and Data Layout

On first start, if `JWT_SECRET` and `PIN_PEPPER` are not provided in the environment, the server generates 32-byte random secrets and writes them to `/data/secrets.json` with `0600` permissions.

`/data` contains:
- PGlite PostgreSQL data files
- `secrets.json` (mode `0600`)
- `backup.sock` (mode `0600`, UNIX domain socket for live snapshots and setup codes)

## 5. First-Time Setup

1. On first start with an empty database, the server logs a single-use 6-digit setup code valid for 1 hour:
   ```bash
   docker compose logs cablegram
   ```
2. Open the Cablegram phone app or Web Remote, choose **Join a server**, enter your server URL, and enter the 6-digit setup code (`POST /api/auth/setup/claim`).
3. Your phone becomes the first device and creates the household and default profile.

## 6. Pairing More Devices

- **Additional phones:** On the new phone, choose **Join a server** -> **Request approval from an existing phone** (`POST /api/auth/join-requests`). The new phone displays a 6-digit confirmation code; approve it from your signed-in phone (`POST /api/auth/join-requests/:id/approve`).
- **TVs:** Scan the TV pairing QR code or enter its 6-digit PIN from your phone. During LAN pairing, the phone hands your custom server URL to the TV so the TV switches to your server automatically. In TV Settings, the current server URL is shown alongside **Return to default server**.
- **Family members:** Create household profiles (with optional 4–8 digit PINs and profile lock) inside the single household.

## 7. Remote Access (Reverse Proxy)

- **Caddy (included in `docker-compose.yml`):** Automatically provisions TLS certificates and forwards HTTP and WebSocket upgrades (`/api/control/commands/socket`).
- **nginx example:**
  ```nginx
  location / {
      proxy_pass http://127.0.0.1:3000;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
  }
  ```

## 8. Operations

- **Live Backup:** Run a transaction-safe gzipped PGlite snapshot while the server is running:
  ```bash
  docker compose exec cablegram node dist/apps/community/src/index.js backup /data/backup.tar.gz
  ```
  Also back up `/data/secrets.json` alongside your database snapshot.
- **Restore:** Stop the container, extract the snapshot archive into `/data` (preserving `secrets.json`), and start the container.
- **Upgrades:** Database migrations are forward-only (`schema_migrations(id, module, version)`). Always take a backup before upgrading. The server refuses to start if `/data` was migrated by a newer schema version than the binary knows.
- **Lost All Devices (Recovery):** Mint a new 6-digit setup code over the UNIX socket without restarting the server:
  ```bash
  docker compose exec cablegram node dist/apps/community/src/index.js setup-code
  ```
- **Reset:** Removing `/data` and restarting resets the household and creates a fresh setup code.

## 9. Troubleshooting

- **Phone cannot reach the server:** Verify `/health` and `/api/server` are reachable from the phone's network and that WebSocket upgrades are enabled on your reverse proxy.
- **Setup code expired or already used:** Run the `setup-code` CLI command above to issue a fresh 6-digit code.
- **TV does not adopt the server URL:** Ensure the phone and TV are on the same local network during initial pairing so the phone can hand the server URL to the TV.
- **Library shows text placeholders instead of posters:** Expected in Community (`features.artwork: false`). Titles, years, and summaries can be edited manually from the phone app.
- **Phone-local media will not play away from home:** Expected in Community (`features.relay: false`); phone and TV must share a local network for direct LAN streaming.

## 10. Privacy and Outbound Traffic

Cablegram Community makes **zero** outbound requests to AI providers, catalog metadata services, closed-caption services, or Cablegram-operated servers. Telegram sessions remain on your client devices; the server stores only the linked Telegram account ID, display name, and library channel ID.

## 11. Support, Security, and License

- **License:** `GPL-3.0-only` (see [`LICENSE`](../LICENSE)).
- **Contributions:** Source mirror; outside pull requests are not accepted in v1 (see [`CONTRIBUTING.md`](../CONTRIBUTING.md)).
- **Security:** See [`SECURITY.md`](../SECURITY.md) for private vulnerability disclosure.
