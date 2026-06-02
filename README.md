# Semi-Auto Browser

Semi-Auto Browser is a small cloud browser service for iPhone-assisted note.com cookie sync.

It opens a temporary Playwright Chromium session with an iPhone-like viewport, lets the user operate it from an iPhone web page, captures note.com cookies after manual login, and posts them to an existing `note-auto-poster` `/api/sync-cookie` endpoint.

The Playwright npm package and Docker image must stay on the same version. This project pins both to `1.60.0`.

## Why This Exists

`note-auto-poster` already has:

- one-time cookie sync token issuing
- `/api/sync-cookie`
- note session verification
- DB storage for the note cookie header

This service replaces the PC-only `scripts/note_cookie_sync/capture_and_sync.py` flow with a browser that can be operated from iPhone.

## Flow

1. Open the note account detail page in `note-auto-poster`.
2. Issue a cookie sync token.
3. Open this service on iPhone.
4. Paste the sync URL and token.
5. Start a browser session.
6. Tap/type through note.com login.
7. Press `Cookie同期`.
8. The service posts `{ token, cookie }` to `/api/sync-cookie`.
9. The temporary browser is closed.

Cookies are kept in memory only while the browser session is active. They are not stored by this service.

## Local Run

```bash
npm install
npm start
```

Open:

```text
http://localhost:3001
```

For local browser dependencies outside Docker:

```bash
npx playwright install chromium
```

## Docker

```bash
docker build -t semi-auto-browser .
docker run --rm -p 3001:3001 \
  -e NOTE_AUTO_SYNC_URL="https://your-note-auto-poster.vercel.app/api/sync-cookie" \
  semi-auto-browser
```

## Deploy

The service is Docker-based. Render and Koyeb are the easiest free-tier candidates as of June 2026, but free tier rules can change. Render free web services spin down when idle, which is acceptable for this manual login workflow.

### Render

1. Create a new GitHub repository named `Semi-Auto-browser`.
2. Push this project.
3. In Render, create a new Web Service from the repository.
4. Select Docker runtime.
5. Set environment variables:

```text
NOTE_AUTO_SYNC_URL=https://your-note-auto-poster.vercel.app/api/sync-cookie
PUBLIC_BASE_URL=https://your-semi-auto-browser.onrender.com
SESSION_TTL_MINUTES=10
MAX_SESSIONS=2
```

The included `render.yaml` can also be used as a Blueprint.

## Security Notes

- Treat the cookie sync token as a secret.
- Treat captured note cookies as login credentials.
- Use short session TTLs.
- Do not log cookie values.
- Keep `MAX_SESSIONS` low on free infrastructure.
- Use HTTPS only in production.
- Harden `note-auto-poster` by encrypting `NoteAccount.sessionToken` at rest and making cookie sync tokens one-time use.

## Known Limitations

- This is not a full VNC browser. It streams screenshots and forwards tap/type/key actions.
- CAPTCHA or note.com anti-bot checks may still appear. The point of this service is that the user can solve them manually from iPhone.
- Free hosting can sleep or restart. A restart kills active browser sessions.
- Playwright Chromium is not identical to real iPhone Safari/WKWebView.
