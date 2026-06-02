import crypto from 'node:crypto'
import express from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { chromium, devices } from 'playwright'
import { z } from 'zod'

const PORT = Number(process.env.PORT || 3001)
const TTL_MS = Number(process.env.SESSION_TTL_MINUTES || 10) * 60 * 1000
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 3)
const DEFAULT_SYNC_URL = process.env.NOTE_AUTO_SYNC_URL || ''
const DEFAULT_NOTE_LOGIN_URL = 'https://note.com/login'

const app = express()
app.set('trust proxy', 1)
app.use(helmet({ contentSecurityPolicy: false }))
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: false }))
app.use(express.static('public', { maxAge: '1h' }))
app.use(rateLimit({ windowMs: 60_000, limit: 180 }))

const sessions = new Map()

const startSchema = z.object({
  syncUrl: z.string().url(),
  syncToken: z.string().min(20),
  noteLoginUrl: z.string().url().optional(),
})

function randomId(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url')
}

function html(body, title = 'Semi-Auto Browser') {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>${body}</body>
</html>`
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function assertSession(req) {
  const session = sessions.get(req.params.id)
  const key = req.query.key || req.get('x-session-key')
  if (!session || session.key !== key) {
    const error = new Error('Session not found')
    error.status = 404
    throw error
  }
  if (Date.now() > session.expiresAt) {
    destroySession(session.id)
    const error = new Error('Session expired')
    error.status = 410
    throw error
  }
  session.lastSeenAt = Date.now()
  return session
}

async function destroySession(id) {
  const session = sessions.get(id)
  if (!session) return
  sessions.delete(id)
  await session.browser?.close().catch(() => {})
}

function serializeSession(session) {
  return {
    id: session.id,
    currentUrl: session.page.url(),
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
    capturedAt: session.capturedAt,
    status: session.status,
    message: session.message,
  }
}

async function createBrowserSession({ syncUrl, syncToken, noteLoginUrl }) {
  if (sessions.size >= MAX_SESSIONS) {
    const error = new Error('Too many active sessions')
    error.status = 429
    throw error
  }

  const id = randomId()
  const key = randomId(24)
  const iPhone = devices['iPhone 15'] || devices['iPhone 14'] || devices['iPhone 13']
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const context = await browser.newContext({
    ...iPhone,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  })
  const page = await context.newPage()
  const session = {
    id,
    key,
    browser,
    context,
    page,
    syncUrl,
    syncToken,
    expiresAt: Date.now() + TTL_MS,
    lastSeenAt: Date.now(),
    capturedAt: null,
    status: 'starting',
    message: '',
  }
  sessions.set(id, session)

  page.on('framenavigated', () => {
    session.status = 'open'
  })

  try {
    await page.goto(noteLoginUrl || DEFAULT_NOTE_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    session.status = 'open'
  } catch (error) {
    session.status = 'error'
    session.message = `note.com を開けませんでした: ${error.message}`
  }

  return session
}

function cookieHeader(cookies) {
  return cookies
    .filter((cookie) => cookie.name && cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ')
}

async function hasNoteSessionCookie(context) {
  const cookies = await context.cookies(['https://note.com'])
  return cookies.some((cookie) => cookie.name.startsWith('_note_session'))
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, activeSessions: sessions.size })
})

app.get('/', (_req, res) => {
  const body = `
    <main class="shell">
      <h1>Semi-Auto Browser</h1>
      <p class="lead">iPhone から一時ブラウザを操作し、note.com のログイン Cookie を note-auto-poster に同期します。</p>
      <form method="post" action="/sessions" class="panel">
        <label>sync URL
          <input name="syncUrl" type="url" required value="${escapeHtml(DEFAULT_SYNC_URL)}" placeholder="https://your-app.vercel.app/api/sync-cookie">
        </label>
        <label>cookie sync token
          <textarea name="syncToken" required rows="4" placeholder="note-auto-poster のアカウント詳細で発行した token"></textarea>
        </label>
        <input name="noteLoginUrl" type="hidden" value="${DEFAULT_NOTE_LOGIN_URL}">
        <button type="submit">ブラウザを開始</button>
      </form>
      <p class="note">セッションは ${Math.round(TTL_MS / 60_000)} 分で期限切れになります。Cookie はこのサービスには保存しません。</p>
    </main>`
  res.send(html(body))
})

app.post('/sessions', async (req, res, next) => {
  try {
    const data = startSchema.parse(req.body)
    const session = await createBrowserSession(data)
    res.redirect(303, `/s/${session.id}?key=${session.key}`)
  } catch (error) {
    next(error)
  }
})

app.get('/s/:id', (req, res, next) => {
  try {
    const session = assertSession(req)
    const body = `
      <main class="remote" data-session-id="${session.id}" data-session-key="${session.key}">
        <header class="remote-header">
          <div>
            <strong>Semi-Auto Browser</strong>
            <small id="url">${escapeHtml(session.page.url())}</small>
          </div>
          <button id="refresh" type="button">更新</button>
        </header>
        <div id="status" class="status">起動中...</div>
        <button id="screenButton" class="screen-button" type="button" aria-label="browser screen">
          <img id="screen" alt="browser screen">
        </button>
        <form id="typeForm" class="toolbar">
          <input id="textInput" autocomplete="off" autocapitalize="none" placeholder="タップした入力欄へ送る文字">
          <button type="submit">入力</button>
        </form>
        <div class="toolbar grid">
          <button data-key="Enter" type="button">Enter</button>
          <button data-key="Tab" type="button">Tab</button>
          <button data-key="Backspace" type="button">削除</button>
          <button id="capture" type="button">Cookie同期</button>
        </div>
        <form id="navForm" class="toolbar">
          <input id="navInput" type="url" value="https://note.com/login">
          <button type="submit">移動</button>
        </form>
      </main>
      <script src="/remote.js" type="module"></script>`
    res.send(html(body, 'Remote Browser'))
  } catch (error) {
    next(error)
  }
})

app.get('/api/sessions/:id/state', async (req, res, next) => {
  try {
    const session = assertSession(req)
    const buffer = await session.page.screenshot({ type: 'jpeg', quality: 72, fullPage: false })
    const hasCookie = await hasNoteSessionCookie(session.context).catch(() => false)
    res.json({
      ...serializeSession(session),
      hasNoteSessionCookie: hasCookie,
      screenshot: `data:image/jpeg;base64,${buffer.toString('base64')}`,
      viewport: session.page.viewportSize(),
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/sessions/:id/tap', async (req, res, next) => {
  try {
    const session = assertSession(req)
    const { x, y } = z.object({ x: z.number(), y: z.number() }).parse(req.body)
    await session.page.mouse.click(x, y)
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/sessions/:id/type', async (req, res, next) => {
  try {
    const session = assertSession(req)
    const { text } = z.object({ text: z.string().min(1).max(1000) }).parse(req.body)
    await session.page.keyboard.insertText(text)
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/sessions/:id/key', async (req, res, next) => {
  try {
    const session = assertSession(req)
    const { key } = z.object({ key: z.enum(['Enter', 'Tab', 'Backspace', 'Escape']) }).parse(req.body)
    await session.page.keyboard.press(key)
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/sessions/:id/navigate', async (req, res, next) => {
  try {
    const session = assertSession(req)
    const { url } = z.object({ url: z.string().url() }).parse(req.body)
    await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/sessions/:id/capture', async (req, res, next) => {
  try {
    const session = assertSession(req)
    const cookies = await session.context.cookies(['https://note.com'])
    const header = cookieHeader(cookies)
    if (!header.includes('_note_session')) {
      return res.status(400).json({ error: '_note_session Cookie が見つかりません。note.com にログイン済みか確認してください。' })
    }

    const syncRes = await fetch(session.syncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: session.syncToken, cookie: header }),
    })
    const text = await syncRes.text()
    if (!syncRes.ok) {
      return res.status(syncRes.status).json({ error: text || 'Cookie 同期に失敗しました' })
    }

    session.capturedAt = Date.now()
    session.status = 'captured'
    session.message = 'Cookie を同期しました'
    await destroySession(session.id)
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/sessions/:id/close', async (req, res, next) => {
  try {
    const session = assertSession(req)
    await destroySession(session.id)
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

setInterval(() => {
  for (const session of sessions.values()) {
    if (Date.now() > session.expiresAt) destroySession(session.id)
  }
}, 30_000).unref()

app.use((error, _req, res, _next) => {
  const status = error.status || (error.name === 'ZodError' ? 400 : 500)
  const message = error.name === 'ZodError' ? '入力内容が不正です' : error.message || 'Internal Server Error'
  if (status >= 500) console.error(error)
  res.status(status).send(html(`
    <main class="shell">
      <h1>エラー</h1>
      <p class="error">${escapeHtml(message)}</p>
      <p><a href="/">最初からやり直す</a></p>
    </main>
  `))
})

app.listen(PORT, () => {
  console.log(`Semi-Auto Browser listening on :${PORT}`)
})
