const { spawn } = require('child_process');
const fs = require('fs');

async function main() {
  const p = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--remote-debugging-port=9457', '--user-data-dir=/tmp/audit-clean', 'http://localhost:3000'
  ]);
  await new Promise(r => setTimeout(r, 1500));

  try {
    const list = await (await fetch('http://127.0.0.1:9457/json/list')).json();
    const pageTarget = list.find(x => x.type === 'page');
    if (!pageTarget) throw new Error('No page target found');

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    let id = 1;
    const send = (method, params = {}) => new Promise((res, rej) => {
      const mid = id++;
      const handler = (e) => {
        const m = JSON.parse(e.data);
        if (m.id === mid) {
          ws.removeEventListener('message', handler);
          if (m.error) rej(m.error);
          else if (m.result && m.result.exceptionDetails) {
            console.error('CDP eval exception:', m.result.exceptionDetails);
            rej(m.result.exceptionDetails);
          } else if (m.result && m.result.result && 'value' in m.result.result) {
            res(m.result.result.value);
          } else {
            res(m.result);
          }
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

    const consoleLogs = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled') {
        consoleLogs.push({ type: m.params.type, text: m.params.args.map(a => typeof a.value === 'object' ? JSON.stringify(a.value) : a.value).join(' ') });
      } else if (m.method === 'Runtime.exceptionThrown') {
        consoleLogs.push({ type: 'error', text: m.params.exceptionDetails.text, err: m.params.exceptionDetails.exception?.description });
      }
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

    // Wait 3 seconds for initial load
    await new Promise(r => setTimeout(r, 3000));

    const pages = ['sales', 'cancel', 'prep', 'ratings', 'items', 'delayed'];
    const auditResults = {};

    for (const page of pages) {
      console.log(`Auditing page: ${page}...`);
      // Click nav tab to activate page
      await send('Runtime.evaluate', {
        expression: `
          (() => {
            const a = document.querySelector('#nav a[data-page="${page}"]');
            if (a) a.click();
          })();
        `
      });
      // Wait for layout and render
      await new Promise(r => setTimeout(r, 1000));

      // Extract DOM details for this page
      const details = await send('Runtime.evaluate', {
        expression: `
          (() => {
            const pageEl = document.getElementById('page-${page}');
            if (!pageEl) return { error: 'Page element not found' };

            const kpis = Array.from(pageEl.querySelectorAll('.kpi, .kpi-card')).map(el => {
              const h = el.querySelector('.kh, .kpi-title, .kpi-label')?.textContent?.trim() || '';
              const v = el.querySelector('.kv, .kpi-value, .kpi-val')?.textContent?.trim() || '';
              return { title: h, value: v };
            });

            const canvases = Array.from(pageEl.querySelectorAll('canvas')).map(c => {
              const r = c.getBoundingClientRect();
              return {
                id: c.id,
                w: Math.round(r.width),
                h: Math.round(r.height),
                visible: r.width > 0 && r.height > 0
              };
            });

            const tables = Array.from(pageEl.querySelectorAll('table')).map(t => {
              const r = t.getBoundingClientRect();
              return {
                id: t.id,
                rows: t.querySelectorAll('tr').length,
                w: Math.round(r.width),
                h: Math.round(r.height),
                visible: r.width > 0 && r.height > 0
              };
            });

            return {
              page: '${page}',
              display: window.getComputedStyle(pageEl).display,
              kpiCount: kpis.length,
              kpis,
              canvasCount: canvases.length,
              canvases,
              tables
            };
          })()
        `,
        returnByValue: true
      });

      auditResults[page] = details;

      // Capture high-res screenshot
      const ss = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(`shots/audit_${page}.png`, Buffer.from(ss.data, 'base64'));
    }

    console.log('\n--- BROWSER CONSOLE LOGS ---');
    console.log(JSON.stringify(consoleLogs, null, 2));

    console.log('\n--- COMPREHENSIVE AUDIT RESULTS ---');
    console.log(JSON.stringify(auditResults, null, 2));

  } catch (err) {
    console.error('Fatal audit error:', err);
  } finally {
    p.kill();
  }
}

main();
