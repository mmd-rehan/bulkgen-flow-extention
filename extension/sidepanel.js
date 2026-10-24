const $ = (id) => document.getElementById(id);
const FIELDS = ['prompts', 'character', 'style', 'duration', 'aspect', 'count', 'model', 'maxInFlight', 'maxCredits', 'prefix', 'retries', 'downloadRetries', 'quality', 'confirmNever', 'timeoutMin', 'engine', 'resolution', 'useRefs', 'refsRights'];
const VALUE_FIELDS = ['character', 'style', 'aspect', 'count', 'maxInFlight', 'maxCredits', 'prefix', 'retries', 'downloadRetries', 'quality', 'timeoutMin', 'engine'];
const MAX_REFS = 3;
let models = []; // what Flow offers, read by the content script
let savedCfg = {};

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
    model: $('model').value || savedCfg.model || '',
    engine: $('engine').value,
    resolution: $('resolution').value,
    useRefs: $('useRefs').checked && !$('refsBox').hidden,
    refsRights: $('refsRights').checked,
    maxInFlight: Math.max(1, parseInt($('maxInFlight').value, 10) || 2),
    maxCredits: Math.max(0, parseInt($('maxCredits').value, 10) || 0),
    prefix: ($('prefix').value || 'flow').replace(/[^\w-]+/g, '_'),
    retries: Math.max(1, parseInt($('retries').value, 10) || 3),
    quality: $('quality').value,
    downloadRetries: Math.max(1, parseInt($('downloadRetries').value, 10) || 3),
    timeoutMin: Math.max(3, parseInt($('timeoutMin').value, 10) || 15),
    confirmNever: $('confirmNever').checked
  };
  return cfg;
}

async function saveForm() {
  const cfg = readForm();
  savedCfg = cfg;
  await chrome.storage.local.set({ bg_cfg: cfg });
  $('promptCount').textContent = cfg.prompts.length + ' prompt' + (cfg.prompts.length === 1 ? '' : 's');
  return cfg;
}

async function loadForm() {
  const { bg_cfg, bg_models } = await chrome.storage.local.get(['bg_cfg', 'bg_models']);
  savedCfg = bg_cfg || {};
  models = (bg_models && bg_models.models) || [];
  if (bg_cfg) {
    $('prompts').value = bg_cfg.rawPrompts || (bg_cfg.prompts || []).join('\n');
    for (const f of VALUE_FIELDS) if (bg_cfg[f] !== undefined) $(f).value = bg_cfg[f];
    $('confirmNever').checked = !!bg_cfg.confirmNever;
    $('useRefs').checked = !!bg_cfg.useRefs;
    $('refsRights').checked = !!bg_cfg.refsRights;
  }
  renderModels();
}

// ---- model dropdown (filled from what Flow offers) ----
function fillSelect(sel, values, want, fallback) {
  sel.innerHTML = '';
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    sel.appendChild(o);
  }
  sel.value = values.includes(want) ? want : (values.includes(fallback) ? fallback : values[0] || '');
}

function renderModels() {
  const sel = $('model');
  const want = savedCfg.model || '';
  sel.innerHTML = '';
  if (!models.length) {
    const o = document.createElement('option');
    o.value = want;
    o.textContent = want ? want + ' (click Refresh to check Flow)' : 'Click Refresh to read models from Flow';
    sel.appendChild(o);
  }
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m.name;
    o.textContent = m.name;
    sel.appendChild(o);
  }
  if (models.length) sel.value = models.some((m) => m.name === want) ? want : models[0].name;
  renderModelOptions();
}

function renderModelOptions() {
  const m = models.find((x) => x.name === $('model').value);
  const durations = m && m.durations.length ? m.durations : (m && !m.fromSettings ? [] : ['4', '6', '8', '10']);
  if (durations.length) {
    fillSelect($('duration'), durations, String(savedCfg.duration || ''), '6');
    $('duration').disabled = false;
  } else {
    fillSelect($('duration'), ['fixed'], 'fixed');
    $('duration').disabled = true;
  }
  const res = m && m.resolutions.length ? m.resolutions : [];
  fillSelect($('resolution'), res.length ? res : ['default'], savedCfg.resolution || '', '720p');
  $('resolution').disabled = !res.length;
  if (m && m.aspects && m.aspects.length) fillSelect($('aspect'), m.aspects, savedCfg.aspect || '', '16:9');
  // reference images only for models that take them (plain mode)
  const refsOk = $('engine').value !== 'agent' && (!m || m.ingredients || m.fromSettings);
  $('refsBox').hidden = !refsOk;
  $('refsOn').hidden = !$('useRefs').checked;
  $('agentOpts').hidden = $('engine').value !== 'agent';
  $('modelInfo').textContent = !m ? '' : (m.durations.length ? `(${m.durations.join('/')}s` : '(fixed length') + (m.credits != null ? `, about ${m.credits} credits each at the settings Flow had when read)` : ')');
}

