# Cablegram Community Server

[![CI](https://github.com/seep-labs/cablegram-server/actions/workflows/ci.yml/badge.svg)](https://github.com/seep-labs/cablegram-server/actions/workflows/ci.yml)
[![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-blue)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

Cablegram Community is the open-source, self-hosted control-plane server for Cablegram households. It lets your phone and TV pair, manage profiles and profile locks, sync your video catalog, play videos directly over your home LAN or from your own Telegram channel, and use your phone as a TV remote.

## What Is Included in Community

- **Device-based sign-in:** First-start setup code for your first phone, and existing-phone approval for additional phones (no email server or OAuth setup required).
- **TV pairing and trust levels:** 6-digit PIN / QR pairing, Home TV vs. Temporary TV trust with automatic expiry.
- **Profiles and privacy:** Household profiles, optional profile PINs, profile lock switch requests, and per-attempt phone approval for private videos.
- **Plain catalog and manual metadata:** Register phone-local and Telegram videos, organize collections and My List, and edit titles, years, and summaries manually.
- **Direct LAN and Telegram playback:** Stream directly from your phone over LAN TLS or from your linked Telegram library channel.
- **Remote control and watch progress:** WebSocket and HTTP remote commands, live playback state, and per-profile resume positions.

## Quick Start with Docker Compose

1. Copy `.env.example` to `.env` and adjust `PUBLIC_BASE_URL` (and `CABLEGRAM_DOMAIN` if using HTTPS):
   ```bash
   cp .env.example .env
   docker compose up -d
   ```
2. View the first-start setup code printed in the server logs:
   ```bash
   docker compose logs cablegram
   ```
3. In the Cablegram phone app, choose **Join a server**, enter your server URL and the 6-digit setup code.
4. On the TV's **Pair this TV** screen, choose **Use your own server**, enter the same URL, then pair it from the phone with the PIN shown.

If you ever lose all signed-in phones, mint a new recovery setup code from the server host:
```bash
docker compose exec cablegram node dist/apps/community/src/index.js setup-code
```

See [`docs/self-hosting.md`](docs/self-hosting.md) for full configuration, LAN-only mode, Telegram setup, backups, and upgrades.

## Building and Testing from Source

Requires Node.js 22+:

```bash
npm install
npm run build
npm test
```

## Support the project

Cablegram is free and open source. If it makes your movie nights easier, you can help cover server costs and keep development going on [Ko-fi](https://ko-fi.com/cablegram).

## License

Cablegram Community Server is licensed under the [GNU General Public License v3.0](LICENSE) (`GPL-3.0-only`).
