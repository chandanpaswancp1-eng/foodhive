/* FoodHive Atlas capture. The dashboard turns this file into a bookmarklet
   (Data Sources > Update from Atlas). Run it on any atlas.urbanpiper.com page
   while signed in. It calls the GraphQL queries the Atlas pages use, with the
   Atlas session already in this tab, and copies JSON to the clipboard for
   pasting into the dashboard. Nothing is sent anywhere except to Atlas.

   Orders: the list query (ordersV2) for a date range, then each order's
   detail (order) for discount, items and status times. Customer names and
   phone numbers are never copied; a test customer only sets test: true.
   Catalogue: every item (items), 100 per page.
   Connect dashboard: opens the dashboard (DASH, filled in when the
   dashboard builds the bookmarklet) and hands it this tab's Atlas session by
   postMessage, so Sync Now can pull Jaddaf until Atlas ends the session
   (about 7 days). The
   session goes only to that exact origin, never into a URL.

   Comments are stripped when the bookmarklet is built, so keep code lines
   free of // comments. */
(function () {
  var DASH = '__FH_DASHBOARD__';
  var API = 'https://atlas-backend.svc.urbanpiper.com/graphql';
  var Q_LIST = 'query($limit:Int,$sort:SortInput,$filters:[ListFilterArgument],$brand:String,$cursor:String){ordersV2(limit:$limit,sort:$sort,filters:$filters,brand:$brand,cursor:$cursor){hasNext nextCursor objects{id created channel status store{title brand{name}}}}}';
  var Q_ORDER = 'query($id:Int){order(id:$id){id type created status channel paymentMode subtotal discount totalCharges totalTaxes payableAmount customer{fullName} store{title brand{name}} statusUpdates{status created message} items{id title price quantity total discount}}}';
  var Q_ITEMS = 'query($limit:Int,$offset:Int,$filters:[ListFilterArgument],$brand:String){items(limit:$limit,offset:$offset,filters:$filters,brand:$brand){count objects{id itemTitle itemPrice isEnabled merchantRefId category itemDiscreteCategory{name} brandsData{name}}}}';

  var old = document.getElementById('fh-atlas');
  if (old) old.remove();
  if (location.hostname.indexOf('urbanpiper.com') < 0) { alert('Open Atlas (atlas.urbanpiper.com) and sign in, then click this bookmark again.'); return; }

  function token() {
    try { return JSON.parse(localStorage.getItem('AT')).auth.token; } catch (e) { return null; }
  }
  function gql(query, variables) {
    var t = token();
    if (!t) return Promise.reject(new Error('Not signed in to Atlas. Sign in, then run the bookmark again.'));
    return fetch(API, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer ' + t }, body: JSON.stringify({ query: query, variables: variables }) })
      .then(function (r) { if (r.status === 401 || r.status === 403) throw new Error('Atlas session expired. Sign in again.'); return r.json(); })
      .then(function (j) { if (j.errors && j.errors.length) throw new Error(j.errors[0].message); return j.data; });
  }
  function ymd(d) { return new Date(d.getTime() + 4 * 3600e3).toISOString().slice(0, 10); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var box = document.createElement('div');
  box.id = 'fh-atlas';
  box.setAttribute('style', 'position:fixed;z-index:2147483647;top:16px;right:16px;width:380px;max-height:85vh;overflow:auto;background:#fff;color:#1d1d1d;border:3px solid #FDCB3C;border-radius:8px;padding:12px;font:13px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.25)');
  var btn = 'padding:5px 10px;background:#1d1d1d;color:#FDCB3C;border:0;border-radius:4px;cursor:pointer;margin:4px 4px 0 0';
  var today = new Date();
  box.innerHTML = '<b>FoodHive: capture from Atlas</b>' +
    '<div style="margin:8px 0 4px">Orders from <input type="date" id="fhA-from" value="' + ymd(new Date(today - 30 * 864e5)) + '"> to <input type="date" id="fhA-to" value="' + ymd(today) + '"></div>' +
    (DASH.indexOf('__') === 0 ? '' : '<div style="margin:4px 0 8px"><button id="fhA-connect" style="' + btn + ';background:#FDCB3C;color:#1d1d1d;font-weight:600">Connect dashboard</button><div style="font-size:11px;color:#555">Lets the dashboard sync Jaddaf by itself for about 7 days.</div></div><div style="font-size:11px;color:#555">Or capture by hand and paste:</div>') +
    '<button id="fhA-orders" style="' + btn + '">Capture orders</button><button id="fhA-cat" style="' + btn + '">Capture catalogue</button><button id="fhA-close" style="' + btn + ';background:#d9dfe1;color:#1d1d1d">Close</button>' +
    '<div id="fhA-msg" style="margin-top:8px"></div>';
  document.body.appendChild(box);
  var msg = box.querySelector('#fhA-msg');
  function say(html) { msg.innerHTML = html; }
  box.querySelector('#fhA-close').onclick = function () { box.remove(); };

  function done(payload, text) {
    var json = JSON.stringify(payload);
    say(esc(text) + '<textarea style="width:100%;height:70px;margin-top:6px;font:11px monospace"></textarea><div class="fhA-copied" style="margin-top:4px"></div>');
    var ta = msg.querySelector('textarea');
    ta.value = json;
    var note = msg.querySelector('.fhA-copied');
    function fallback() { ta.focus(); ta.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) {} note.textContent = ok ? 'Copied. Paste it into the dashboard: Data Sources > Update from Atlas.' : 'Select the text above, copy it, and paste it into the dashboard: Data Sources > Update from Atlas.'; }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(json).then(function () { note.textContent = 'Copied. Paste it into the dashboard: Data Sources > Update from Atlas.'; }, fallback); else fallback();
  }
  function fail(e) { say('<span style="color:#c0392b">Capture failed: ' + esc(e.message || e) + '</span>'); }

  var connectBtn = box.querySelector('#fhA-connect');
  if (connectBtn) connectBtn.onclick = function () {
    var t = token();
    if (!t) return say('<span style="color:#c0392b">Not signed in to Atlas. Sign in, then run the bookmark again.</span>');
    var w = window.open(DASH + '/?atlas-connect=1', 'fh-dashboard');
    if (!w) return say('<span style="color:#c0392b">The browser blocked the dashboard window. Allow pop-ups for Atlas and try again.</span>');
    say('Connecting to the dashboard…');
    var finished = false;
    var timer = setTimeout(function () { if (!finished) { finished = true; window.removeEventListener('message', onMsg); say('<span style="color:#c0392b">The dashboard did not answer. Check it opened at ' + esc(DASH) + ' and try again.</span>'); } }, 30000);
    function onMsg(e) {
      if (e.origin !== DASH || !e.data || finished) return;
      if (e.data.type === 'fh-atlas-ready') { w.postMessage({ type: 'fh-atlas-token', token: t }, DASH); return; }
      if (e.data.type === 'fh-atlas-connected') {
        finished = true; clearTimeout(timer); window.removeEventListener('message', onMsg);
        say(e.data.ok ? '<b style="color:#1e8e3e">Connected.</b> The dashboard now syncs Jaddaf with Motor City until ' + esc(new Date(e.data.useUntil).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) + '. Data Sources reminds you a day before it ends.' : '<span style="color:#c0392b">Not connected: ' + esc(e.data.error || 'unknown error') + '</span>');
      }
    }
    window.addEventListener('message', onMsg);
  };

  box.querySelector('#fhA-orders').onclick = function () {
    var from = box.querySelector('#fhA-from').value, to = box.querySelector('#fhA-to').value;
    if (!from || !to || from > to) return say('Pick a valid date range.');
    var ids = [], cursor = null, pages = 0;
    function page() {
      say('Listing orders… ' + ids.length);
      return gql(Q_LIST, { limit: 100, sort: { field: 'id', order: 'DESC' }, filters: [{ field: 'created', value: from + ',' + to }], brand: 'all', cursor: cursor }).then(function (d) {
        var l = d.ordersV2;
        l.objects.forEach(function (o) { ids.push(o.id); });
        pages++;
        if (l.hasNext && l.nextCursor && pages < 200) { cursor = l.nextCursor; return page(); }
      });
    }
    var orders = [];
    function details() {
      var i = 0;
      function worker() {
        if (i >= ids.length) return Promise.resolve();
        var id = ids[i++];
        return gql(Q_ORDER, { id: +id }).then(function (d) {
          var o = d.order;
          if (o) {
            var name = (o.customer && o.customer.fullName) || '';
            orders.push({ id: o.id, created: o.created, channel: o.channel, type: o.type, brand: o.store && o.store.brand ? o.store.brand.name : null, store: o.store ? o.store.title : null,
              paymentMode: o.paymentMode, status: o.status, subtotal: o.subtotal, discount: o.discount, totalCharges: o.totalCharges, totalTaxes: o.totalTaxes, payableAmount: o.payableAmount,
              test: /test\s*order/i.test(name), statusUpdates: (o.statusUpdates || []).map(function (s) { return { status: s.status, created: s.created, message: s.message }; }),
              items: (o.items || []).map(function (t) { return { id: t.id, title: t.title, price: t.price, quantity: t.quantity, total: t.total, discount: t.discount }; }) });
          }
          say('Reading order details… ' + orders.length + ' of ' + ids.length);
          return worker();
        });
      }
      return Promise.all([worker(), worker(), worker(), worker()]);
    }
    page().then(details).then(function () {
      orders.sort(function (a, b) { return a.id - b.id; });
      var tests = orders.filter(function (o) { return o.test || (o.statusUpdates || []).some(function (s) { return /test[_ ]?order|remarks:\s*test\b/i.test(s.message || ''); }); }).length;
      done({ kind: 'orders', capturedAt: Date.now(), from: from, to: to, orders: orders }, 'Captured ' + orders.length + ' orders from ' + from + ' to ' + to + (tests ? ' (' + tests + ' test orders, skipped by the dashboard)' : '') + '.');
    }).catch(fail);
  };

  box.querySelector('#fhA-cat').onclick = function () {
    var items = [], offset = 0, total = null;
    function page() {
      say('Reading catalogue… ' + items.length + (total ? ' of ' + total : ''));
      return gql(Q_ITEMS, { limit: 100, offset: offset, filters: [], brand: 'all' }).then(function (d) {
        var l = d.items;
        total = l.count;
        l.objects.forEach(function (i) {
          items.push({ id: i.id, title: i.itemTitle, price: i.itemPrice, enabled: i.isEnabled !== false, category: (i.itemDiscreteCategory && i.itemDiscreteCategory.name) || i.category || null, ref: i.merchantRefId || null, brand: i.brandsData && i.brandsData[0] ? i.brandsData[0].name : null });
        });
        offset += l.objects.length;
        if (l.objects.length && offset < total && offset < 20000) return page();
      });
    }
    page().then(function () {
      var off = items.filter(function (i) { return !i.enabled; }).length;
      done({ kind: 'catalog', capturedAt: Date.now(), items: items }, 'Captured ' + items.length + ' catalogue items (' + off + ' switched off).');
    }).catch(fail);
  };
})();