async function readModels(quiet) {
  $('readModels').disabled = true;
  $('readModels').textContent = 'Reading...';
  try {
    const res = await send('bg-read-models', null, quiet);
    if (res && res.ok) {
      models = res.models;
      // this Flow layout has no settings chip in the prompt box, so only the agent chat can drive it
      if (res.layout === 'agent' && $('engine').value !== 'agent') {
        $('engine').value = 'agent';
        if (!quiet) alert('Your Flow layout has no settings chip in the prompt box, so BulkGen switched "How to drive Flow" to "Flow agent chat". The model is set in Flow\'s Settings panel at Start.');
      }
      renderModels();
      await saveForm();
    } else if (res && !quiet) {
      alert(res.error || 'Could not read the models from Flow.');
    }
  } finally {
    $('readModels').disabled = false;
    $('readModels').textContent = 'Refresh';
  }
}

// ---- reference images ----
function shrinkImage(file, maxSide = 1536) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      const png = file.type === 'image/png';
      resolve({ name: file.name.replace(/\.\w+$/, '') + (png ? '.png' : '.jpg'), dataUrl: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.92) });
    };
    img.onerror = () => reject(new Error('Could not read ' + file.name));
    img.src = URL.createObjectURL(file);
  });
}

async function renderRefs() {
  const { bg_refs } = await chrome.storage.local.get('bg_refs');
  const list = $('refList');
  list.innerHTML = '';
  for (const [i, r] of (bg_refs || []).entries()) {
    const d = document.createElement('div');
    d.className = 'ref';
    d.title = r.name;
    const img = document.createElement('img');
    img.src = r.dataUrl;
    const x = document.createElement('button');
    x.textContent = 'x';
    x.title = 'Remove';
    x.onclick = async () => {
      const cur = (await chrome.storage.local.get('bg_refs')).bg_refs || [];
      cur.splice(i, 1);
      await chrome.storage.local.set({ bg_refs: cur });
      renderRefs();
    };
    d.append(img, x);
    list.appendChild(d);
  }
}

async function addRefs(files) {
  const cur = (await chrome.storage.local.get('bg_refs')).bg_refs || [];
  for (const f of files) {
    if (cur.length >= MAX_REFS) { alert(`Up to ${MAX_REFS} reference images.`); break; }
    try { cur.push(await shrinkImage(f)); } catch (e) { alert(e.message); }
  }
  await chrome.storage.local.set({ bg_refs: cur });
  $('refFiles').value = '';
  renderRefs();
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

async function send(type, extra, quiet) {
  const redirect = type === 'bg-start' || type === 'bg-apply-settings' || (type === 'bg-read-models' && !quiet);
  const tab = redirect ? await getFlowProjectTab() : await flowTab();
  if (!tab) { if (!redirect && !quiet) alert('Open your Google Flow project tab first (flow.google.com), then try again.'); return null; }
  if (!(await ensureScript(tab.id))) {
    if (!quiet) alert('Could not reach the Flow page. Refresh the Flow tab once (Cmd+R), then try again.');
    return null;
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, Object.assign({ type }, extra));
  } catch (e) {
    if (!quiet) alert('Lost contact with the Flow page: ' + e.message);
    return null;
  }
}

let lastRun = null;

