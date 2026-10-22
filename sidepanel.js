const $ = (id) => document.getElementById(id);
const FIELDS = ['prompts', 'character', 'style', 'duration', 'aspect', 'count', 'model', 'maxInFlight', 'maxCredits', 'prefix', 'retries', 'downloadRetries', 'quality', 'confirmNever'];

function parsePrompts(text) {
  const t = text.replace(/\r/g, '');
  const parts = /^\s*---+\s*$/m.test(t) ? t.split(/^\s*---+\s*$/m) : t.split('\n');
  return parts.map((s) => s.trim()).filter(Boolean);
}

function readForm() {
  const cfg = {
    prompts: parsePrompts($('prompts').value),
    rawPrompts: $('prompts').value,
    character: $('character').value,
    style: $('style').value,
    duration: $('duration').value,
    aspect: $('aspect').value,
    count: $('count').value,
    model: $('model').value.trim(),
    maxInFlight: Math.max(1, parseInt($('maxInFlight').value, 10) || 2),
    maxCredits: Math.max(0, parseInt($('maxCredits').value, 10) || 0),
    prefix: ($('prefix').value || 'flow').replace(/[^\w-]+/g, '_'),
    retries: Math.max(1, parseInt($('retries').value, 10) || 2),
    quality: $('quality').value,
    downloadRetries: Math.max(1, parseInt($('downloadRetries').value, 10) || 3),
    confirmNever: $('confirmNever').checked
  };
  return cfg;
}

async function saveForm() {
  const cfg = readForm();
  await chrome.storage.local.set({ bg_cfg: cfg });
  $('promptCount').textContent = cfg.prompts.length + ' prompt' + (cfg.prompts.length === 1 ? '' : 's');
  return cfg;
}

async function loadForm() {
  const { bg_cfg } = await chrome.storage.local.get('bg_cfg');
  if (!bg_cfg) return;
  $('prompts').value = bg_cfg.rawPrompts || (bg_cfg.prompts || []).join('\n');
  for (const f of ['character', 'style', 'duration', 'aspect', 'count', 'model', 'maxInFlight', 'maxCredits', 'prefix', 'retries', 'downloadRetries', 'quality']) {
    if (bg_cfg[f] !== undefined) $(f).value = bg_cfg[f];
  }
  $('confirmNever').checked = !!bg_cfg.confirmNever;
}

const FLOW_URLS = ['https://flow.google.com/*', 'https://labs.google/fx/*'];

async function flowTab() {
  const cur = await chrome.tabs.query({ active: true, currentWindow: true });
  if (cur[0] && /^https:\/\/(flow\.google\.com|labs\.google\/fx)\//.test(cur[0].url || '')) return cur[0];
  const tabs = await chrome.tabs.query({ url: FLOW_URLS });
  return tabs.find((t) => t.active) || tabs[0] || null;
}

async function ping(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'bg-ping' });
    return !!(r && r.ok);
  } catch (e) { return false; }
}

async function ensureScript(tabId) {
  if (await ping(tabId)) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    return false;
  }
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await ping(tabId)) return true;
  }
  return false;
}

function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === 'complete') return setTimeout(resolve, 3500); // let the Flow app finish drawing
      } catch (e) { return resolve(); }
      if (Date.now() - t0 > timeoutMs) return resolve();
      setTimeout(tick, 500);
    };
    tick();
  });
}

// Finds the Flow tab and sends it to the project page if it is somewhere else (or opens it).
async function getFlowProjectTab() {
  const { bg_lastProject } = await chrome.storage.local.get('bg_lastProject');
  let tab = await flowTab();
  if (!tab) {
    if (!bg_lastProject) {
      await chrome.tabs.create({ url: 'https://flow.google.com/', active: true });
      alert('Opened Flow. Open your project once, then click Start again.');
      return null;
    }
    tab = await chrome.tabs.create({ url: bg_lastProject, active: true });
    await waitForLoad(tab.id);
    return tab;
  }
  if (!/\/project\//.test(tab.url || '')) {
    if (!bg_lastProject) {
      await chrome.tabs.update(tab.id, { active: true });
      alert('Open your Flow project once, then click Start again.');
      return null;
    }
    await chrome.tabs.update(tab.id, { url: bg_lastProject, active: true });
    await waitForLoad(tab.id);
  } else {
    const m = new URL(tab.url).pathname.match(/^\/project\/[0-9a-f-]+/i);
    if (m) await chrome.storage.local.set({ bg_lastProject: new URL(tab.url).origin + m[0] });
  }
  return tab;
}

async function send(type) {
  const redirect = type === 'bg-start' || type === 'bg-apply-settings';
  const tab = redirect ? await getFlowProjectTab() : await flowTab();
  if (!tab) { if (!redirect) alert('Open your Google Flow project tab first (flow.google.com), then try again.'); return null; }
  if (!(await ensureScript(tab.id))) {
    alert('Could not reach the Flow page. Refresh the Flow tab once (Cmd+R), then try again.');
    return null;
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, { type });
  } catch (e) {
    alert('Lost contact with the Flow page: ' + e.message);
    return null;
  }
}

function render(run) {
  const el = $('status');
  if (!run) { el.textContent = 'Idle'; el.className = 'pill idle'; return; }
  const total = run.prompts ? run.prompts.length : 0;
  if (run.running && run.paused) { el.textContent = 'Paused'; el.className = 'pill pause'; }
  else if (run.running) { el.textContent = 'Running'; el.className = 'pill run'; }
  else if (run.finished) { el.textContent = 'Finished'; el.className = 'pill idle'; }
  else { el.textContent = 'Stopped'; el.className = 'pill idle'; }
  $('stats').textContent = `Queued ${run.next || 0} / ${total} · Downloaded ${run.downloaded || 0} · Failed ${run.failed || 0}`;
  const pct = total ? Math.round(((run.downloaded || 0) + (run.failed || 0)) / total * 100) : 0;
  $('barfill').style.width = pct + '%';
  const log = $('log');
  log.innerHTML = '';
  for (const l of (run.log || []).slice(-60)) {
    const d = document.createElement('div');
    d.className = l.level;
    d.textContent = new Date(l.t).toLocaleTimeString() + '  ' + l.msg;
    log.appendChild(d);
  }
  log.scrollTop = log.scrollHeight;
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadForm();
  await saveForm();
  const { bg_run } = await chrome.storage.local.get('bg_run');
  render(bg_run);

  for (const f of FIELDS) $(f).addEventListener('input', saveForm);
  $('clear').onclick = async () => { $('prompts').value = ''; await saveForm(); };
  $('start').onclick = async () => {
    const cfg = await saveForm();
    if (!cfg.prompts.length) return alert('Add at least one prompt.');
    const res = await send('bg-start');
    if (res && !res.ok) alert(res.error);
  };
  $('pause').onclick = () => send('bg-pause');
  $('resume').onclick = () => send('bg-resume');
  $('stop').onclick = () => send('bg-stop');
  $('apply').onclick = async () => { await saveForm(); const r = await send('bg-apply-settings'); if (r && r.result) alert(r.result); };

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.bg_run) render(ch.bg_run.newValue);
  });
});
