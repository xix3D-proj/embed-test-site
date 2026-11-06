/*
 * Render debug sidebar for the test sites. It sits on the PAGE, not in the widget: it wraps fetch,
 * reads each render's event stream (and the open-time calls) and draws them in a right-hand panel.
 * The server no longer sends debug data, so everything here comes from the events and timings
 * the browser itself sees. Nothing is sent anywhere. Load it BEFORE widget.js.
 */
(function () {
  if (window.__xwDebug) return
  window.__xwDebug = true

  // ?reset in the address forgets this device, so the per-device render limit starts again (test pages only).
  try {
    if (/[?&]reset(&|=|$)/.test(location.search)) {
      localStorage.removeItem('xix3d:visitor_id')
      history.replaceState(null, '', location.pathname + location.search.replace(/([?&])reset(=[^&]*)?&?/, '$1').replace(/[?&]$/, '') + location.hash)
    }
  } catch (e) {}

  var KEY = 'xwdbg:open'
  var rows = []        // renders, newest first
  var calls = []       // open-time calls (validate, decode, catalogue, open check, finishes)
  var open = false
  try { open = localStorage.getItem(KEY) === '1' } catch (e) {}

  function now() { return performance.now() }
  function fmt(ms) { return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s' }
  function short(s) { return s ? String(s).slice(0, 8) : 'none' }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;') }

  // ---------- the panel ----------
  var css = document.createElement('style')
  css.textContent =
    '#xwdbg{position:fixed;top:0;right:0;height:100vh;width:420px;max-width:92vw;z-index:2147483647;background:#0d0e12;color:#d7dae2;font:12px/1.45 Consolas,Menlo,monospace;border-left:1px solid #2a2c35;transform:translateX(100%);transition:transform .18s ease;display:flex;flex-direction:column}' +
    '#xwdbg.open{transform:none}' +
    '#xwdbg-tab{position:fixed;top:50%;right:0;z-index:2147483647;transform:translateY(-50%);background:#0d0e12;color:#d7dae2;border:1px solid #2a2c35;border-right:0;border-radius:10px 0 0 10px;padding:12px 8px;font:600 11px Arial,sans-serif;letter-spacing:.08em;cursor:pointer;writing-mode:vertical-rl}' +
    '#xwdbg.open ~ #xwdbg-tab{display:none}' +
    '#xwdbg header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #2a2c35;font:600 13px Arial,sans-serif}' +
    '#xwdbg header button{background:#1b1d25;color:#d7dae2;border:1px solid #333646;border-radius:6px;padding:4px 10px;cursor:pointer;margin-left:6px;font:12px Arial,sans-serif}' +
    '#xwdbg .body{overflow:auto;padding:10px 12px;flex:1}' +
    '#xwdbg h4{margin:14px 0 6px;font:600 11px Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#8b91a1}' +
    '#xwdbg .card{border:1px solid #2a2c35;border-radius:8px;padding:8px 10px;margin-bottom:10px;background:#12141a}' +
    '#xwdbg .row{display:flex;justify-content:space-between;gap:10px}' +
    '#xwdbg .k{color:#8b91a1}' +
    '#xwdbg .hit{color:#4ade80;font-weight:700}' +
    '#xwdbg .miss{color:#fbbf24;font-weight:700}' +
    '#xwdbg .bad{color:#f87171}' +
    '#xwdbg .ok{color:#4ade80}' +
    '#xwdbg .log{margin-top:6px;border-top:1px solid #23252e;padding-top:6px}' +
    '#xwdbg .log div{white-space:pre-wrap;word-break:break-word}' +
    '#xwdbg .t{color:#6b7280}' +
    '#xwdbg .sum{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:6px}' +
    '#xwdbg .sum b{font-size:15px}'
  document.head.appendChild(css)

  var panel = document.createElement('div')
  panel.id = 'xwdbg'
  var tab = document.createElement('button')
  tab.id = 'xwdbg-tab'
  tab.type = 'button'
  function mount() {
    document.body.appendChild(panel)
    document.body.appendChild(tab)
    tab.onclick = function () { setOpen(true) }
    draw()
  }
  function setOpen(v) {
    open = v
    try { localStorage.setItem(KEY, v ? '1' : '0') } catch (e) {}
    panel.className = open ? 'open' : ''
  }

  function hitCount() {
    var h = 0, n = 0
    rows.forEach(function (r) { if (r.cached !== null) { n++; if (r.cached) h++ } })
    return { h: h, n: n }
  }

  function draw() {
    var hc = hitCount()
    tab.textContent = 'DEBUG' + (rows.length ? ' · ' + rows.length : '')
    var html = '<header><span>Render debug</span><span><button id="xwdbg-new" title="Forget this device so the per-device limit starts again (test sites only)">New device</button><button id="xwdbg-clear">Clear</button><button id="xwdbg-x">Close</button></span></header><div class="body">'

    html += '<h4>Mask reuse</h4><div class="card"><div class="sum"><div><b class="' + (hc.h ? 'hit' : 'k') + '">' + hc.h + '</b> reused</div><div><b>' + (hc.n - hc.h) + '</b> built fresh</div><div><b>' + rows.length + '</b> renders</div></div>' +
      '<div class="k">Hit the render limit (5 per device)? Press New device above: this page forgets you and the count starts again. It only affects these test pages.</div>' + '<div class="k">A reused mask skips the first image call, so that render costs one image call instead of two.</div></div>'

    html += '<h4>Renders</h4>'
    if (!rows.length) html += '<div class="k">No render yet. Run one and it appears here.</div>'
    rows.forEach(function (r) {
      var cache = r.cached === null ? '<span class="k">not reported yet</span>' : r.cached ? '<span class="hit">HIT, pass 1 skipped</span>' : '<span class="miss">miss, full two-pass</span>'
      var st = r.status ? '<span class="' + (r.status < 400 ? 'ok' : 'bad') + '">' + r.status + '</span>' : '<span class="k">waiting</span>'
      html += '<div class="card"><div class="row"><b>' + esc(r.label) + '</b><span>' + (r.total != null ? fmt(r.total) : 'running...') + '</span></div>' +
        '<div class="row"><span class="k">mask</span><span>' + cache + '</span></div>' +
        '<div class="row"><span class="k">http</span><span>' + st + '</span></div>' +
        '<div class="row"><span class="k">session</span><span>' + esc(short(r.session)) + '</span></div>' +
        '<div class="row"><span class="k">device</span><span>' + esc(short(r.visitor)) + '</span></div>' +
        (r.xcache ? '<div class="row"><span class="k">x-cache</span><span>' + esc(r.xcache) + '</span></div>' : '') +
        (r.serverMs ? '<div class="row"><span class="k">server render</span><span>' + esc(r.serverMs) + ' ms</span></div>' : '') +
        '<div class="log">' + r.log.map(function (l) { return '<div><span class="t">+' + (l.t / 1000).toFixed(1) + 's</span> ' + l.html + '</div>' }).join('') + '</div></div>'
    })

    html += '<h4>Opening the window</h4><div class="card">'
    if (!calls.length) html += '<div class="k">Nothing yet.</div>'
    calls.forEach(function (c) {
      html += '<div class="row"><span>' + esc(c.name) + '</span><span><span class="' + (c.status < 400 ? 'ok' : 'bad') + '">' + c.status + '</span> ' + fmt(c.ms) + (c.bytes ? ' · ' + (c.bytes / 1024 > 1024 ? (c.bytes / 1048576).toFixed(1) + ' MB' : Math.round(c.bytes / 1024) + ' KB') : '') + '</span></div>'
    })
    html += '</div></div>'
    panel.innerHTML = html
    panel.className = open ? 'open' : ''
    var cl = panel.querySelector('#xwdbg-clear'), x = panel.querySelector('#xwdbg-x')
    var nd = panel.querySelector('#xwdbg-new')
    if (nd) nd.onclick = function () { try { localStorage.removeItem('xix3d:visitor_id') } catch (e) {} location.reload() }
    if (cl) cl.onclick = function () { rows = []; calls = []; draw() }
    if (x) x.onclick = function () { setOpen(false) }
  }

  var pending = false
  function redraw() { if (pending) return; pending = true; setTimeout(function () { pending = false; draw() }, 120) }

  // ---------- fetch wrapper ----------
  function hdr(init, input, name) {
    var h = (init && init.headers) || (input && input.headers)
    if (!h) return null
    if (typeof h.get === 'function') return h.get(name)
    var low = name.toLowerCase()
    for (var k in h) if (k.toLowerCase() === low) return h[k]
    return null
  }

  function brief(data) {
    var o = {}
    for (var k in data) {
      var v = data[k]
      if (typeof v === 'string' && v.length > 60) v = v.slice(0, 20) + '...(' + v.length + ' chars)'
      if (v && typeof v === 'object') v = JSON.stringify(v).slice(0, 80)
      o[k] = v
    }
    return JSON.stringify(o)
  }

  function onEvent(row, name, data) {
    var t = now() - row.t0
    var html
    if (name === 'started') html = 'started'
    else if (name === 'vehicle_detected') html = 'vehicle: ' + esc([data.year, data.make, data.model].filter(Boolean).join(' ') || 'not recognised')
    else if (name === 'mask_started') {
      row.cached = !!data.cached
      html = data.cached ? '<span class="hit">mask: REUSED, pass 1 skipped</span>' : '<span class="miss">mask: NOT reused, full two-pass</span>'
    } else if (name === 'mask_complete') {
      if (data.cached != null) row.cached = !!data.cached
      html = 'mask done' + (data.gate_passed === false ? ' <span class="bad">(gate failed)</span>' : '') + ' ' + esc(brief(data))
    } else if (name === 'fill_started') html = 'fill: pass 2 started'
    else if (name === 'composite_complete') html = 'composite ' + esc(brief(data))
    else if (name === 'complete') { html = '<span class="ok">complete, image received</span>'; row.total = t }
    else if (name === 'recorded') html = 'recorded'
    else if (name === 'error') { html = '<span class="bad">error: ' + esc(brief(data)) + '</span>'; row.total = t }
    else html = esc(name) + ' ' + esc(brief(data))
    row.log.push({ t: t, html: html })
    redraw()
  }

  function readStream(row, res) {
    var reader
    try { reader = res.clone().body.getReader() } catch (e) { return }
    var dec = new TextDecoder(), buf = ''
    function pump() {
      reader.read().then(function (r) {
        if (r.done) { if (row.total == null) row.total = now() - row.t0; redraw(); return }
        buf += dec.decode(r.value, { stream: true })
        var parts = buf.split(/\r?\n\r?\n/)
        buf = parts.pop()
        parts.forEach(function (blk) {
          var ev = 'message', data = ''
          blk.split(/\r?\n/).forEach(function (line) {
            if (line.indexOf('event:') === 0) ev = line.slice(6).trim()
            else if (line.indexOf('data:') === 0) data += line.slice(5).trim()
          })
          var parsed = {}
          try { parsed = data ? JSON.parse(data) : {} } catch (e) { parsed = { raw: data.slice(0, 80) } }
          onEvent(row, ev, parsed)
        })
        pump()
      }, function () { row.total = row.total == null ? now() - row.t0 : row.total; redraw() })
    }
    pump()
  }

  var orig = window.fetch
  var count = 0
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || ''
    if (!/\/api\/v1\//.test(url)) return orig.apply(this, arguments)
    var method = (init && init.method) || (input && input.method) || 'GET'
    var start = now()
    var row = null
    if (/\/render\/v2\/chain\/stream/.test(url) && method === 'POST') {
      count++
      row = { label: 'Render ' + count, t0: start, status: 0, cached: null, session: hdr(init, input, 'X-Session-ID'), visitor: hdr(init, input, 'X-Visitor-ID'), log: [], total: null, xcache: null, serverMs: null }
      rows.unshift(row)
      if (rows.length > 20) rows.pop()
      redraw()
    }
    var name = url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '').replace('/api/v1', '')
    return orig.apply(this, arguments).then(function (res) {
      var ms = now() - start
      if (row) {
        row.status = res.status
        row.xcache = res.headers.get('x-cache')
        row.serverMs = res.headers.get('x-render-time-ms')
        if (res.status >= 400) {
          res.clone().text().then(function (t) { row.log.push({ t: now() - row.t0, html: '<span class="bad">' + res.status + ' ' + esc(t.slice(0, 160)) + '</span>' }); row.total = now() - row.t0; redraw() })
        } else readStream(row, res)
      } else if (method !== 'OPTIONS') {
        var c = { name: method + ' ' + name, status: res.status, ms: ms, bytes: 0 }
        calls.push(c)
        if (calls.length > 40) calls.shift()
        if (/\/embed\/catalogue/.test(url)) {
          res.clone().arrayBuffer().then(function (b) { c.bytes = b.byteLength; c.ms = now() - start; redraw() })
        }
      }
      redraw()
      return res
    }, function (err) {
      if (row) { row.log.push({ t: now() - row.t0, html: '<span class="bad">network error</span>' }); row.total = now() - row.t0; redraw() }
      throw err
    })
  }

  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount)
})()
