# Cloudflare realtime + Web Push backend

This service extends the GitHub Pages earthquake monitor. It does not replace the JMA/GAS feed.

## What it does

- Opens a server-side WebSocket to P2P地震情報 API v2.
- Relays received earthquake / EEW messages to open PWA clients at `/live`.
- Sends Web Push notifications to subscribed devices, including when the PWA is closed.
- Uses a Durable Object to store subscriptions and deduplicate message IDs.
- A one-minute Cron Trigger wakes the Durable Object and helps it recover its upstream connection.

P2P API data is best-effort, not guaranteed. It is not an official emergency alert delivery service and must not replace J-Alert, official EEW, or local authority information.

## Deploy

Run these commands from the `cloudflare` directory with Node.js and npm installed:

```sh
npm install
npx wrangler login
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
npm run deploy
```

Generate a VAPID pair locally with the included browser-only generator:

1. Open `https://a09848281-prog.github.io/earthquake-monitor-pwa/cloudflare/generate-vapid.html` in a secure browser.
2. Tap Generate. The key pair is created locally in that browser; the page does not upload it.
3. Copy the public and private keys into the matching Cloudflare Worker secrets.

Save the public key in `VAPID_PUBLIC_KEY`, the private key in `VAPID_PRIVATE_KEY`, and set `VAPID_SUBJECT` to:

```
https://a09848281-prog.github.io/earthquake-monitor-pwa/
```

Keep the private key secret. Never put it in GitHub Pages or browser code.

After deployment, copy the Worker URL (for example `https://earthquake-monitor-push.<your-subdomain>.workers.dev`). In the PWA settings, paste it into the Cloudflare Worker URL field and save.

## iPad setup

1. Open the GitHub Pages site in Safari.
2. Add it to the Home Screen.
3. Open the Home Screen app.
4. Enter the deployed Worker URL in settings and save.
5. Tap the notification setup button and allow notifications.

The browser must be online and notification permission must remain enabled. Push delivery is best effort and can be delayed by Apple / network conditions.

## API

- `GET /api/config`: returns the public VAPID key.
- `POST /api/subscribe`: stores a PushSubscription.
- `GET /api/status`: health/status snapshot.
- `GET /live`: WebSocket relay for open PWA clients.

The API only allows the configured GitHub Pages origin. Subscriptions are stored in the Durable Object's SQLite-backed storage. The current personal-use limit is 50 subscriptions.
