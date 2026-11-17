/* FoodHive ratings capture. The dashboard turns this file into a bookmarklet
   (Ratings page > Update ratings). Run it on a partner portal page that lists
   store ratings while signed in. It reads the ratings, shows what it found,
   and copies JSON to the clipboard for pasting into the dashboard. Nothing is
   sent anywhere from the portal tab.

   Per-portal extractors go in EXTRACTORS once each portal's ratings call is
   known; until then the generic table reader is used. Comments are stripped
   when the bookmarklet is built, so keep code lines free of // comments. */
(function () {
  var CHANNELS = [['talabat', 'Talabat'], ['deliveroo', 'Deliveroo'], ['careem', 'Careem'], ['keeta', 'Keeta 2.0'], ['noon', 'Noon']];
  var host = location.hostname.toLowerCase();
  var channel = null;
  for (var i = 0; i < CHANNELS.length; i++) if (host.indexOf(CHANNELS[i][0]) >= 0) { channel = CHANNELS[i][1]; break; }

  var EXTRACTORS = {};

  function num(s) { var m = String(s).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([kK])?/); if (!m) return null; var v = parseFloat(m[1]); return m[2] ? Math.round(v * 1000) : v; }

  /* Generic reader: table rows (or ARIA rows) with a text cell and a 1-5
     rating cell; a cell with a larger whole number is taken as the count. */
  function generic() {
    var out = [], seen = {};
    var rows = document.querySelectorAll('tr, [role="row"]');
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].querySelectorAll('td, th, [role="cell"], [role="gridcell"]');
      if (cells.length < 2) continue;
      var name = null, rating = null, count = null;
      for (var c = 0; c < cells.length; c++) {
        var t = (cells[c].innerText || '').trim();
        if (!t) continue;
        if (name == null && /[a-zA-Z]{3,}/.test(t) && t.length < 80) { name = t.split('\n')[0]; continue; }
        if (rating == null && /^[1-5](\.\d{1,2})?\s*(★|\/\s*5)?$/.test(t)) { rating = parseFloat(t); continue; }
        if (rating != null && count == null) { var n = num(t); if (n != null && n >= 1 && Math.floor(n) === n) count = n; }
      }
      if (name && rating != null && !seen[name]) { seen[name] = 1; out.push({ store: name, rating: rating, count: count }); }
    }
    return out;
  }

  function show(payload, note) {
    var json = JSON.stringify(payload);
    var box = document.createElement('div');
    box.setAttribute('style', 'position:fixed;z-index:2147483647;top:16px;right:16px;width:380px;max-height:80vh;overflow:auto;background:#fff;color:#1d1d1d;border:3px solid #FDCB3C;border-radius:8px;padding:12px;font:13px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.25)');
    var list = payload.rows.slice(0, 40).map(function (r) { return '<tr><td>' + String(r.store).replace(/</g, '&lt;') + '</td><td style="text-align:right">' + r.rating + '</td><td style="text-align:right">' + (r.count == null ? '' : r.count) + '</td></tr>'; }).join('');
    box.innerHTML = '<b>FoodHive ratings: ' + (payload.channel || 'unknown aggregator') + '</b><div style="margin:6px 0">' + note + '</div>' +
      (payload.rows.length ? '<table style="width:100%;border-collapse:collapse;font-size:12px">' + list + '</table>' : '') +
      '<textarea style="width:100%;height:70px;margin-top:6px;font:11px monospace"></textarea>' +
      '<button style="margin-top:6px;padding:4px 10px;background:#1d1d1d;color:#FDCB3C;border:0;border-radius:4px;cursor:pointer">Close</button>';
    box.querySelector('textarea').value = json;
    box.querySelector('button').onclick = function () { box.remove(); };
    document.body.appendChild(box);
    var ta = box.querySelector('textarea');
    function fallback() { ta.select(); try { document.execCommand('copy'); } catch (e) {} }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(json).catch(fallback); else fallback();
  }

  Promise.resolve()
    .then(function () { return channel && EXTRACTORS[channel] ? EXTRACTORS[channel]() : generic(); })
    .then(function (rows) {
      rows = (rows || []).filter(function (r) { return r && r.store && r.rating >= 1 && r.rating <= 5; });
      var payload = { channel: channel, capturedAt: Date.now(), rows: rows };
      var note = rows.length
        ? 'Found ' + rows.length + ' store ratings and copied them. Check them against the page, then paste into the dashboard (Ratings &gt; Update ratings).'
        : 'No store ratings found on this page. Open the page that lists each store\'s rating, or enter them by hand in the dashboard.';
      show(payload, note);
    })
    .catch(function (e) { show({ channel: channel, rows: [] }, 'Capture failed: ' + e.message); });
})();
