chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  setupPanels();
});
chrome.runtime.onStartup.addListener(setupPanels);

// ---- side panel only on Flow tabs ----
// The panel is off by default and turned on per Flow tab, so it hides on other tabs and shows again
// when the user comes back to Flow. Other tabs report no URL to us (no "tabs" permission), so they stay off.
const isFlowUrl = (u) => /^https:\/\/(flow\.google\.com|labs\.google\/fx)\//.test(u || '');

function panelForTab(tabId, url) {
  const opts = isFlowUrl(url) ? { tabId, path: 'sidepanel.html', enabled: true } : { tabId, enabled: false };
  return chrome.sidePanel.setOptions(opts).catch(() => {});
}

async function setupPanels() {
  await chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
  const tabs = await chrome.tabs.query({ url: ['https://flow.google.com/*', 'https://labs.google/fx/*'] }).catch(() => []);
  for (const t of tabs) panelForTab(t.id, t.url);
}

// Toolbar icon: opens the panel on a Flow tab, and opens Flow on any other tab (the panel is hidden there)
chrome.action.onClicked.addListener((tab) => {
  if (isFlowUrl(tab.url)) {
    chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true }).catch(() => {});
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  } else {
    chrome.tabs.create({ url: 'https://flow.google.com/' });
  }
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info.url && info.status !== 'loading') return;
  const wasFlow = isFlowUrl(tab.url);
  panelForTab(tabId, tab.url).then(() => {
    // Chrome only opens a side panel after a click, so this works when the user clicked a link to Flow
    // and is quietly refused otherwise. Once opened on a Flow tab, it stays open there.
    if (wasFlow && info.url) chrome.sidePanel.open({ tabId }).catch(() => {});
  });
});

// ---- trusted clicks (Flow ignores scripted clicks on the Start button) ----
const attached = new Set();

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    // already attached by us after a service worker restart is fine
    if (!/already attached/i.test(String(e && e.message))) throw e;
  }
  attached.add(tabId);
}

chrome.debugger.onDetach.addListener((src) => {
  if (src && src.tabId) attached.delete(src.tabId);
});

