const { spawn } = require('child_process');

async function testInteractiveFlows() {
  const p = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--remote-debugging-port=9461', '--user-data-dir=/tmp/interactive-test-2', 'http://localhost:3000'
  ]);
  await new Promise(r => setTimeout(r, 1500));

  try {
    const list = await (await fetch('http://127.0.0.1:9461/json/list')).json();
    const pageTarget = list.find(x => x.type === 'page');
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

    const runtimeErrors = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') {
        runtimeErrors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
      }
    });

    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

    // Wait for boot
    await new Promise(r => setTimeout(r, 3000));

    console.log('--- 1. Testing Default Baseline on Sales Page ---');
    const baseline = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `
        (() => ({
          netSales: document.querySelector('#kpi-sales .kpi:nth-child(1) .kv')?.textContent,
          orders: document.querySelector('#kpi-sales .kpi:nth-child(3) .kv')?.textContent,
          aov: document.querySelector('#kpi-sales .kpi:nth-child(4) .kv')?.textContent,
          discountPct: document.querySelector('#kpi-sales .kpi:nth-child(6) .kv')?.textContent,
        }))()
      `
    });
    console.log('Baseline KPIs:', baseline);

    console.log('--- 2. Testing Brand Filter Selection (Manakeesh Corner Dine In) ---');
    const brandFilterResult = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `
        (() => {
          const brandSelect = document.querySelector('select[data-k="brand"]');
          if (!brandSelect) return { error: 'Brand selector not found' };
          brandSelect.value = 'Manakeesh Corner Dine In';
          brandSelect.dispatchEvent(new Event('change'));
          return {
            selectedBrand: brandSelect.value,
            netSales: document.querySelector('#kpi-sales .kpi:nth-child(1) .kv')?.textContent,
            orders: document.querySelector('#kpi-sales .kpi:nth-child(3) .kv')?.textContent,
            aov: document.querySelector('#kpi-sales .kpi:nth-child(4) .kv')?.textContent,
            discountPct: document.querySelector('#kpi-sales .kpi:nth-child(6) .kv')?.textContent,
          };
        })()
      `
    });
    console.log('Brand Filter KPIs:', brandFilterResult);

    console.log('--- 3. Testing Reset to All ---');
    const resetResult = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `
        (() => {
          document.querySelector('#btnAll').click();
          return {
            netSales: document.querySelector('#kpi-sales .kpi:nth-child(1) .kv')?.textContent,
            orders: document.querySelector('#kpi-sales .kpi:nth-child(3) .kv')?.textContent,
            aov: document.querySelector('#kpi-sales .kpi:nth-child(4) .kv')?.textContent,
          };
        })()
      `
    });
    console.log('After Reset KPIs:', resetResult);

    console.log('--- 4. Testing Date Range Inputs (#fFrom, #fTo) ---');
    const dateSliderResult = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `
        (() => {
          const inFrom = document.querySelector('#fFrom');
          const inTo = document.querySelector('#fTo');
          if (!inFrom || !inTo) return { error: 'Date inputs not found' };
          inFrom.value = '2026-03-01';
          inFrom.dispatchEvent(new Event('change'));
          inTo.value = '2026-03-15';
          inTo.dispatchEvent(new Event('change'));
          return {
            fromVal: inFrom.value,
            toVal: inTo.value,
            netSales: document.querySelector('#kpi-sales .kpi:nth-child(1) .kv')?.textContent,
            orders: document.querySelector('#kpi-sales .kpi:nth-child(3) .kv')?.textContent,
          };
        })()
      `
    });
    console.log('Date Range Filter KPIs:', dateSliderResult);

    console.log('--- 5. Resetting again ---');
    await send('Runtime.evaluate', { expression: `document.querySelector('#btnAll').click()` });

    console.log('--- 6. Testing Prior Day Button (#btnPrev) ---');
    const prevDayResult = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `
        (() => {
          document.querySelector('#btnPrev').click();
          const inFrom = document.querySelector('#in-from-sales');
          const inTo = document.querySelector('#in-to-sales');
          return {
            fromVal: inFrom?.value,
            toVal: inTo?.value,
            netSales: document.querySelector('#kpi-sales .kpi:nth-child(1) .kv')?.textContent,
            orders: document.querySelector('#kpi-sales .kpi:nth-child(3) .kv')?.textContent,
          };
        })()
      `
    });
    console.log('Prior Day Result:', prevDayResult);

    console.log('--- 7. Resetting to full range ---');
    await send('Runtime.evaluate', { expression: `document.querySelector('#btnAll').click()` });

    console.log('--- 8. Testing Cancellations Page Metric Toggle (Orders Value vs Cancelled Orders) ---');
    await send('Runtime.evaluate', { expression: `document.querySelector('#nav a[data-page="cancel"]').click()` });
    await new Promise(r => setTimeout(r, 600));

    const cancelToggleResult = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `
        (() => {
          const btns = Array.from(document.querySelectorAll('#sideTogglesBottom button'));
          const btnOrders = btns.find(b => b.textContent.includes('Cancelled Orders'));
          if (btnOrders) btnOrders.click();
          return {
            activeToggles: Array.from(document.querySelectorAll('.side-toggles button.on')).map(b => b.textContent.trim()),
            kpis: Array.from(document.querySelectorAll('#kpi-cancel .kpi')).map(k => ({
              t: k.querySelector('.kh')?.textContent.trim(),
              v: k.querySelector('.kv')?.textContent.trim()
            }))
          };
        })()
      `
    });
    console.log('Cancel Page Toggle Result:', cancelToggleResult);

    console.log('--- 9. Testing Delayed Orders Page ---');
    await send('Runtime.evaluate', { expression: `document.querySelector('#nav a[data-page="delayed"]').click()` });
    await new Promise(r => setTimeout(r, 600));

    const delayedResult = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `
        (() => ({
          kpis: Array.from(document.querySelectorAll('#kpi-delayed .kpi')).map(k => ({
            t: k.querySelector('.kh')?.textContent.trim(),
            v: k.querySelector('.kv')?.textContent.trim()
          })),
          tableRows: document.querySelectorAll('#delayTable tr').length
        }))()
      `
    });
    console.log('Delayed Orders Result:', delayedResult);

    console.log('\n--- VERIFICATION OF RUNTIME ERRORS ---');
    console.log('Runtime exceptions encountered:', runtimeErrors.length === 0 ? 'NONE (100% clean)' : runtimeErrors);

  } catch (err) {
    console.error('Test error:', err);
  } finally {
    p.kill();
  }
}

testInteractiveFlows();
