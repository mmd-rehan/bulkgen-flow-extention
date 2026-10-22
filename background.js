chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ---- trusted clicks (Flow ignores scripted clicks on the Start button) ----
const attached = new Set();

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
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

// ---- download naming ----
let pendingName = null; // { name, until }

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (pendingName && Date.now() < pendingName.until) {
    const hay = (item.mime || '') + ' ' + (item.url || '') + ' ' + (item.finalUrl || '');
    if (/video|mp4|googleusercontent|googleapis|flow\.google|labs\.google|blob:/i.test(hay)) {
      const name = pendingName.name;
      pendingName = null;
      suggest({ filename: 'BulkGen/' + name, conflictAction: 'uniquify' });
      return;
    }
  }
  suggest();
});

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

  if (msg.type === 'bulkgen-expect-download') {
    pendingName = { name: msg.filename, until: Date.now() + 45000 };
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'bulkgen-download') {
    chrome.downloads.download(
      { url: msg.url, filename: 'BulkGen/' + msg.filename, conflictAction: 'uniquify', saveAs: false },
      (id) => {
        if (chrome.runtime.lastError) sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        else sendResponse({ ok: true, id });
      }
    );
    return true;
  }
});