function render(run) {
  lastRun = run;
  const el = $('status');
  if (!run) { el.textContent = 'Idle'; el.className = 'pill idle'; return; }
  const total = run.prompts ? run.prompts.length : 0;
  if (run.running && run.paused) { el.textContent = 'Paused'; el.className = 'pill pause'; }
  else if (run.running) { el.textContent = 'Running'; el.className = 'pill run'; }
  else if (run.finished) { el.textContent = 'Finished'; el.className = 'pill idle'; }
  else { el.textContent = 'Stopped'; el.className = 'pill idle'; }
  const items = run.items || [];
  const generating = items.filter((it) => it.status === 'queued').length;
  const downloading = items.filter((it) => it.status === 'downloading').length;
  $('stats').textContent = `Queued ${run.next || 0} / ${total} · Generating ${generating} · Downloading ${downloading} · Downloaded ${run.downloaded || 0} · Failed ${run.failed || 0}` + (run.credits ? ` · ${run.credits} credits` : '');
  $('step').textContent = run.running ? 'Now: ' + (run.step || '') : '';
  let stuck = run.stuck || '';
  if (run.running && !run.paused && run.beat && Date.now() - run.beat > 90000) {
    stuck = 'The Flow tab has not reported anything for ' + Math.round((Date.now() - run.beat) / 60000) + ' min. Make sure the Flow tab is open (not discarded), then click Resume.';
  }
  $('stuck').hidden = !stuck;
  $('stuck').textContent = stuck;
  const pct = total ? Math.round(((run.downloaded || 0) + (run.failed || 0)) / total * 100) : 0;
  $('barfill').style.width = pct + '%';
  const log = $('log');
  log.innerHTML = '';
  for (const l of (run.log || []).slice(-120)) {
    const d = document.createElement('div');
    d.className = l.level;
    d.textContent = new Date(l.t).toLocaleTimeString() + '  ' + l.msg;
    log.appendChild(d);
  }
  log.scrollTop = log.scrollHeight;
}

function exportLog() {
  const run = lastRun;
  if (!run || !run.log) return alert('Nothing to export yet.');
  const lines = run.log.map((l) => new Date(l.t).toISOString() + '  ' + l.level.toUpperCase().padEnd(5) + '  ' + l.msg);
  const items = (run.items || []).map((it, i) => `#${i + 1} ${it.status}${it.note ? ' (' + it.note + ')' : ''}${(it.files || []).length ? ' -> ' + it.files.join(', ') : ''}  ${run.prompts[i]}`);
  const text = 'BulkGen log, version ' + chrome.runtime.getManifest().version + '\n\n' + lines.join('\n') + '\n\nPrompts:\n' + items.join('\n') + '\n';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  chrome.downloads.download({ url: 'data:text/plain;charset=utf-8,' + encodeURIComponent(text), filename: 'BulkGen/bulkgen-log-' + stamp + '.txt', saveAs: false });
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadForm();
  await saveForm();
  const { bg_run } = await chrome.storage.local.get('bg_run');
  render(bg_run);

  for (const f of FIELDS) $(f).addEventListener(['useRefs', 'refsRights', 'confirmNever'].includes(f) ? 'change' : 'input', saveForm);
  for (const f of ['model', 'engine', 'useRefs']) $(f).addEventListener('change', async () => { await saveForm(); renderModelOptions(); await saveForm(); });
  $('readModels').onclick = () => readModels(false);
  // starts over when the saved models or mode no longer match Flow
  $('resetModels').onclick = async () => {
    await chrome.storage.local.remove('bg_models');
    models = [];
    savedCfg.model = '';
    $('engine').value = 'plain';
    renderModels();
    await saveForm();
    await readModels(false);
  };
  $('refFiles').onchange = () => addRefs([...$('refFiles').files]);
  renderRefs();
  // first time: ask Flow which models exist (only if a project tab is open and nothing is running)
  if (!models.length && !(bg_run && bg_run.running)) readModels(true);
  $('clear').onclick = async () => { $('prompts').value = ''; await saveForm(); };
  $('start').onclick = async () => {
    const cfg = await saveForm();
    if (!cfg.prompts.length) return alert('Add at least one prompt.');
    const res = await send('bg-start');
    if (res && !res.ok) alert(res.error);
  };
  $('test').onclick = async () => {
    const cfg = await saveForm();
    if (!cfg.prompts.length) return alert('Add at least one prompt.');
    const res = await send('bg-start', { limit: 1 });
    if (res && !res.ok) alert(res.error);
  };
  $('export').onclick = exportLog;
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;
  setInterval(() => render(lastRun), 15000); // keeps the "not reporting" check fresh
  $('pause').onclick = () => send('bg-pause');
  $('resume').onclick = () => send('bg-resume');
  $('stop').onclick = () => send('bg-stop');
  $('apply').onclick = async () => { await saveForm(); const r = await send('bg-apply-settings'); if (r && r.result) alert(r.result); };

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.bg_run) render(ch.bg_run.newValue);
  });
});
