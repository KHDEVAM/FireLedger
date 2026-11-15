// Click-through test of the FireLedger UI with real mouse and keyboard events (Chrome DevTools protocol).
// No dependencies: needs Node 22+ and a local Chrome or Edge.
//
//   npm run dev                      (in another terminal)
//   node scripts/e2e-flow.mjs        [url] [screenshot folder]
//
// CHROME_PATH overrides the browser; the default URL uses ?demo=1 (simulated live hotspots).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://localhost:5173/?demo=1';
const outDir = process.argv[3] ?? tmpdir();
const port = 9400 + Math.floor(Math.random() * 400);
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = process.env.CDP_PROFILE ?? mkdtempSync(join(tmpdir(), 'fireledger-e2e-'));
const chrome = spawn(chromePath, [
  '--headless=new', `--remote-debugging-port=${port}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars',
  `--user-data-dir=${profile}`, '--window-size=1440,1000', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result ?? d.error); pending.delete(d.id); }
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') logs.push('console.error: ' + d.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
  if (d.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).slice(0, 400));
};
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r.result?.value ?? r.exceptionDetails?.exception?.description;
};
const click = async (x, y, count = 1) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: count });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: count });
  await sleep(400);
};
const key = async (k) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: k === 'Enter' ? 13 : 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: k === 'Enter' ? 13 : 27 });
  await sleep(400);
};
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${outDir}/${name}`, Buffer.from(s.data, 'base64'));
};
const results = [];
const check = (name, ok, detail) => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(detail ?? '').slice(0, 170)}`); };
const summary = () => ev("document.querySelector('#aoi-summary').textContent");

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
// wait for the app and the basemap
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  if (await ev("!!document.querySelector('#calendar svg') && !!document.querySelector('#map canvas') && document.querySelectorAll('#admin option').length > 1")) break;
}
await sleep(6000);
check('app loaded', await ev("!!document.querySelector('#calendar svg')"), await summary());
// one calendar row per year of the record
const nYears = await ev("document.querySelectorAll('#calendar [role=row]').length");

// 1. region list
const regionName = await ev("(() => { const s = document.querySelector('#admin'); s.selectedIndex = 12; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()");
await sleep(2500);
let text = await summary();
check('region list selects an admin region', text.startsWith(regionName), text);
const cellsRegion = await ev("document.querySelectorAll('#calendar [data-pos]').length");
check('calendar redrawn for the region', cellsRegion === nYears * 12, cellsRegion + ' cells');

// 2. pin as A, then draw a rectangle with the mouse
await ev("document.querySelector('#cmp-pin').click()");
await ev("document.querySelector('#draw-clear').click()");
await sleep(3000);
await ev("document.querySelector('#draw-rect').click()");
await sleep(600);
const box = await ev("(() => { const r = document.querySelector('#map').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()");
console.log('map box', box.map(Math.round).join(','), 'column scroll', await ev("document.querySelector('.col-map').scrollTop"));
const at = (fx, fy) => [box[0] + box[2] * fx, box[1] + box[3] * fy];
check('draw hint shown', (await ev("document.querySelector('#draw-hint').textContent")).length > 10, await ev("document.querySelector('#draw-hint').textContent"));
await click(...at(0.55, 0.12));
await click(...at(0.80, 0.32));
await sleep(2500);
text = await summary();
check('rectangle drawn with the mouse', /^Rectangle/.test(text), text);
check('rectangle is in the URL', (await ev('location.search')).includes('aoi=bbox'), await ev('location.search'));
const cmp = await ev("document.querySelector('#cmp-body').innerText");
check('comparison table and chart appear', /Peak month/.test(cmp) && (await ev("!!document.querySelector('#cmp-chart svg')")), cmp.replace(/\s+/g, ' '));
await ev("document.querySelector('#h-cmp').scrollIntoView()");
await sleep(500);
await shot('flow_compare.png');
await ev('window.scrollTo(0, 0)');
await sleep(500);

// 3. polygon: three clicks then Enter
await ev("document.querySelector('#draw-poly').click()");
await click(...at(0.55, 0.15));
await click(...at(0.78, 0.18));
await click(...at(0.66, 0.36));
await key('Enter');
await sleep(2500);
text = await summary();
check('polygon drawn with mouse + Enter', /polygon \(3 corners\)/.test(text), text);

// 4. Escape cancels a drawing
await ev("document.querySelector('#draw-rect').click()");
await click(...at(0.3, 0.3));
await key('Escape');
check('Escape cancels drawing', (await ev("document.querySelector('#draw-hint').textContent")) === 'Drawing cancelled.' && /polygon/.test(await summary()), await ev("document.querySelector('#draw-hint').textContent"));

// 5. coordinates: circle and invalid input
await ev("(() => { document.querySelector('details.coords').open = true; document.querySelector('#c-lat').value = '35.17'; document.querySelector('#c-lon').value = '-5.27'; document.querySelector('#c-km').value = '30'; document.querySelector('#circle-form').requestSubmit(); })()");
await sleep(2500);
text = await summary();
check('lat/lon + radius', /^30 km around 35\.17, -5\.27/.test(text), text);
await ev("(() => { document.querySelector('#bbox').value = '5,0,1,10'; document.querySelector('#bbox-form').requestSubmit(); })()");
check('invalid bbox is rejected with a message', /not valid/.test(await ev("document.querySelector('#draw-hint').textContent")) && /^30 km/.test(await summary()), await ev("document.querySelector('#draw-hint').textContent"));

// 6. place search (OpenStreetMap Nominatim)
await ev("(() => { document.querySelector('#place').value = 'Ifrane'; document.querySelector('#place-form').requestSubmit(); })()");
let found = 0;
for (let i = 0; i < 20 && !found; i++) { await sleep(1000); found = await ev("document.querySelectorAll('#place-results button').length"); }
check('place search returns results', found > 0, found + ' results: ' + (await ev("document.querySelector('#place-results').innerText")).split('\n')[0]);
if (found) {
  await ev("document.querySelector('#place-results button').click()");
  await sleep(2500);
  text = await summary();
  check('choosing a result sets the area', !/^30 km around 35\.17/.test(text), text);
}

// 7. watch zone: save, automatic check, export, reload persistence
await ev("(() => { document.querySelector('#wz-name').value = 'Test zone'; document.querySelector('#wz-form').requestSubmit(); })()");
await ev("document.querySelector('#wz-check').click()");
await sleep(4000);
const zone = await ev("document.querySelector('#wz-list').innerText");
check('watch zone saved and checked', /Test zone/.test(zone) && /SIMULATED/.test(zone) && /hotspots detected by satellite|No hotspots detected/.test(zone), zone.replace(/\s+/g, ' '));
check('watch zone persists in the browser', (await ev("JSON.parse(localStorage.getItem('fl-zones')).length")) === 1, await ev("localStorage.getItem('fl-zones')"));

// 8. toggles
await ev("document.querySelector('#static').click()");
await sleep(800);
const withStatic = await ev("document.querySelector('#now-value').textContent");
await ev("document.querySelector('#static').click()");
await ev("document.querySelector('input[name=view][value=table]').click()");
check('table view renders', await ev("document.querySelectorAll('#calendar table tbody tr').length") === nYears, 'rows=' + (await ev("document.querySelectorAll('#calendar table tbody tr').length")) + ' static value=' + withStatic);
await ev("document.querySelector('input[name=view][value=grid]').click()");

// 9. keyboard navigation of the calendar
await ev("(() => { const c = document.querySelector('#calendar [tabindex=\"0\"]'); c.focus(); })()");
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
await sleep(300);
check('arrow keys move through the calendar', (await ev("document.activeElement.getAttribute('data-pos')")) === `${nYears - 1}-1` && !(await ev("document.querySelector('#tooltip').hidden")), await ev("document.querySelector('#tooltip').innerText"));

// 10. time-lapse
await ev("document.querySelector('#tl-play').click()");
await sleep(1500);
const tl = await ev("document.querySelector('#tl-label').textContent");
await ev("document.querySelector('#tl-play').click()");
check('time-lapse plays and stops', tl.length > 3 && (await ev("document.querySelector('#tl-label').textContent")) === '', tl);

await ev("document.querySelector('#h-wz').scrollIntoView()");
await sleep(500);
await shot('flow_zones.png');
console.log(results.join('\n'));
console.log([...new Set(logs)].slice(0, 10).join('\n') || 'no console errors');
ws.close(); chrome.kill();
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
