const root = document.querySelector('.remote')
const sessionId = root.dataset.sessionId
const sessionKey = root.dataset.sessionKey
const screen = document.querySelector('#screen')
const screenButton = document.querySelector('#screenButton')
const statusEl = document.querySelector('#status')
const urlEl = document.querySelector('#url')
const textInput = document.querySelector('#textInput')
const navInput = document.querySelector('#navInput')

let viewport = { width: 390, height: 844 }
let busy = false

function endpoint(path) {
  return `/api/sessions/${sessionId}${path}`
}

async function api(path, body) {
  const res = await fetch(endpoint(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-key': sessionKey,
    },
    body: JSON.stringify(body || {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || '操作に失敗しました')
  return data
}

async function refresh() {
  if (busy) return
  busy = true
  try {
    const res = await fetch(endpoint(`/state?key=${encodeURIComponent(sessionKey)}`))
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '状態取得に失敗しました')
    screen.src = data.screenshot
    viewport = data.viewport || viewport
    urlEl.textContent = data.currentUrl || ''
    const cookieText = data.hasNoteSessionCookie ? 'note Cookie 検出済み' : 'note Cookie 未検出'
    statusEl.textContent = `${cookieText} / ${new Date(data.expiresAt).toLocaleTimeString('ja-JP')} まで有効`
  } catch (error) {
    statusEl.textContent = error.message
  } finally {
    busy = false
  }
}

screenButton.addEventListener('click', async (event) => {
  const rect = screen.getBoundingClientRect()
  const x = Math.round((event.clientX - rect.left) * (viewport.width / rect.width))
  const y = Math.round((event.clientY - rect.top) * (viewport.height / rect.height))
  statusEl.textContent = `tap ${x}, ${y}`
  try {
    await api('/tap', { x, y })
    setTimeout(refresh, 500)
  } catch (error) {
    statusEl.textContent = error.message
  }
})

document.querySelector('#typeForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = textInput.value
  if (!text) return
  try {
    await api('/type', { text })
    textInput.value = ''
    setTimeout(refresh, 300)
  } catch (error) {
    statusEl.textContent = error.message
  }
})

document.querySelectorAll('[data-key]').forEach((button) => {
  button.addEventListener('click', async () => {
    try {
      await api('/key', { key: button.dataset.key })
      setTimeout(refresh, 300)
    } catch (error) {
      statusEl.textContent = error.message
    }
  })
})

document.querySelector('#navForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    await api('/navigate', { url: navInput.value })
    setTimeout(refresh, 800)
  } catch (error) {
    statusEl.textContent = error.message
  }
})

document.querySelector('#refresh').addEventListener('click', refresh)

document.querySelector('#capture').addEventListener('click', async () => {
  if (!confirm('note.com の Cookie を note-auto-poster に同期しますか？')) return
  try {
    statusEl.textContent = 'Cookie 同期中...'
    await api('/capture')
    statusEl.textContent = 'Cookie 同期が完了しました。このセッションは閉じられました。'
  } catch (error) {
    statusEl.textContent = error.message
  }
})

refresh()
setInterval(refresh, 3000)