async function trustedClick(tabId, x, y) {
  await ensureAttached(tabId);
  const send = (method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

// ---- download naming and tracking ----
// Flow names its files like "Rover_driving_on_Mars_terrain_20261022230114.mp4" (or "..._1080p_...").
// 1080p files can arrive minutes after the click, so expectations live in storage, not in memory
// (the service worker may have been restarted in between).
//   bg_expect: [{ name, title, until }]   files we are waiting for
//   bg_dlmap:  { downloadId: name }       downloads we renamed
//   bg_dl:     { name: { state, error, t } }  result, read by the content script

const key = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function looksLikeFlow(item) {
  const hay = (item.mime || '') + ' ' + (item.url || '') + ' ' + (item.finalUrl || '') + ' ' + (item.referrer || '') + ' ' + (item.filename || '');
  return /video|mp4|googleusercontent|googleapis|flow\.google|labs\.google|blob:/i.test(hay);
}

function pickExpectation(list, item) {
  const base = key((item.filename || '').split(/[\\/]/).pop().replace(/_(\d{3,4}p_)?\d{8,}.*$/, ''));
  let best = -1;
  let bestLen = 0;
  list.forEach((x, i) => {
    const t = key(x.title);
    if (!t || !base) return;
    const n = Math.min(t.length, base.length, 24);
    if (n >= 6 && t.slice(0, n) === base.slice(0, n) && n > bestLen) { best = i; bestLen = n; }
  });
  if (best >= 0) return best;
  // no title match: only take a guess when exactly one file is expected
  return list.length === 1 ? 0 : -1;
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // our own direct downloads already carry the right name
  if (item.byExtensionId === chrome.runtime.id || !looksLikeFlow(item)) { suggest(); return; }
  chrome.storage.local.get(['bg_expect', 'bg_dlmap', 'bg_dl', 'bg_dl_active']).then((o) => {
    const now = Date.now();
    const list = (o.bg_expect || []).filter((x) => x.until > now);
    const i = pickExpectation(list, item);
    if (i < 0) {
      // while "Download all" runs, every Flow video still goes into the BulkGen folder, under Flow's own name
      if ((o.bg_dl_active || 0) > now) suggest({ filename: 'BulkGen/' + (item.filename || 'video.mp4').split(/[\\/]/).pop(), conflictAction: 'uniquify' });
      else suggest();
      return;
    }
    const exp = list.splice(i, 1)[0];
    const map = o.bg_dlmap || {};
    for (const id of Object.keys(map).slice(0, -200)) delete map[id]; // keep the last 200
    map[item.id] = exp.name;
    const dl = o.bg_dl || {};
    dl[exp.name] = { state: 'in_progress', t: now };
    chrome.storage.local.set({ bg_expect: list, bg_dlmap: map, bg_dl: dl });
    suggest({ filename: 'BulkGen/' + exp.name, conflictAction: 'uniquify' });
  }).catch(() => suggest());
  return true; // suggest is called asynchronously
});

chrome.downloads.onChanged.addListener((d) => {
  if (!d.state && !d.error) return;
  chrome.storage.local.get(['bg_dlmap', 'bg_dl']).then((o) => {
    const name = (o.bg_dlmap || {})[d.id];
    if (!name) return;
    const dl = o.bg_dl || {};
    const state = d.state ? d.state.current : 'interrupted';
    dl[name] = { state, error: d.error ? d.error.current : '', t: Date.now() };
    chrome.storage.local.set({ bg_dl: dl });
  });
});

async function expectDownload(name, title, waitMs) {
  const o = await chrome.storage.local.get(['bg_expect', 'bg_dl']);
  const now = Date.now();
  // videos are saved one at a time, so only the current one is expected; a late file from an
  // earlier video that timed out can not take its name
  const list = [{ name, title, until: now + waitMs }];
  // keep two days of results so storage does not grow forever
  const dl = {};
  for (const [k, v] of Object.entries(o.bg_dl || {})) if (now - (v.t || 0) < 2 * 86400000) dl[k] = v;
  dl[name] = { state: 'expected', t: now };
  await chrome.storage.local.set({ bg_expect: list, bg_dl: dl });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'bulkgen-click') {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); return; }
    trustedClick(tabId, msg.x, msg.y)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === 'bulkgen-detach') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId && attached.has(tabId)) {
      chrome.debugger.detach({ tabId }).catch(() => {}).finally(() => { attached.delete(tabId); sendResponse({ ok: true }); });
      return true;
    }
    sendResponse({ ok: true });
    return;
  }

  // a video that was given up on: a later download (for example a manual one) must not take its name
  if (msg.type === 'bulkgen-expect-clear') {
    chrome.storage.local.set({ bg_expect: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'bulkgen-expect-download') {
    expectDownload(msg.filename, msg.title || '', msg.waitMs || 120000).then(() => sendResponse({ ok: true }));
    return true;
  }

  // live state of one of our downloads, straight from Chrome: state, bytes received and total
  if (msg.type === 'bulkgen-dl-info') {
    chrome.storage.local.get('bg_dlmap').then(async (o) => {
      const id = Object.keys(o.bg_dlmap || {}).reverse().find((k) => o.bg_dlmap[k] === msg.filename);
      if (!id) { sendResponse({ ok: false }); return; }
      const [d] = await chrome.downloads.search({ id: Number(id) });
      if (!d) { sendResponse({ ok: false }); return; }
      sendResponse({ ok: true, state: d.state, error: d.error || '', got: d.bytesReceived, total: d.totalBytes });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }

  // developer builds only (loaded unpacked): lets the test bridge reload the extension
  if (msg.type === 'bulkgen-reload-extension' && !chrome.runtime.getManifest().update_url) {
    sendResponse({ ok: true });
    setTimeout(() => chrome.runtime.reload(), 200);
  }
});
