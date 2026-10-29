/* BulkGen for Google Flow - content script (drives the Flow page) */
(() => {
  // After an extension reload the old (orphaned) copy can still hold the page. Retire it and take over.
  try { if (typeof window.__bulkgenDispose === 'function') window.__bulkgenDispose(); } catch (e) { /* ignore */ }

  const HAS_CHROME = typeof chrome !== 'undefined' && chrome.storage && chrome.runtime && chrome.runtime.id;
  const DRY = !HAS_CHROME; // dry mode lets helpers be tested from a plain page console

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const key = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const short = (s, n = 50) => { s = norm(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  // Text patterns seen on the real site (or close to it)
  const SCHEDULED_RE = /scheduled|waiting in the queue|in the queue|being generated|started generating|is generating|kicked off|on its way/i;
  const CREDIT_RE = /(out of|not enough|insufficient|no more|run out of|ran out of|don.t have enough)\s+(ai\s+)?credits|credit (limit|balance)|quota|usage limit|limit reached|reached (your|the) (daily |monthly )?limit|upgrade (your plan )?to (continue|generate|keep)/i;
  const FAIL_RE = /fail|error|couldn.t|could not|unable|violat|policy|blocked|unsafe|not able|went wrong/i;

  // ---------- storage ----------
  const mem = {};
  // After the extension is reloaded or updated, this copy of the script is cut off from it
  // ("Extension context invalidated"). Then it must stop quietly and leave the page to the new copy.
  const alive = () => { try { return !!chrome.runtime.id; } catch (e) { return false; } };
  let retired = false;
  function retire() {
    if (retired) return;
    retired = true;
    stopFlag = true;
    clearInterval(rememberTimer);
    console.log('[BulkGen] Extension was reloaded, this old copy has stopped.');
  }

  const store = {
    async get(k, def) {
      if (DRY) return k in mem ? mem[k] : def;
      if (!alive()) { retire(); return def; }
      try {
        const o = await chrome.storage.local.get(k);
        return k in o ? o[k] : def;
      } catch (e) {
        if (!alive()) retire(); else console.warn('[BulkGen] storage read failed:', e.message);
        return def;
      }
    },
    async set(k, val) {
      if (DRY) { mem[k] = val; return; }
      if (!alive()) { retire(); return; }
      try {
        await chrome.storage.local.set({ [k]: val });
      } catch (e) {
        if (!alive()) retire(); else console.warn('[BulkGen] storage write failed:', e.message);
      }
    }
  };

  let rememberTimer = null;
  let run = null; // live run state
  let stopFlag = false;
  let pauseFlag = false;
  let looping = false;
  window.__bulkgenDispose = () => { stopFlag = true; };

  async function saveRun() {
    if (!run) return;
    run.beat = Date.now();
    await store.set('bg_run', run);
  }

  async function log(msg, level = 'info') {
    const line = { t: Date.now(), level, msg };
    if (run) {
      run.log = (run.log || []).concat(line).slice(-1500);
      await saveRun();
    }
    console.log('[BulkGen]', msg);
  }

  async function setStep(text) {
    if (!run || run.step === text) return;
    run.step = text;
    await saveRun();
  }

  function progress() {
    if (!run) return;
    run.lastProgress = Date.now();
    if (run.stuck) run.stuck = '';
  }

  // ---------- DOM helpers ----------
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  function accName(el) {
    return norm(el.getAttribute('aria-label') || el.innerText || el.textContent || '');
  }

  // Flow puts icon names in front of labels ("check Approve", "crop_16_9 16:9"), so match the end
  function labelEnds(el, word) {
    return new RegExp('(^|\\s)' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i').test(accName(el));
  }

  function findClickable(re, root = document) {
    const els = root.querySelectorAll('button,[role=button],[role=menuitem],[role=option],[role=radio],[role=tab],a,li,div[tabindex]');
    for (const el of els) {
      if (!visible(el)) continue;
      if (re.test(accName(el))) return el;
    }
    return null;
  }

  function realClick(el) {
    el.scrollIntoView({ block: 'center' });
    const o = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.click();
  }

  function sendBg(msg) {
    if (!HAS_CHROME) return Promise.resolve({ ok: false, error: 'no extension' });
    if (!alive()) { retire(); return Promise.resolve({ ok: false, error: 'extension was reloaded' }); }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (x) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(x || { ok: false, error: 'no response' });
        });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  }

  // Real (trusted) click through the background page. Flow ignores scripted clicks on the Start button.
  async function trustedClick(el) {
    el.scrollIntoView({ block: 'center' });
    await sleep(150);
    if (HAS_CHROME) {
      const r = el.getBoundingClientRect();
      const res = await sendBg({ type: 'bulkgen-click', x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      if (res.ok) return true;
      const hint = /different extension/i.test(res.error)
        ? 'Another extension is attached to this tab (for example a browser automation tool), close it.'
        : 'Close DevTools on the Flow tab if it is open.';
      await log('Real click failed (' + res.error + '), using a scripted click. ' + hint, 'warn');
    }
    realClick(el);
    return false;
  }

  async function waitFor(fn, timeout = 10000, step = 250) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (stopFlag) return null;
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  // ---------- chat panel ----------
  function chatBox() {
    const cands = document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable="plaintext-only"],[role=textbox],input[type=text]');
    for (const el of cands) {
      if (!visible(el)) continue;
      const hint = norm(
        (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' +
        (el.getAttribute('data-placeholder') || '') + ' ' + (el.getAttribute('aria-placeholder') || '')
      );
      if (/what do you want to create/i.test(hint)) return el;
    }
    // some Flow layouts word the placeholder differently: take the text field next to the settings chip
    const chip = document.querySelector('button[aria-label="Settings trigger"]');
    for (let p = chip && chip.parentElement; p && p !== document.body; p = p.parentElement) {
      const el = [...p.querySelectorAll('textarea,[contenteditable="true"],[contenteditable="plaintext-only"],[role=textbox],input[type=text]')].find(visible);
      if (el) return el;
    }
    return null;
  }

  function boxText() {
    const b = chatBox();
    return b ? norm(b.innerText || b.value || '') : '';
  }

  function setText(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete');
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function submitButton() {
    const b = [...document.querySelectorAll('button[aria-label="Start generation"]')].filter(visible).pop();
    return b || findClickable(/^start generation$/i);
  }

  // While the agent works, the send button turns into a Stop button
  function agentBusy() {
    return [...document.querySelectorAll('button')].some((b) => visible(b) && /^stop\b/i.test(b.getAttribute('aria-label') || ''));
  }

  function messageRows() { return [...document.querySelectorAll('.messages-list > .message-row')]; }
  const isUserRow = (row) => row.classList.contains('user-row');
  const rowText = (row) => norm(row.innerText);

  function sameText(a, b) {
    const ka = key(a);
    const kb = key(b);
    if (!ka || !kb) return false;
    const n = Math.min(160, ka.length, kb.length);
    return ka.slice(0, n) === kb.slice(0, n) && Math.abs(ka.length - kb.length) < 40;
  }

  function userRowsMatching(text) {
    return messageRows().filter((r) => isUserRow(r) && sameText(rowText(r), text));
  }

  // Media ids of the videos the chat scheduled for a prompt (last time it was sent)
  function chatMediaIds(text) {
    const row = userRowsMatching(text).pop();
    if (!row) return [];
    return rowsAfter(row).flatMap((r) => [...r.querySelectorAll('flow-a2ui-video-option img')].map(mediaIdOf)).filter(Boolean);
  }

  // Rows the agent (and our Approve/Reject answers) added after a given user message
  function rowsAfter(userRow) {
    const out = [];
    let r = userRow.nextElementSibling;
    while (r) {
      if (r.classList.contains('message-row')) {
        if (isUserRow(r) && !/^(approve|always approve|reject)$/i.test(rowText(r))) break;
        out.push(r);
      }
      r = r.nextElementSibling;
    }
    return out;
  }

  const cardRadios = (card) => [...card.querySelectorAll('[role=radio]')];
  const cardOpen = (card) => cardRadios(card).some((r) => r.getAttribute('aria-disabled') !== 'true');
  const cardOption = (card, word) => cardRadios(card).find((r) => labelEnds(r, word));
  function cardChoice(card) {
    const c = cardRadios(card).find((r) => r.getAttribute('aria-checked') === 'true');
    if (!c) return '';
    return /always approve$/i.test(accName(c)) ? 'approve' : /approve$/i.test(accName(c)) ? 'approve' : /reject$/i.test(accName(c)) ? 'reject' : '';
  }

  function cardInfo(card) {
    const row = card.closest('.message-row');
    const txt = norm(row ? row.innerText : card.innerText);
    const m = txt.match(/costing\s+([\d,]+)\s+credits?/i);
    const cost = m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
    const nm = txt.match(/(\d+)\s+(video|image)\s+generations?/i);
    const count = nm ? parseInt(nm[1], 10) : 1;
    const isImage = /\bimage generations?\b/i.test(txt) || (/\bimage\b/i.test(txt) && !/\bvideo\b/i.test(txt));
    return { cost, count, perVideo: count ? Math.round(cost / count) : cost, isImage, text: txt };
  }

  // The user message right before a card
  function cardPrompt(card) {
    let r = card.closest('.message-row');
    while (r && (r = r.previousElementSibling)) {
      if (r.classList.contains('message-row') && isUserRow(r)) return rowText(r);
    }
    return '';
  }

  function openCards() { return [...document.querySelectorAll('flow-permission-message')].filter(cardOpen); }

  async function clickCardOption(card, word) {
    const opt = cardOption(card, word);
    if (!opt) return false;
    realClick(opt);
    const ok = await waitFor(() => !cardOpen(card) || opt.getAttribute('aria-checked') === 'true', 4000);
    if (ok) return true;
    await trustedClick(opt);
    return !!(await waitFor(() => !cardOpen(card) || opt.getAttribute('aria-checked') === 'true', 6000));
  }

  // Problems Flow shows outside the chat (snackbars, banners)
  function pageProblem() {
    const els = document.querySelectorAll('[role=alert],[aria-live],mat-snack-bar-container,.mat-mdc-snack-bar-label,[class*=snackbar],[class*=banner]');
    for (const el of els) {
      const t = norm(el.innerText);
      if (t && t.length < 400 && CREDIT_RE.test(t)) return t;
    }
    return '';
  }

  async function waitIdle(timeout = 90000) {
    if (!agentBusy()) return true;
    await setStep('Waiting for the Flow agent to finish its current reply');
    return !!(await waitFor(() => !agentBusy(), timeout, 500));
  }

  // ---------- library grid ----------
  function gridTiles() {
    const out = [];
    for (const t of document.querySelectorAll('flow-grid-tile-container')) {
      if (!visible(t)) continue;
      const img = t.querySelector('img');
      const pendingEl = t.querySelector('flow-pending-tile,.loading-percentage');
      const pctEl = t.querySelector('.loading-percentage');
      const src = img ? (img.currentSrc || img.src || '').split('?')[0] : '';
      const text = norm(t.innerText);
      const sub = t.querySelector('.subtitle');
      const subtitle = norm(sub ? sub.innerText : '');
      const isVideo = !!t.querySelector('flow-video-tile');
      const isImage = !!t.querySelector('flow-image-tile');
      const pending = !!pendingEl && !src;
      const failed = !src && !(pctEl && /\d/.test(pctEl.innerText)) && FAIL_RE.test(text.replace(/play_circle/g, ''));
      // Flow's list view groups each generation in a row that shows the full prompt and a Download button
      const row = t.closest('.batch-container');
      const promptEl = row && row.querySelector('flow-expandable-prompt');
      const prompt = norm((promptEl ? promptEl.innerText : subtitle).replace(/keyboard_return/g, ''));
      const rowDownload = row && row.querySelectorAll('flow-grid-tile-container').length === 1
        ? row.querySelector('button[aria-label="Download"]') : null;
      out.push({
        key: src || ('nosrc:' + key(prompt || text).slice(0, 80)),
        el: img || t, tile: t, src, text, subtitle, prompt, rowDownload, isVideo, isImage, pending, failed,
        pct: pctEl ? norm(pctEl.innerText) : '',
        title: t.getAttribute('aria-label') || ''
      });
    }
    return out;
  }

  function gridScroller() {
    const t = document.querySelector('flow-grid-tile-container');
    let e = t && t.parentElement;
    while (e && e !== document.body) {
      const s = getComputedStyle(e);
      if (/(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 10) return e;
      e = e.parentElement;
    }
    return null;
  }

  async function goToGrid() {
    if (/\/edit\//.test(location.pathname)) {
      const left = () => !/\/edit\//.test(location.pathname);
      const backBtn = () => document.querySelector('button[aria-label^="Back button"]') || findClickable(/^back button/i);
      // an open menu or tooltip can swallow the click, so close it first
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await sleep(200);
      if (backBtn()) realClick(backBtn());
      if (!(await waitFor(left, 5000)) && backBtn()) {
        await log('Back button did not react, trying a real click.', 'warn');
        await trustedClick(backBtn());
      }
      if (!(await waitFor(left, 5000)) && run && run.project) {
        await log('Still on the video page, loading the project page again.', 'warn');
        location.assign(location.origin + run.project);
        await sleep(20000);
      }
      await sleep(800);
    }
    // "All media" always exists; the Videos tab only appears after the first video
    const tab = findClickable(/^(dashboard\s+)?all media$/i) || findClickable(/^(videocam\s+)?videos$/i);
    if (tab && tab.getAttribute('aria-selected') !== 'true' && !tab.classList.contains('active')) { realClick(tab); await sleep(700); }
    await waitFor(chatBox, 8000);
  }

  // Some Flow accounts show the prompt box inside the agent panel on the right side. Its settings
  // popup does not offer the video models, so close that panel: the prompt box then sits at the bottom.
  const inSidePanel = () => { const b = chatBox(); return !!(b && b.closest('flow-agent-panel')); };
  async function promptBoxToBottom() {
    if (!inSidePanel()) return true;
    const close = () => document.querySelector('flow-agent-panel .agent-panel-header button[aria-label="Close"]');
    if (!close()) { await log('The prompt box is in Flow\'s side panel and its Close button was not found.', 'warn'); return false; }
    realClick(close());
    let ok = await waitFor(() => !inSidePanel() && chatBox(), 3000);
    if (!ok && close()) { await trustedClick(close()); ok = await waitFor(() => !inSidePanel() && chatBox(), 4000); }
    await log(ok ? 'Moved Flow\'s prompt box from the side panel to the bottom of the page.' : 'Could not move Flow\'s prompt box out of the side panel.', ok ? 'info' : 'warn');
    return !!ok;
  }

  // ---------- Flow agent settings ----------
  function settingsPanel() {
    const h = [...document.querySelectorAll('div,span,h2,h3,label')].find((e) => e.children.length === 0 && norm(e.textContent) === 'Confirm before generating');
    let p = h;
    while (p && !/\bSave\b/.test(p.innerText || '')) p = p.parentElement;
    // some Flow layouts show the settings as a dialog without the confirm option
    return p || [...document.querySelectorAll('[role=dialog]')].find((d) => visible(d) && d.querySelector('button[aria-haspopup]')) || null;
  }

  async function openSettings() {
    if (settingsPanel()) return settingsPanel();
    const btns = [...document.querySelectorAll('button[aria-label="Settings"]')].filter(visible);
    const btn = btns.find((b) => /tune/.test(b.innerText)) || btns[btns.length - 1] || findClickable(/^(tune\s+)?settings$/i);
    if (!btn) return null;
    realClick(btn);
    let p = await waitFor(settingsPanel, 3000);
    if (!p) { await trustedClick(btn); p = await waitFor(settingsPanel, 4000); }
    return p;
  }

  async function applyFlowSettings(cfg) {
    await goToGrid();
    const panel = await openSettings();
    if (!panel) return 'Could not open the agent settings in the prompt box.';
    const notes = [];
    if (cfg.confirmNever !== undefined) {
      const radios = [...panel.querySelectorAll('input[type=radio]')];
      const want = radios[cfg.confirmNever ? 1 : 0];
      if (want) {
        if (!want.checked) { realClick(want); await sleep(250); }
        notes.push('confirm before generating=' + (cfg.confirmNever ? 'Never' : 'Always') + (want.checked ? '' : ' (did not stick)'));
      }
    }
    // The video group comes after the image group, so take the last match
    const toggles = () => [...panel.querySelectorAll('button[role=radio]')];
    if (cfg.aspect) {
      const el = toggles().filter((b) => labelEnds(b, cfg.aspect)).pop();
      if (el) { realClick(el); notes.push('video aspect=' + cfg.aspect); await sleep(200); }
    }
    if (cfg.count) {
      const el = toggles().filter((b) => labelEnds(b, 'x' + cfg.count)).pop();
      if (el) { realClick(el); notes.push('outputs=x' + cfg.count); await sleep(200); }
    }
    if (cfg.model) {
      const dd = [...panel.querySelectorAll('button[aria-haspopup]')].pop();
      if (dd) {
        realClick(dd);
        await sleep(600);
        const opt = [...document.querySelectorAll('[role=menuitem],[role=option],[role=menuitemradio]')].find((e) => visible(e) && accName(e).toLowerCase().includes(cfg.model.toLowerCase()));
        if (opt) { realClick(opt); notes.push('model=' + cfg.model); await sleep(300); }
        else { notes.push('model "' + cfg.model + '" not found'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(300); }
      }
    }
    const save = [...panel.querySelectorAll('button')].find((b) => /^save$/i.test(accName(b)));
    if (save) realClick(save);
    await sleep(800);
    return 'Flow settings: ' + (notes.join(', ') || 'nothing changed');
  }

  // ---------- plain generate mode (Flow's Agent toggle off) ----------
  // No chat and no approval cards: the settings chip in the prompt box sets model, aspect, length and
  // count, and Flow shows the credit cost before sending.
  const agentChip = () => document.querySelector('button.agent-mode-chip');
  const genTrigger = () => document.querySelector('button[aria-label="Settings trigger"]');
  const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));

  async function setAgentMode(on) {
    const isOn = () => !!agentChip() && agentChip().getAttribute('aria-pressed') === 'true';
    if (!agentChip()) return !on; // no toggle at all means the old layout
    if (isOn() === on) return true;
    realClick(agentChip());
    if (await waitFor(() => isOn() === on, 2000)) return true;
    await trustedClick(agentChip());
    return !!(await waitFor(() => isOn() === on, 3000));
  }

  function genPopup() {
    const leaf = [...document.querySelectorAll('div,span,p')].find((e) => e.children.length <= 2 && /^Generating will use/i.test(norm(e.textContent)) && visible(e));
    // climb to the box that also holds the Image / Video switch, so switching to Video always works
    let p = leaf;
    while (p && p !== document.body && !/(^|\s)Video(\s|$)/.test(norm(p.innerText))) p = p.parentElement;
    if (p && p !== document.body) return p;
    // popup without the credit line: an open overlay with the Video switch and aspect buttons
    const o = popupOverlays().find((e) => /(^|\s)Video(\s|$)/.test(norm(e.innerText)) && /(^|\s)(16:9|9:16)(\s|$)/.test(norm(e.innerText)));
    if (o) return o;
    // other Flow versions: the panel the chip says it controls, or the one that opened when it was clicked
    const t = genTrigger();
    const ctl = t && t.getAttribute('aria-controls') && document.getElementById(t.getAttribute('aria-controls'));
    if (ctl && visible(ctl)) return ctl;
    return lastPopup && lastPopup.isConnected && visible(lastPopup) ? lastPopup : null;
  }

  const popupOverlays = () => [...document.querySelectorAll('.cdk-overlay-pane,[role=dialog],[role=menu],[role=listbox],[popover],[data-radix-popper-content-wrapper]')].filter(visible);

  let lastPopup = null; // the panel that appeared after the last click on the settings chip
  function newPanel(before) {
    const p = popupOverlays().find((e) => !before.has(e) && e.querySelectorAll('button').length >= 2);
    if (p) lastPopup = p;
    return p || null;
  }

  async function openGenPopup() {
    if (genPopup()) return genPopup();
    if (!genTrigger()) return null;
    const before = new Set(popupOverlays());
    realClick(genTrigger());
    let p = await waitFor(() => genPopup() || newPanel(before), 2500);
    if (!p && genTrigger()) { await trustedClick(genTrigger()); p = await waitFor(() => genPopup() || newPanel(before), 3000); }
    return p;
  }

  async function closeGenPopup() {
    if (!genPopup()) return;
    realClick(genTrigger()); // the chip opens and closes the popup
    if (!(await waitFor(() => !genPopup(), 1500))) { escape(); await sleep(400); }
  }

  // What BulkGen sees on the page. Added to error messages so a screenshot of the log shows why a step failed.
  function pageInfo() {
    const chip = agentChip();
    return [
      'v' + chrome.runtime.getManifest().version,
      'page ' + location.pathname.replace(/[0-9a-f-]{36}/gi, 'ID'),
      'language ' + (document.documentElement.lang || 'unknown'),
      'prompt box ' + (chatBox() ? (inSidePanel() ? 'in side panel' : 'at bottom') : 'missing'),
      'Agent toggle ' + (chip ? (chip.getAttribute('aria-pressed') === 'true' ? 'on' : 'off') : 'missing'),
      'settings chip ' + (genTrigger() ? 'found' : 'missing'),
      'settings popup ' + (genPopup() ? 'open' : 'closed')
    ].join(', ');
  }

  const stepError = (step, why) => new Error(`Step "${step}" failed: ${why}`);

  // Explains which part of opening the generation settings went wrong
  function genSettingsProblem() {
    if (!genTrigger() && !chatBox()) return 'neither the prompt box nor its settings chip was found on the page';
    if (!genTrigger()) return 'the prompt box has no settings chip (the button Flow labels "Settings trigger"). This Flow layout may not have one, try "Flow agent chat" in How to drive Flow';
    return 'the settings chip was clicked but no settings popup appeared. Please press "Copy debug info" in the panel and send the result to the developer';
  }

  const popButtons = () => { const p = genPopup(); return p ? [...p.querySelectorAll('button,[role=tab],[role=radio]')].filter(visible) : []; };
  const hasWord = (el, word) => new RegExp('(^|\\s)' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)', 'i').test(norm(el.innerText));
  const isOnBtn = (b) => [b.getAttribute('aria-selected'), b.getAttribute('aria-checked'), b.getAttribute('aria-pressed')].includes('true') ||
    /^(on|checked|active|selected)$/.test(b.getAttribute('data-state') || '') || /(^|[\s_-])(selected|checked)([\s_-]|$)/i.test(b.className || '');

  async function popClick(word) {
    const b = popButtons().find((x) => hasWord(x, word));
    if (!b) return false;
    if (!isOnBtn(b)) { realClick(b); await sleep(350); }
    return true;
  }

  function popCredits() {
    const p = genPopup();
    const m = p && (p.innerText.match(/Generating will use\s+([\d,]+)\s+credits?/i) || p.innerText.match(/([\d,]+)\s+credits?\b/i));
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
  }

  // BulkGen makes videos only, so image models (Nano Banana, Imagen) never go in the list
  const isImageModel = (name) => /nano banana|imagen/i.test(name);

  // Switches the popup to Video and checks that it stuck, so the model menu lists video models
  async function selectVideo() {
    // Flow versions mark the selected button differently, so the model shown is the real check:
    // Veo or Omni means Video is on, Nano Banana or Imagen means Image is still on
    const videoOn = () => {
      const b = popButtons().find((x) => hasWord(x, 'Video'));
      const m = modelButton();
      if (m) return !isImageModel(cleanName(m.innerText));
      return !b || isOnBtn(b); // no model button: trust the switch, or a popup without one is video only
    };
    const b = popButtons().find((x) => hasWord(x, 'Video'));
    if (b && !isOnBtn(b)) { realClick(b); await sleep(600); }
    if (videoOn()) return true;
    const again = popButtons().find((x) => hasWord(x, 'Video'));
    if (again) { await trustedClick(again); await sleep(800); }
    return videoOn();
  }

  const cleanName = (s) => norm(s).replace(/^volume_up\s*/, '').replace(/\s*arrow_drop_down$/, '');
  const modelButton = () => popButtons().find((b) => /arrow_drop_down/.test(b.innerText));

  async function openModelMenu() {
    const b = modelButton();
    if (!b) return null;
    realClick(b);
    return waitFor(() => { const l = [...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=option]')].filter(visible); return l.length ? l : null; }, 2500);
  }

  async function chooseModel(name) {
    const want = name.toLowerCase();
    const current = () => (modelButton() ? cleanName(modelButton().innerText).toLowerCase() : '');
    if (current() === want) return true;
    const items = await openModelMenu();
    if (!items) return false;
    const it = items.find((e) => cleanName(e.innerText).toLowerCase() === want) || items.find((e) => cleanName(e.innerText).toLowerCase().includes(want));
    if (!it) { escape(); await sleep(300); return false; }
    realClick(it);
    await sleep(600);
    return current().includes(want);
  }

  // What the popup offers for the model that is selected right now
  function popOptions() {
    const labels = popButtons().map((b) => norm(b.innerText));
    const tokens = (re) => labels.map((l) => (l.match(re) || [])[1]).filter(Boolean);
    return {
      durations: tokens(/(?:^|\s)(\d+)s$/),
      resolutions: tokens(/(?:^|\s)(\d{3,4}p)\b/),
      aspects: tokens(/(?:^|\s)(\d+:\d+)$/),
      ingredients: labels.some((l) => /Ingredients$/.test(l)),
      frames: labels.some((l) => /Frames$/.test(l)),
      credits: popCredits()
    };
  }

  // Reads the video models Flow offers (and what each one supports) for the side panel
  async function readModels() {
    await goToGrid();
    await promptBoxToBottom();
    const agentOff = await setAgentMode(false);
    if (!agentOff || !(await openGenPopup())) {
      const why = agentOff ? genSettingsProblem() : 'clicked Flow\'s Agent toggle but it stayed on';
      const names = await readModelsFromSettings();
      if (!names.length) return { ok: false, error: `Could not read the models.\n\nStep "${agentOff ? 'Open the generation settings' : 'Turn off Flow\'s Agent mode'}" failed: ${why}.\nThe Settings panel had no model list either.\n\nPage: ${pageInfo()}` };
      const info = { models: names.map((name) => ({ name, durations: [], resolutions: [], aspects: [], ingredients: false, frames: false, credits: null, fromSettings: true })), layout: 'agent', at: Date.now() };
      await store.set('bg_models', info);
      return Object.assign({ ok: true }, info);
    }
    if (!(await selectVideo())) {
      await closeGenPopup();
      return { ok: false, error: `Could not read the models.\n\nStep "Switch Flow to Video" failed: clicked Video in the generation settings but Flow stayed on Image.\n\nPage: ${pageInfo()}` };
    }
    const startName = modelButton() ? cleanName(modelButton().innerText) : '';
    const items = await openModelMenu();
    const names = items ? items.map((e) => cleanName(e.innerText)).filter((n) => n && !isImageModel(n)) : [];
    escape();
    await sleep(400);
    const models = [];
    for (const n of names) {
      if (await chooseModel(n)) models.push(Object.assign({ name: n }, popOptions()));
    }
    if (startName) await chooseModel(startName);
    await closeGenPopup();
    const info = { models, at: Date.now() };
    await store.set('bg_models', info);
    return Object.assign({ ok: true }, info);
  }

  // Layouts without the settings chip in the prompt box keep the model list in the Settings panel.
  // Only the names can be read there, so length and resolution are left to the side panel defaults.
  async function readModelsFromSettings() {
    const panel = await openSettings();
    if (!panel) return [];
    const dd = [...panel.querySelectorAll('button[aria-haspopup]')].pop();
    let names = [];
    if (dd) {
      realClick(dd);
      const items = await waitFor(() => { const l = [...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=option]')].filter(visible); return l.length ? l : null; }, 2500);
      names = items ? items.map((e) => cleanName(e.innerText)).filter((n) => n && !isImageModel(n)) : [];
      escape();
      await sleep(400);
    }
    // close without saving
    const close = [...panel.querySelectorAll('button')].find((b) => /^(close|cancel)$/i.test(accName(b)));
    if (close) realClick(close); else escape();
    await sleep(400);
    return names;
  }

  async function applyPlainSettings(cfg) {
    await goToGrid();
    await promptBoxToBottom();
    if (!(await setAgentMode(false))) throw stepError("Turn off Flow's Agent mode", "clicked Flow's Agent toggle but it stayed on");
    if (!(await openGenPopup())) throw stepError('Open the generation settings', genSettingsProblem());
    const notes = [];
    if (!(await selectVideo())) throw stepError('Switch Flow to Video', 'clicked Video in the generation settings but Flow stayed on Image');
    await popClick('Ingredients');
    if (cfg.model && !(await chooseModel(cfg.model))) notes.push(`model "${cfg.model}" not found`);
    const o = popOptions();
    if (cfg.aspect && !(await popClick(cfg.aspect))) notes.push(`aspect ${cfg.aspect} not offered`);
    if (o.resolutions.length && cfg.resolution && !(await popClick(cfg.resolution))) notes.push(`${cfg.resolution} not offered`);
    if (o.durations.length) {
      if (!(await popClick(cfg.duration + 's'))) notes.push(`${cfg.duration}s not offered for this model`);
    } else {
      notes.push('this model has a fixed length');
    }
    if (cfg.count) await popClick('x' + cfg.count);
    await sleep(400);
    const credits = popCredits();
    const model = modelButton() ? cleanName(modelButton().innerText) : '?';
    await closeGenPopup();
    return { model, credits, notes, summary: genTrigger() ? norm(genTrigger().innerText).replace(/crop_\S+\s*/g, '') : '' };
  }

  // ----- reference images (Flow "Ingredients") -----
  // Only count what is in the prompt box: grid rows show reference thumbnails too
  function promptArea() {
    let p = chatBox();
    while (p && !p.querySelector('button[aria-label="Settings trigger"]')) p = p.parentElement;
    return p || document.createElement('div');
  }
  const ingredientCount = () => promptArea().querySelectorAll('img[alt="Ingredient image"]').length;

  function dataUrlToFile(r) {
    const [head, b64] = r.dataUrl.split(',');
    const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/png';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], r.name || 'reference.png', { type: mime });
  }

  // Flow takes files dropped on its "Add reference" zone (scripted file pickers are not possible)
  async function uploadRef(r, cfg) {
    const box = chatBox();
    if (!box) return 'prompt box not found';
    const before = ingredientCount();
    const dt = new DataTransfer();
    dt.items.add(dataUrlToFile(r));
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire(box, 'dragenter');
    fire(box, 'dragover');
    const zone = await waitFor(() => [...document.querySelectorAll('.drop-zone-label')].filter(visible).pop(), 3000);
    if (!zone) { fire(document.body, 'dragleave'); return 'Flow did not show its drop zone'; }
    fire(zone, 'dragenter');
    fire(zone, 'dragover');
    fire(zone, 'drop');
    const agree = await waitFor(() => {
      if (ingredientCount() > before) return 'done';
      if (!/Rights to use this image/i.test(document.body.innerText)) return null;
      return [...document.querySelectorAll('button')].find((b) => visible(b) && /^i agree$/i.test(norm(b.innerText))) || null;
    }, 10000);
    if (agree && agree !== 'done') {
      if (!cfg.refsRights) return 'rights';
      realClick(agree);
      await log(`Confirmed Flow's "Rights to use this image" for ${r.name} (you ticked the rights box in the panel).`);
    }
    const ok = await waitFor(() => ingredientCount() > before, 60000, 500);
    return ok ? '' : 'the image did not show up in the prompt box';
  }

  // Flow clears the prompt box references after every send. Images uploaded once stay in the
  // project library under their file name, so later prompts pick them from there (no duplicates).
  async function attachFromLibrary(name) {
    const before = ingredientCount();
    const add = document.querySelector('button[aria-label="Add ingredients to the prompt box"]');
    if (!add) return false;
    add.click(); // plain click: this picker opens on pointerdown and would close again on the click
    const findItem = () => [...document.querySelectorAll('button.asset-item')].find((b) => visible(b) && norm(b.innerText).startsWith(name));
    if (!(await waitFor(() => document.querySelector('button.asset-item'), 4000))) return false;
    let item = await waitFor(findItem, 1500);
    if (!item) {
      const search = [...document.querySelectorAll('input')].find((i) => visible(i) && /search assets/i.test(i.placeholder || ''));
      if (search) {
        search.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, name);
        search.dispatchEvent(new Event('input', { bubbles: true }));
        item = await waitFor(findItem, 4000);
      }
    }
    if (!item) { escape(); await sleep(400); return false; }
    item.click();
    await sleep(500);
    const ok = [...document.querySelectorAll('button')].find((b) => visible(b) && /^add to prompt$/i.test(norm(b.innerText)));
    if (!ok) { escape(); await sleep(400); return false; }
    ok.click();
    return !!(await waitFor(() => ingredientCount() > before, 15000, 400)); // the chip can take a while to appear
  }

  async function clearRefs() {
    for (let i = 0; i < 8 && ingredientCount(); i++) {
      const x = [...promptArea().querySelectorAll('button')].find((b) => norm(b.innerText) === 'cancel');
      if (!x) break;
      x.click();
      await sleep(400);
    }
  }

  // Image 1 goes with prompt 1, image 2 with prompt 2. Prompts past the last image get none.
  async function refsFor(cfg, idx) {
    if (!cfg.useRefs) return [];
    const refs = await store.get('bg_refs', []);
    return refs[idx] ? [refs[idx]] : [];
  }

  async function ensureRefs(refs, cfg, idx) {
    if (!refs.length) {
      // something left in the prompt box would end up in this video
      if (ingredientCount()) { await clearRefs(); await log(`Removed reference images left in the prompt box (prompt ${idx + 1} has none).`); }
      return '';
    }
    // What the box shows is not always what Flow will use (for example a reference restored after a
    // page reload is shown but ignored), so always start clean and add the references again.
    await clearRefs();
    run.uploaded = run.uploaded || {};
    for (const r of refs) {
      const what = `${r.label || r.name} for prompt ${idx + 1}`;
      await setStep(`Adding reference image ${what}`);
      if (await attachFromLibrary(r.name)) {
        if (!run.uploaded[r.name]) await log(`Reference image ${what} taken from the Flow library.`);
        run.uploaded[r.name] = true;
        continue;
      }
      // never upload the same image twice in a run, that only fills the library with copies
      if (run.uploaded[r.name]) return `${what}: uploaded earlier in this run but not found in the Flow library under the name ${r.name}`;
      const err = await uploadRef(r, cfg);
      if (err === 'rights') return err;
      if (err) return `${what}: ${err}`;
      run.uploaded[r.name] = true;
      await log(`Reference image ${what} uploaded to Flow and added to the prompt box.`);
    }
    await sleep(1000);
    if (ingredientCount() !== refs.length) {
      const n = ingredientCount();
      await clearRefs();
      return `the prompt box had ${n} reference images instead of ${refs.length}`;
    }
    return '';
  }

  // ----- sending in plain mode -----
  function tilesFor(i) {
    return gridTiles().filter((t) => (t.pending || t.isVideo) && t.prompt && textMatch(t.prompt, i) >= 0.85);
  }

  function toastText() {
    const els = document.querySelectorAll('[role=alert],[role=status],mat-snack-bar-container,.mat-mdc-snack-bar-label,[class*=snackbar],[class*=toast]');
    return [...els].map((e) => norm(e.innerText)).filter((t) => t && t.length < 300).join(' | ');
  }

  function buildPlainPrompt(cfg, p) {
    const dot = (s) => { s = s.trim(); return /[.!?]$/.test(s) ? s : s + '.'; };
    const parts = [];
    if (cfg.character && cfg.character.trim()) parts.push(dot(cfg.character));
    parts.push(dot(p));
    if (cfg.style && cfg.style.trim()) parts.push('Style: ' + dot(cfg.style));
    return parts.join(' ');
  }

  async function submitPlain(cfg, idx) {
    const item = run.items[idx];
    const label = `prompt ${idx + 1}`;
    const p = run.prompts[idx];
    item.text = buildPlainPrompt(cfg, p);
    await goToGrid();
    await promptBoxToBottom();
    if (!(await setAgentMode(false))) throw stepError("Turn off Flow's Agent mode", "clicked Flow's Agent toggle but it stayed on");
    const box = await waitFor(chatBox, 8000);
    if (!box) throw stepError('Find the prompt box', 'no prompt box on the page after 8 seconds. Is the Flow project page open?');
    const toTop = () => { const sc = gridScroller(); if (sc) sc.scrollTop = 0; };
    toTop();
    await sleep(500);

    // Retry or page reload: if a new tile for this prompt exists, it was sent already
    if (typeof item.tilesBefore === 'number' && tilesFor(idx).length > item.tilesBefore) {
      await log(`${label} is already generating in Flow, not sending it again.`);
      return { ok: true, cost: run.costPer || 0, note: 'found in the grid after a retry or reload' };
    }
    const summaryNow = () => (genTrigger() ? norm(genTrigger().innerText).replace(/crop_\S+\s*/g, '') : '');
    if (genTrigger() && run.summary && summaryNow() !== run.summary) {
      const was = summaryNow();
      const s2 = await applyPlainSettings(cfg);
      await log(`Flow settings changed (${was}), applied them again: ${s2.summary}.`, 'warn');
    }
    const refs = await refsFor(cfg, idx);
    const refErr = await ensureRefs(refs, cfg, idx);
    if (refErr === 'rights') {
      return { ok: false, fatal: true, reason: 'Flow asks you to confirm you have the rights to the reference image. Click "I agree" in Flow, or tick the rights box in the panel' };
    }
    if (refErr) throw stepError('Add reference image', refErr);

    item.tilesBefore = tilesFor(idx).length;
    item.status = 'sending';
    await saveRun();
    await setStep(`Sending ${label}`);
    const text = item.text;
    if (refs.length) await sleep(1200); // Flow redraws the box after adding references
    for (let i = 0; i < 3; i++) {
      setText(chatBox() || box, text);
      await sleep(500);
      if (sameText(boxText(), text)) break;
    }
    if (!sameText(boxText(), text)) throw stepError('Type the prompt', 'tried 3 times but the prompt box did not keep the text');
    const btn = await waitFor(() => {
      const b = submitButton();
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    }, 20000); // a fresh upload keeps it disabled for a few seconds
    if (!btn) throw stepError('Click Start generation', submitButton() ? 'the Start generation button stayed disabled for 20 seconds' : 'no Start generation button found next to the prompt box');
    if (refs.length && ingredientCount() !== refs.length) throw stepError('Check reference images', `the prompt box has ${ingredientCount()} reference images instead of ${refs.length}`);
    const t0 = Date.now();
    await trustedClick(btn);
    const started = () => { toTop(); return tilesFor(idx).length > item.tilesBefore; };
    let ok = await waitFor(started, 15000, 500);
    if (!ok && boxText() && sameText(boxText(), text)) {
      await log(`${label}: Start click did not register, clicking again.`, 'warn');
      const b = submitButton();
      if (b && !b.disabled) await trustedClick(b);
      ok = await waitFor(started, 15000, 500);
    }
    if (!ok && !boxText()) ok = await waitFor(started, 30000, 1000); // Flow took it, the tile is slow
    if (!ok) {
      const problem = pageProblem() || toastText();
      if (problem && CREDIT_RE.test(problem)) return { ok: false, fatal: true, reason: 'Flow says: ' + short(problem, 200) };
      return { ok: false, reason: problem ? 'Flow says: ' + short(problem, 160) : 'no generating tile appeared after clicking Start' };
    }
    await log(`Sent ${label} in ${((Date.now() - t0) / 1000).toFixed(1)}s: "${short(p, 70)}"`);
    if (refs.length) {
      // Flow empties the reference slots after a send; wait for that so the next prompt adds them again
      await waitFor(() => ingredientCount() === 0, 8000, 400);
      const tile = tilesFor(idx)[0];
      const row = tile && tile.tile.closest('.batch-container');
      if (row && !row.querySelector('img[alt="Ingredient image"]')) await log(`${label}: Flow does not show the reference image on this generation.`, 'warn');
    }
    return { ok: true, cost: run.costPer || 0 };
  }

  // ---------- generation (Flow agent chat) ----------
  function buildPrompt(cfg, p) {
    const parts = [];
    const dot = (s) => { s = s.trim(); return /[.!?]$/.test(s) ? s : s + '.'; };
    if (cfg.character && cfg.character.trim()) parts.push('Character and world notes (keep consistent): ' + dot(cfg.character));
    parts.push('Generate a video. ' + dot(p));
    if (cfg.style && cfg.style.trim()) parts.push('Style: ' + dot(cfg.style));
    if (cfg.duration) parts.push('Make it a ' + cfg.duration + '-second video clip.');
    return parts.join(' ');
  }

  // An open approval card from an earlier run or an abandoned prompt blocks nothing, but it can be
  // approved by mistake later. Reject it so the chat is clean before we send.
  async function clearOldCards(ourText) {
    for (const card of openCards()) {
      const p = cardPrompt(card);
      if (sameText(p, ourText)) continue;
      const ok = await clickCardOption(card, 'Reject');
      await log(`${ok ? 'Rejected' : 'Could not reject'} an unanswered approval card left from before ("${short(p.replace(/^generate a video\.\s*/i, ''), 60)}"). No credits were spent on it.`, ok ? 'warn' : 'error');
      await sleep(1500);
      await waitIdle(30000);
    }
  }

  // Watches the chat after our prompt: approves the card (within the cost cap) and waits for Flow to
  // confirm the video was scheduled. Returns { ok, cost } or { ok:false, reason, final, fatal }.
  // A generating tile in the grid whose prompt matches ours proves Flow started it
  function pendingTileFor(prompt) {
    const pw = keywords(prompt);
    if (!pw.length) return null;
    return gridTiles().find((t) => {
      if (!t.pending || !t.subtitle) return false;
      const have = new Set(keywords(t.subtitle));
      return pw.filter((w) => have.has(w)).length / pw.length >= 0.8;
    }) || null;
  }

  async function awaitOutcome(userRow, cfg, label, prompt) {
    const end = Date.now() + 120000;
    let approvedAt = 0;
    let cost = 0;
    let quietSince = 0;
    let note = '';
    while (Date.now() < end) {
      if (stopFlag) return { ok: false, reason: 'stopped' };
      const rows = rowsAfter(userRow);
      const agentRows = rows.filter((r) => !isUserRow(r));
      const card = rows.map((r) => r.querySelector('flow-permission-message')).filter(Boolean).pop();
      const scheduled = agentRows.find((r) => !r.querySelector('flow-permission-message') && (r.querySelector('flow-a2ui-video-option') || SCHEDULED_RE.test(rowText(r))));
      if (scheduled) {
        // the chat shows a thumbnail of each new video; its id is how we recognise the video later.
        // The thumbnail renders a moment after the text.
        const ids = () => { const l = [...scheduled.querySelectorAll('flow-a2ui-video-option img')].map(mediaIdOf).filter(Boolean); return l.length ? l : null; };
        const mediaIds = (await waitFor(ids, 1500)) || [];
        return { ok: true, cost, note, mediaIds };
      }

      const problem = agentRows.map(rowText).find((t) => CREDIT_RE.test(t)) || pageProblem();
      if (problem) return { ok: false, fatal: true, reason: 'Flow says: ' + short(problem, 200) };

      if (card && cardOpen(card)) {
        const info = cardInfo(card);
        cost = info.cost;
        if (info.isImage) {
          await clickCardOption(card, 'Reject');
          return { ok: false, reason: 'the agent offered an image instead of a video, rejected it' };
        }
        const cap = parseInt(cfg.maxCredits, 10) || 0;
        if (cap && info.perVideo > cap) {
          await clickCardOption(card, 'Reject');
          return { ok: false, final: true, reason: `cost ${info.perVideo} credits per video is above your cap of ${cap}, rejected (nothing spent)` };
        }
        await setStep(`Approving ${label} (${info.cost} credits)`);
        const ok = await clickCardOption(card, 'Approve');
        if (!ok) return { ok: false, reason: 'clicked Approve but the card did not accept it' };
        approvedAt = Date.now();
        await log(`Approved ${label}: ${info.count} video${info.count > 1 ? 's' : ''}, ${info.cost} credits.`);
        continue;
      }
      if (card && !cardOpen(card)) {
        const choice = cardChoice(card);
        if (choice === 'reject') return { ok: false, final: true, reason: 'the approval card was rejected' };
        if (!choice) return { ok: false, reason: 'the approval card closed without an answer' };
        if (!approvedAt) { approvedAt = Date.now(); cost = cardInfo(card).cost; note = 'card was already approved'; }
        await setStep(`Waiting for Flow to confirm ${label} is scheduled`);
        if (pendingTileFor(prompt)) return { ok: true, cost, note: (note ? note + ', ' : '') + 'confirmed by its tile in the grid' };
        // e.g. the page reloaded right after Approve: the agent never answered and nothing is generating
        if (!agentBusy() && Date.now() - approvedAt > 30000) {
          return { ok: false, resend: true, reason: 'approved, but Flow did not start the video (no reply and no generating tile)' };
        }
      } else {
        await setStep(`Waiting for the agent to answer ${label}`);
      }
      // The agent replied with something we do not understand (a question, an error) and went quiet
      if (!agentBusy() && agentRows.length && !card) {
        if (!quietSince) quietSince = Date.now();
        if (Date.now() - quietSince > 20000) {
          const t = rowText(agentRows[agentRows.length - 1]);
          if (pendingTileFor(prompt)) return { ok: true, cost, note: 'confirmed by its tile in the grid' };
          // Seen on the real site: the agent says "I will generate ..." and then stops without a card.
          // Nothing was started, so sending the prompt again is safe.
          return { ok: false, resend: true, reason: 'the agent stopped after replying "' + short(t.replace(/thumb_up.*$/, ''), 120) + '" without starting anything' };
        }
      } else {
        quietSince = 0;
      }
      await sleep(600);
    }
    return { ok: false, reason: approvedAt ? 'approved, but Flow never confirmed the video was scheduled' : 'no reply from the agent after 2 minutes' };
  }

  async function submitOne(cfg, idx) {
    const item = run.items[idx];
    const label = `prompt ${idx + 1}`;
    await goToGrid();
    const box = await waitFor(chatBox, 8000);
    if (!box) throw new Error('Prompt box not found. Is the Flow project page open?');
    if (!(await waitIdle())) throw new Error('the Flow agent stayed busy for 90 seconds');
    const text = buildPrompt(cfg, run.prompts[idx]);
    item.text = text;

    // Retry or page reload: if this prompt already reached the chat, never send it again
    let row = null;
    if (typeof item.sentBefore === 'number') {
      const rows = userRowsMatching(text);
      if (rows.length > item.sentBefore) {
        row = rows[rows.length - 1];
        await log(`${label} is already in the chat, not sending it again. Checking its approval.`);
      }
    }

    if (!row) {
      await clearOldCards(text);
      item.sentBefore = userRowsMatching(text).length;
      item.status = 'sending';
      await saveRun();
      await setStep(`Sending ${label}`);
      setText(box, text);
      await sleep(400);
      const btn = await waitFor(() => {
        const b = submitButton();
        return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
      }, 5000);
      if (!btn) throw new Error('Start generation button stayed disabled');
      const t0 = Date.now();
      await trustedClick(btn);
      const appeared = () => { const r = userRowsMatching(text); return r.length > item.sentBefore ? r[r.length - 1] : null; };
      row = await waitFor(appeared, 12000, 300);
      if (!row && boxText() && sameText(boxText(), text)) {
        // the text is still in the box and not in the chat: the click did not land, click once more
        await log(`${label}: Start click did not register, clicking again.`, 'warn');
        const b = submitButton();
        if (b && !b.disabled) await trustedClick(b);
        row = await waitFor(appeared, 12000, 300);
      }
      if (!row) throw new Error('the prompt did not show up in the chat after clicking Start');
      await log(`Sent ${label} in ${((Date.now() - t0) / 1000).toFixed(1)}s: "${short(run.prompts[idx], 70)}"`);
    }
    item.status = 'sent';
    await saveRun();
    return awaitOutcome(row, cfg, label, run.prompts[idx]);
  }

  // ---------- downloading ----------
  function slug(s) { return norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'video'; }

  function detachDebugger() { if (HAS_CHROME) sendBg({ type: 'bulkgen-detach' }); }

  async function dlState(name) {
    const all = await store.get('bg_dl', {});
    return all[name] || null;
  }

  function promptOnPage() {
    return [...document.querySelectorAll('span.text-part')].map((e) => norm(e.innerText)).join(' ');
  }

  function openedTitle() {
    const t = document.querySelector('input[type=text]');
    return t && t.value ? t.value : '';
  }

  // Stable media id from Flow image URLs like .../image/<uuid>
  function mediaIdOf(img) {
    const m = ((img && (img.getAttribute('src') || img.src)) || '').match(/\/image\/([0-9a-f]{8}-[0-9a-f-]{27})/i);
    return m ? m[1].toLowerCase() : '';
  }

  // The edit page has a strip of thumbnails; the active one is the video on screen
  function currentMediaId() {
    const b = document.querySelector('.thumbnail-button[aria-current="true"],.thumbnail-button.active');
    return b ? mediaIdOf(b.querySelector('img')) : '';
  }

  function waitingFor(it, i) {
    if (!['queued', 'sent'].includes(it.status) && !(['failed', 'skipped'].includes(it.status) && it.lateOk)) return false;
    return (it.ready || 0) < (it.count || 1);
  }

  const keywords = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2 && !/^(the|and|with|for|from|into|over|under|its|this|that|style|video|generate|make|second|clip|cinematic|realistic)$/.test(w));

  // Cheap check before opening a tile: Flow titles are short summaries of the prompt
  function titleLooksOurs(title) {
    const tw = keywords(title);
    if (!tw.length) return true;
    return run.items.some((it, i) => {
      if (!waitingFor(it, i)) return false;
      const pw = new Set(keywords(run.prompts[i]));
      return tw.filter((w) => pw.has(w)).length / tw.length >= 0.5;
    });
  }

  // Which of our queued prompts does this video belong to? First by the media id we saw in the chat,
  // then (only for prompts whose id we never saw) by the prompt text Flow shows on the edit page.
  function matchItem(pagePrompt, mediaId, anyText) {
    if (mediaId) {
      const owner = run.items.findIndex((it) => (it.mediaIds || []).includes(mediaId));
      if (owner >= 0) return waitingFor(run.items[owner], owner) ? owner : -1;
    }
    let best = -1;
    let bestScore = 0;
    run.items.forEach((it, i) => {
      if (!waitingFor(it, i)) return;
      if (!anyText && (it.mediaIds || []).length >= (it.count || 1)) return; // its video has a known id, and this is not it
      const score = textMatch(pagePrompt, i);
      // ties go to the prompt that was queued first
      if (score > bestScore + 0.001 || (Math.abs(score - bestScore) < 0.001 && best >= 0 && (it.queuedAt || 0) < (run.items[best].queuedAt || 0))) {
        best = i; bestScore = score;
      }
    });
    return bestScore >= 0.85 ? best : -1;
  }

  // How well a prompt shown by Flow matches prompt i, checked both ways: all words of our prompt must be
  // there, and the shown text must not hold words we never sent (prompts that share a subject differ there).
  function textMatch(shown, i) {
    const cover = (a, b) => { const A = keywords(a); if (!A.length) return 0; const B = new Set(keywords(b)); return A.filter((w) => B.has(w)).length / A.length; };
    const sent = (run.items[i] && run.items[i].text) || run.prompts[i];
    return Math.min(cover(run.prompts[i], shown), cover(shown, sent));
  }

  async function openTile(t) {
    realClick(t.el);
    let opened = await waitFor(() => /\/edit\//.test(location.pathname), 4000);
    if (!opened) { await trustedClick(t.el); opened = await waitFor(() => /\/edit\//.test(location.pathname), 6000); }
    return !!opened;
  }

  // Opens Flow's Download media menu and clicks the wanted quality. Returns { q, why }: q is the
  // quality clicked ('' when nothing was clicked) and why says what went wrong.
  // 1080p falls back to 720p when Flow shows it greyed out (accounts without the upscale plan).
  async function clickDownload(name, title, quality) {
    const btn = document.querySelector('button[aria-label="Download media"]') || findClickable(/^download media$/i);
    if (!btn) return { q: '', why: 'Flow shows no Download button on this video' };
    const menu = () => { const l = [...document.querySelectorAll('[role=menuitem]')].filter(visible); return l.length ? l : null; };
    // Real clicks here: Chrome holds back repeated downloads that do not come from a user gesture
    await trustedClick(btn);
    let items = await waitFor(menu, 3000);
    if (!items) { realClick(btn); items = await waitFor(menu, 3000); }
    if (!items) return { q: '', why: "Flow's Download menu did not open" };
    await sleep(600); // let the menu finish its open animation, a click during it misses the item
    items = menu() || items;
    const usable = items.filter((e) => !e.disabled && e.getAttribute('aria-disabled') !== 'true' && !/menu-item-disabled/.test(e.className));
    const find = (re) => usable.find((e) => re.test(accName(e)));
    let q = quality;
    let choice = quality === '1080p' ? find(/1080/) : null;
    if (!choice) { q = '720p'; choice = find(/720|original/i); }
    if (!choice) { realClick(btn); return { q: '', why: "Flow's Download menu has no 720p item" }; }
    await sendBg({ type: 'bulkgen-expect-download', filename: name, title, waitMs: (q === '1080p' ? 30 : 10) * 60000 });
    await trustedClick(choice);
    return { q, why: '' };
  }

  // Waits until Chrome has saved the file and shows what is going on meanwhile.
  // Returns 'complete', 'stopped', 'not-started' or what went wrong.
  async function waitForFile(name, q, label) {
    const t0 = Date.now();
    const startLimit = (q === '1080p' ? 10 : 1) * 60000; // Flow upscales first, the file starts after that
    let startedAt = 0;
    const took = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    while (!stopFlag) {
      const st = await dlState(name);
      const state = st && st.state;
      if (state === 'complete') return 'complete';
      if (state === 'interrupted') return 'the browser reported ' + (st.error || 'an error');
      if (state === 'in_progress') {
        if (!startedAt) startedAt = Date.now();
        // ask Chrome directly too, in case a change event was missed
        const info = await sendBg({ type: 'bulkgen-dl-info', filename: name });
        if (info.ok && info.state === 'complete') return 'complete';
        if (info.ok && info.state === 'interrupted') return 'the browser reported ' + (info.error || 'an error');
        const mb = info.ok && info.got ? ` ${(info.got / 1048576).toFixed(1)}${info.total > 0 ? ' of ' + (info.total / 1048576).toFixed(1) : ''} MB` : '';
        await setStep(`${label}: downloading${mb} (${took(startedAt)})`);
        if (Date.now() - startedAt > 10 * 60000) return 'the download did not finish in 10 minutes';
      } else {
        await setStep(`${label}: ${q === '1080p' ? 'Flow is upscaling it to 1080p' : 'waiting for the file to start'} (${took(t0)})`);
        if (Date.now() - t0 > startLimit) return 'not-started';
      }
      await sleep(1000);
    }
    return 'stopped';
  }

  async function processTile(cfg, t) {
    run.seen.push(t.key);
    if (!(await openTile(t))) {
      run.seen.pop();
      await log(`Could not open the finished video "${short(t.title, 40)}", will try again.`, 'warn');
      return;
    }
    const editId = (location.pathname.match(/\/edit\/([0-9a-f-]+)/i) || [])[1] || '';
    await sleep(1200);
    const isVideoPage = await waitFor(() => document.querySelector('button[aria-label="Play"],button[aria-label="Pause"],button[aria-label="Skip to next clip"]'), 6000);
    if (!isVideoPage) { await log(`"${short(t.title, 40)}" is not a video, skipped.`); return; }
    if (run.doneEdits.includes(editId)) return; // same video under a new thumbnail URL
    const pagePrompt = await waitFor(promptOnPage, 4000) || '';
    const mediaId = await waitFor(currentMediaId, 3000) || '';
    const idx = matchItem(pagePrompt, mediaId);
    if (idx < 0) {
      run.doneEdits.push(editId);
      await log(`Skipped "${short(t.title, 40)}": it does not match any waiting prompt of this run.`);
      return;
    }
    await markReady(idx, editId);
  }

  // A run does not download: it notes that the video for prompt idx is ready in Flow.
  // The "Download all videos of this project" button saves them.
  async function markReady(idx, editId) {
    const item = run.items[idx];
    if (item.status === 'failed' || item.status === 'skipped') {
      // Flow made it after all: count it as a success instead
      run.failed = Math.max(0, run.failed - 1);
      item.lateOk = false;
      await log(`Prompt ${idx + 1} arrived late after being marked ${item.status}, counting it as ready.`, 'warn');
    }
    run.doneEdits.push(editId);
    item.ready = (item.ready || 0) + 1;
    if (item.ready >= (item.count || 1)) { item.status = 'done'; item.doneAt = Date.now(); }
    run.ready = (run.ready || 0) + 1;
    progress();
    await log(`Prompt ${idx + 1} finished${item.queuedAt ? ' after ' + Math.round((Date.now() - item.queuedAt) / 60000 * 10) / 10 + ' min' : ''}. The video is ready in Flow.`);
  }

  // Look at the grid: count generating tiles, catch failed ones and note finished ones as ready.
  async function harvest(cfg) {
    await goToGrid();
    await sleep(800);
    // fill in media ids the chat had not drawn yet when the prompt was queued
    for (const [i, it] of run.items.entries()) {
      if (it.status === 'queued' && (it.mediaIds || []).length < (it.count || 1)) {
        const ids = chatMediaIds(buildPrompt(cfg, run.prompts[i]));
        if (ids.length) it.mediaIds = ids;
      }
    }
    let did = 0;
    let fullScan = false;
    for (let pass = 0; pass < 40 && !stopFlag && !pauseFlag; pass++) {
      const scroller = gridScroller();
      if (scroller) scroller.scrollTop = 0;
      await sleep(500);
      let target = null;
      let generating = 0;
      for (let screen = 0; screen < 8 && !target; screen++) {
        const tiles = gridTiles();
        let unknown = 0;
        for (const t of tiles) {
          if (run.seen.includes(t.key)) continue;
          if (t.pending) { generating++; continue; }
          if (t.isImage) { run.seen.push(t.key); continue; }
          if (t.failed) {
            run.seen.push(t.key);
            const idx = matchItem(t.subtitle || t.text, '', true);
            if (idx >= 0) {
              const it = run.items[idx];
              it.status = 'failed';
              it.note = 'Flow could not generate it';
              run.failed += 1;
              progress();
              await log(`Flow could not generate prompt ${idx + 1}: "${short(t.text.replace(/play_circle|keyboard_return/g, ''), 120)}"`, 'error');
            }
            continue;
          }
          if (t.isVideo && t.src && t.prompt) {
            // list view shows the prompt, so we know right away whether the video is ours
            if (matchItem(t.prompt, '') >= 0) { target = t; break; }
            run.seen.push(t.key);
            continue;
          }
          if (t.isVideo && t.src) {
            if (fullScan || titleLooksOurs(t.title)) { target = t; break; }
            // older video that has nothing to do with this run
            run.seen.push(t.key);
            run.skippedByTitle = (run.skippedByTitle || []).concat(t.key).slice(-500);
            continue;
          }
          unknown++;
        }
        if (target || !scroller) break;
        if (screen > 0 && unknown === 0 && !tiles.some((t) => !run.seen.includes(t.key))) break;
        const before = scroller.scrollTop;
        scroller.scrollTop += scroller.clientHeight * 0.9;
        await sleep(600);
        if (scroller.scrollTop === before) break; // reached the bottom
      }
      run.generating = generating;
      if (!target && !fullScan && generating === 0 && inFlight() > 0 && Date.now() - (run.fullScanAt || 0) > 120000) {
        // Flow shows nothing generating but we still wait for videos: maybe a title did not resemble
        // its prompt. Look at every unknown tile once.
        run.fullScanAt = Date.now();
        const skipped = new Set(run.skippedByTitle || []);
        run.seen = run.seen.filter((k) => !skipped.has(k));
        run.skippedByTitle = [];
        fullScan = true;
        await log('Nothing is generating but some videos are still missing, checking every new tile.');
        continue;
      }
      if (!target) break;
      const rowIdx = target.prompt ? matchItem(target.prompt, '') : -1;
      // list view shows the prompt, so a single video can be noted as ready without opening it
      if (rowIdx >= 0 && (run.items[rowIdx].count || 1) === 1) { run.seen.push(target.key); await markReady(rowIdx, 'row:' + target.key); }
      else await processTile(cfg, target);
      did++;
      await saveRun();
      await goToGrid();
      await sleep(cfg.downloadGapMs || 800);
    }
    await saveRun();
    return did;
  }

  // ---------- download all videos of the project ----------
  // Nothing downloads during a run. This goes through every finished video in the project grid, saves it
  // at the chosen quality (1080p goes through Flow's upscale) and skips videos saved earlier.
  let downloadingAll = false;

  async function collectVideoTiles() {
    await goToGrid();
    const sc = gridScroller();
    if (sc) { sc.scrollTop = 0; await sleep(600); }
    const found = new Map();
    for (let i = 0; i < 300 && !stopFlag; i++) {
      for (const t of gridTiles()) if (t.isVideo && t.src && !t.pending && !t.failed && !found.has(t.key)) found.set(t.key, t.title);
      if (!sc) break;
      const before = sc.scrollTop;
      sc.scrollTop += sc.clientHeight * 0.9;
      await sleep(600);
      if (sc.scrollTop === before) break;
    }
    return [...found.keys()];
  }

  async function findTile(key) {
    const sc = gridScroller();
    if (sc) { sc.scrollTop = 0; await sleep(500); }
    for (let i = 0; i < 300 && !stopFlag; i++) {
      const t = gridTiles().find((x) => x.key === key);
      if (t) { t.el.scrollIntoView({ block: 'center' }); await sleep(300); return gridTiles().find((x) => x.key === key) || t; }
      if (!sc) return null;
      const before = sc.scrollTop;
      sc.scrollTop += sc.clientHeight * 0.9;
      await sleep(500);
      if (sc.scrollTop === before) return null;
    }
    return null;
  }

  // Which prompt of the last run this video belongs to, so it keeps the flow_001 numbering
  function promptIndexFor(shown) {
    if (!run || !run.prompts || !run.prompts.length || !shown) return -1;
    let best = -1;
    let bestScore = 0;
    run.prompts.forEach((p, i) => { const sc = textMatch(shown, i); if (sc > bestScore) { best = i; bestScore = sc; } });
    return bestScore >= 0.85 ? best : -1;
  }

  async function downloadAll() {
    downloadingAll = true;
    stopFlag = false;
    try {
      const cfg = await store.get('bg_cfg', {});
      const quality = cfg.quality || '720p';
      const project = (location.pathname.match(/\/project\/([0-9a-f-]+)/i) || [])[1] || 'unknown';
      if (!run) run = { running: false, log: [], items: [], prompts: [], startedAt: Date.now() };
      run.dl = { running: true, total: 0, saved: 0, failed: 0, skipped: 0 };
      await log(`Downloading all videos of this project in ${quality}${quality === '1080p' ? ' (Flow upscales each one first, this can take a few minutes per video)' : ''}, one video at a time.`);
      await setStep('Finding the videos in this project');
      const savedAll = await store.get('bg_saved', {});
      const saved = new Set(savedAll[project] || []); // edit ids of videos saved earlier
      const keys = await collectVideoTiles();
      run.dl.total = keys.length;
      await log(`Found ${keys.length} finished video${keys.length === 1 ? '' : 's'} in the project.`);
      let toldNo1080 = false;
      // one video at a time: the next one starts only after this file is saved or given up
      for (const [n, key] of keys.entries()) {
        if (stopFlag) break;
        const label = `Video ${n + 1} of ${keys.length}`;
        await setStep(`${label}: opening it`);
        await goToGrid();
        const t = await findTile(key);
        if (!t) { run.dl.failed++; await log(`${label}: could not find it in the grid again, skipped.`, 'warn'); continue; }
        if (!(await openTile(t))) { run.dl.failed++; await log(`${label}: could not open it, skipped.`, 'warn'); continue; }
        await sleep(1200);
        const editId = (location.pathname.match(/\/edit\/([0-9a-f-]+)/i) || [])[1] || key;
        if (saved.has(editId)) { run.dl.skipped++; await saveRun(); continue; }
        const title = openedTitle() || t.title || 'video';
        const idx = promptIndexFor(await waitFor(promptOnPage, 4000) || '');
        const name = idx >= 0
          ? `${cfg.prefix || 'flow'}_${String(idx + 1).padStart(3, '0')}_${slug(title)}.mp4`
          : `${cfg.prefix || 'flow'}_${slug(title)}_${editId.slice(0, 6)}.mp4`;
        const tries = Math.max(1, parseInt(cfg.downloadRetries, 10) || 3);
        let result = '';
        let q = '';
        for (let i = 0; i < tries && !stopFlag; i++) {
          if (i) { await log(`${label}: trying again (${i + 1} of ${tries}).`, 'warn'); await sleep(1500); }
          await setStep(`${label}: clicking Download`);
          await store.set('bg_dl_active', Date.now() + 45 * 60000); // runs out by itself if the tab is closed
          const c = await clickDownload(name, title, quality);
          if (!c.q) { result = c.why; continue; }
          q = c.q;
          if (q !== quality && !toldNo1080) {
            toldNo1080 = true;
            await log('1080p is greyed out in Flow on this account (it asks to upgrade), so the videos are saved in 720p.', 'warn');
          }
          if (!i) await log(`${label}: ${q === '1080p' ? 'Flow is upscaling it to 1080p, then it downloads' : 'downloading'} as ${name}.`);
          result = await waitForFile(name, q, label);
          // a download that started but is slow is not clicked again, that would only make a second copy
          if (result === 'complete' || result === 'stopped' || /did not finish/.test(result)) break;
        }
        if (result !== 'complete') await sendBg({ type: 'bulkgen-expect-clear' });
        if (result === 'complete') {
          run.dl.saved++;
          saved.add(editId);
          savedAll[project] = [...saved];
          await store.set('bg_saved', savedAll);
          await log(`${label}: saved Downloads/BulkGen/${name} (${q}).`);
        } else if (result !== 'stopped' && !stopFlag) {
          run.dl.failed++;
          const why = result === 'not-started'
            ? 'no file arrived. If Chrome asks whether flow.google.com may download multiple files, choose Allow'
            : result;
          await log(`${label}: not saved, ${why}. Click "Download all videos of this project" again later to retry it.`, 'error');
        }
        await saveRun();
      }
      await goToGrid();
      const d = run.dl;
      await log(`${stopFlag ? 'Download stopped' : 'Download finished'}. ${d.saved} saved, ${d.skipped} saved earlier and skipped, ${d.failed} failed.`);
      run.step = stopFlag ? 'Stopped' : 'Download finished';
      detachDebugger();
    } catch (e) {
      await log(`Download stopped by an error: ${e.message}. Page: ${pageInfo()}`, 'error');
    } finally {
      await store.set('bg_dl_active', 0);
      await sendBg({ type: 'bulkgen-expect-clear' });
      if (run && run.dl) run.dl.running = false;
      if (run) await saveRun();
      downloadingAll = false;
    }
  }

  // ---------- main loop ----------
  const inFlight = () => run.items.filter((it) => it.status === 'queued' || it.status === 'sent').length;
  const settled = (it) => ['done', 'failed', 'skipped'].includes(it.status);

  async function pauseWithProblem(text) {
    pauseFlag = true;
    run.paused = true;
    run.stuck = text + ' The run is paused. Fix it in Flow, then click Resume.';
    await log(run.stuck, 'error');
  }

  async function mainLoop() {
    if (looping) return;
    looping = true;
    try {
      while (run && run.running && !stopFlag) {
        const cfg = await store.get('bg_cfg', {});
        if (pauseFlag) { await setStep('Paused'); await sleep(1000); continue; }
        if (!navigator.onLine) { await setStep('Waiting for the network to come back'); await sleep(3000); continue; }
        // stay on the project the run started in
        if (run.project && !location.pathname.startsWith(run.project)) {
          await log(`Flow moved to another page (${location.pathname.replace(/[0-9a-f-]{36}/gi, 'ID')}), going back to the project.`, 'warn');
          location.assign(location.origin + run.project);
          await sleep(20000);
          continue;
        }
        const problem = pageProblem();
        if (problem) { await pauseWithProblem('Flow says: ' + short(problem, 200) + '.'); continue; }

        const total = run.prompts.length;
        const maxAtOnce = Math.max(1, parseInt(cfg.maxInFlight, 10) || 2);

        if (run.next < total && inFlight() < maxAtOnce) {
          const idx = run.next;
          const item = run.items[idx];
          let res;
          try {
            res = cfg.engine === 'agent' ? await submitOne(cfg, idx) : await submitPlain(cfg, idx);
          } catch (e) {
            res = { ok: false, reason: e.message };
          }
          if (stopFlag) break;
          if (res.ok) {
            item.status = 'queued';
            item.queuedAt = Date.now();
            item.cost = res.cost || 0;
            item.mediaIds = res.mediaIds || [];
            run.next += 1;
            run.credits = (run.credits || 0) + (res.cost || 0);
            progress();
            await log(`Queued prompt ${idx + 1} of ${total}${res.cost ? ' (' + res.cost + ' credits)' : ''}${res.note ? ', ' + res.note : ''}. ${inFlight()} generating.`);
            await saveRun();
            await sleep(cfg.submitGapMs || 2500);
          } else if (res.fatal) {
            item.status = 'pending';
            await pauseWithProblem(res.reason + '.');
            await saveRun();
          } else {
            item.tries = (item.tries || 0) + 1;
            const maxTries = Math.max(1, parseInt(cfg.retries, 10) || 3);
            await log(`Prompt ${idx + 1} try ${item.tries} of ${maxTries} failed: ${res.reason}. Page: ${pageInfo()}`, 'warn');
            if (res.resend) {
              delete item.sentBefore; // safe to send it again on the next try
              await log(`Prompt ${idx + 1} will be sent again on the next try.`);
            }
            if (res.final || item.tries >= maxTries) {
              item.status = 'skipped';
              item.note = res.reason;
              item.lateOk = !res.final; // if Flow makes it anyway, still download it
              run.next += 1;
              run.failed += 1;
              progress();
              await log(`Skipped prompt ${idx + 1}: ${res.reason}.`, 'error');
            } else {
              item.status = 'pending';
            }
            await saveRun();
            await sleep(3000);
          }
          continue;
        }

        const waiting = inFlight() > 0 || run.items.some((it) => it.status === 'sending');
        if (waiting) {
          await setStep(`${inFlight()} generating. Checking the grid.`);
          const got = await harvest(cfg);
          // timeout guard: free slots that never finish
          const limit = (parseInt(cfg.timeoutMin, 10) || 15) * 60000;
          for (const [i, it] of run.items.entries()) {
            if (it.status === 'queued' && it.queuedAt && Date.now() - it.queuedAt > limit) {
              it.status = 'failed';
              it.note = 'timed out';
              it.lateOk = true;
              run.failed += 1;
              progress();
              await log(`Prompt ${i + 1} has not finished after ${limit / 60000} minutes. Counting it as failed and moving on.`, 'error');
            }
          }
          // stuck message for the panel
          const idle = Date.now() - (run.lastProgress || run.startedAt);
          if (idle > 8 * 60000 && !run.stuck) {
            run.stuck = `No progress for ${Math.round(idle / 60000)} minutes. Last step: ${run.step || 'unknown'}. ${run.generating || 0} tiles still generating in Flow.`;
            await log(run.stuck, 'warn');
          }
          await saveRun();
          if (!got) await sleep(cfg.pollMs || 7000);
          continue;
        }
        if (run.items.every(settled) || run.next >= total) break;
        await sleep(1000);
      }
      if (run && run.running && !stopFlag) {
        run.running = false;
        run.finished = true;
        run.step = 'Finished';
        await log(`All done. ${run.ready || 0} videos ready in Flow, ${run.failed} failed or skipped, about ${run.credits || 0} credits used. Click "Download all videos of this project" to save them.`);
        await saveRun();
        detachDebugger();
      }
    } catch (e) {
      await log(`Run stopped by an error: ${e.message}. Page: ${pageInfo()}`, 'error');
      if (run) { run.running = false; run.stuck = 'Stopped by an error: ' + e.message; await saveRun(); }
    } finally {
      looping = false;
    }
  }

  async function startRun(limit) {
    if (run && run.running && looping) return { ok: false, error: 'A run is already going. Stop it first.' };
    if (downloadingAll) return { ok: false, error: 'BulkGen is downloading the project videos. Wait until that is finished.' };
    const cfg = await store.get('bg_cfg', {});
    let prompts = (cfg.prompts || []).filter((p) => p && p.trim());
    if (limit) prompts = prompts.slice(0, limit);
    if (!prompts.length) return { ok: false, error: 'Add at least one prompt.' };
    if (!/^(\/u\/\d+)?\/project\//.test(location.pathname)) return { ok: false, error: 'Open a Flow project page first.' };
    stopFlag = false; pauseFlag = false;
    run = { running: true, log: [], items: [], prompts: [], startedAt: Date.now(), step: 'Starting' };
    await log(`Starting ${prompts.length} prompt${prompts.length > 1 ? 's' : ''} (${cfg.engine === 'agent' ? 'Flow agent' : 'plain mode'}), ${cfg.maxInFlight || 2} at once, ${cfg.model || 'current model'}, ${cfg.duration}s, cap ${cfg.maxCredits || 'none'} credits per video${cfg.useRefs ? ', reference image N with prompt N' : ''}.`);
    await goToGrid();
    // wait until the grid has finished drawing so existing media is not mistaken for new output
    let existing = [];
    let stable = 0;
    for (let i = 0; i < 16 && stable < 3; i++) {
      await sleep(600);
      const keys = gridTiles().map((t) => t.key);
      stable = keys.length === existing.length ? stable + 1 : 0;
      existing = keys;
    }
    const pm = location.pathname.match(/^(\/u\/\d+)?\/project\/[0-9a-f-]+/i);
    const count = Math.max(1, parseInt(cfg.count, 10) || 1);
    Object.assign(run, {
      finished: false, paused: false, prompts, next: 0, failed: 0, credits: 0,
      items: prompts.map(() => ({ status: 'pending', tries: 0, files: [], count })),
      ready: 0, seen: existing, doneEdits: [], project: pm ? pm[0] : '',
      lastProgress: Date.now(), stuck: '', generating: 0
    });
    await saveRun();
    if (cfg.engine === 'agent') {
      if (await setAgentMode(true) === false) await log('Could not turn on Flow\'s Agent mode.', 'warn');
      if (cfg.confirmNever || cfg.model) await log(await applyFlowSettings({ model: cfg.model, aspect: cfg.aspect, count: cfg.count, confirmNever: cfg.confirmNever ? true : undefined }));
    } else {
      let s1;
      try { s1 = await applyPlainSettings(cfg); } catch (e) {
        await log(`Could not set up Flow before the first prompt. ${e.message}. Page: ${pageInfo()}`, 'error');
        run.running = false; run.stuck = 'Could not set up Flow. ' + e.message; await saveRun();
        return { ok: false, error: `Could not set up Flow before the first prompt.\n\n${e.message}.\n\nPage: ${pageInfo()}` };
      }
      run.costPer = s1.credits || 0;
      run.summary = s1.summary;
      const perVideo = s1.credits ? Math.round(s1.credits / count) : 0;
      if (s1.credits == null && parseInt(cfg.maxCredits, 10)) await log('Flow did not show a credit estimate, so the credit cap cannot be checked before sending.', 'warn');
      await log(`Flow set to ${s1.model}: ${s1.summary}. Flow estimates ${s1.credits == null ? 'unknown' : s1.credits} credits per prompt.${s1.notes.length ? ' Note: ' + s1.notes.join(', ') + '.' : ''}`);
      const cap = parseInt(cfg.maxCredits, 10) || 0;
      if (cap && perVideo > cap) {
        run.running = false; run.step = 'Stopped';
        run.stuck = `Flow estimates ${perVideo} credits per video, above your cap of ${cap}. Nothing was sent. Raise the cap or pick a cheaper model.`;
        await log(run.stuck, 'error');
        await saveRun();
        return { ok: false, error: run.stuck };
      }
    }
    mainLoop();
    return { ok: true };
  }

  // ---------- debug info ----------
  // A text snapshot of the parts of the page BulkGen depends on, for users to send when something fails.
  // It lists field placeholders, button labels and the settings popup, never prompt text or account details.
  async function debugInfo() {
    const lines = ['BulkGen debug info', 'Page: ' + pageInfo(), 'Window: ' + innerWidth + 'x' + innerHeight, ''];
    lines.push('Text fields:');
    for (const el of [...document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable="plaintext-only"],[role=textbox],input[type=text]')].filter(visible)) {
      lines.push(`  ${el.tagName.toLowerCase()} placeholder="${el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-placeholder') || ''}" label="${el.getAttribute('aria-label') || ''}"`);
    }
    lines.push('', 'Buttons:');
    for (const b of [...document.querySelectorAll('button')].filter(visible).slice(0, 100)) {
      lines.push(`  label="${b.getAttribute('aria-label') || ''}" text="${short(b.innerText, 50)}" class="${short(b.className, 50)}"`);
    }
    lines.push('', 'Settings popup:');
    const trigger = genTrigger();
    if (!trigger) {
      lines.push('  no settings chip');
    } else {
      lines.push(`  chip: text="${short(trigger.innerText, 60)}" aria-expanded=${trigger.getAttribute('aria-expanded')} aria-controls=${trigger.getAttribute('aria-controls')} aria-haspopup=${trigger.getAttribute('aria-haspopup')}`);
      const wasOpen = !!genPopup();
      if (!wasOpen) { realClick(trigger); await sleep(1500); }
      lines.push('  detected by BulkGen: ' + (genPopup() ? 'yes' : 'no'));
      for (const o of popupOverlays()) {
        lines.push(`  overlay ${o.tagName.toLowerCase()}.${short(o.className, 40)} role=${o.getAttribute('role') || ''}: ${short(o.innerText, 300)}`);
        for (const b of [...o.querySelectorAll('button,[role=tab],[role=radio],[role=option],[role=menuitem]')].filter(visible).slice(0, 40)) {
          lines.push(`    ${b.tagName.toLowerCase()} role=${b.getAttribute('role') || ''} label="${b.getAttribute('aria-label') || ''}" text="${short(b.innerText, 40)}"`);
        }
      }
      if (!wasOpen) { realClick(trigger); await sleep(600); if (popupOverlays().length) escape(); }
    }
    return lines.join('\n');
  }

  // ---------- messaging ----------
  async function onMessage(msg) {
    switch (msg && msg.type) {
      case 'bg-ping': return { ok: true, url: location.href, hasChat: !!chatBox(), looping };
      case 'bg-start': return startRun(msg.limit);
      case 'bg-debug':
        if (looping) return { ok: false, error: 'A run is going. Copy the debug info when it is finished.' };
        return { ok: true, text: await debugInfo() };
      case 'bg-download-all':
        if (looping) return { ok: false, error: 'A run is going. Download the videos when it is finished, or Stop it first.' };
        if (downloadingAll) return { ok: false, error: 'Already downloading the project videos.' };
        if (!/^(\/u\/\d+)?\/project\//.test(location.pathname)) return { ok: false, error: 'Open a Flow project page first.' };
        downloadAll(); // runs on its own; progress shows in the log
        return { ok: true };
      case 'bg-read-models':
        if (looping) return { ok: false, error: 'A run is going. Read the models when it is finished.' };
        return readModels();
      case 'bg-pause':
        pauseFlag = true;
        if (run) { run.paused = true; await saveRun(); }
        await log('Paused. The current step finishes first, nothing new is sent.');
        return { ok: true };
      case 'bg-resume':
        pauseFlag = false;
        if (run && !run.finished) {
          run.paused = false; run.running = true; run.stuck = ''; stopFlag = false;
          progress();
          await saveRun();
          await log('Resumed.');
          mainLoop();
        }
        return { ok: true };
      case 'bg-stop':
        stopFlag = true;
        if (run) { run.running = false; run.paused = false; run.step = 'Stopped'; await saveRun(); }
        await log('Stopped. Videos already queued in Flow will still finish there.');
        detachDebugger();
        return { ok: true };
      case 'bg-apply-settings': {
        if (looping) return { ok: false, result: 'A run is going. Apply the settings when it is finished.' };
        const cfg = await store.get('bg_cfg', {});
        let res;
        if (cfg.engine === 'agent') {
          res = await applyFlowSettings({ aspect: cfg.aspect, count: cfg.count, model: cfg.model, confirmNever: !!cfg.confirmNever });
        } else {
          try {
            const s = await applyPlainSettings(cfg);
            res = `Flow set to ${s.model}: ${s.summary}. Flow estimates ${s.credits == null ? 'unknown' : s.credits} credits per prompt.${s.notes.length ? ' Note: ' + s.notes.join(', ') + '.' : ''}`;
          } catch (e) {
            res = `Could not apply the settings. ${e.message}. Page: ${pageInfo()}`;
          }
        }
        await log(res);
        return { ok: true, result: res };
      }
      default: return { ok: false, error: 'unknown message' };
    }
  }

  if (HAS_CHROME) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !String(msg.type || '').startsWith('bg-')) return;
      onMessage(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    });
    // remember the project page so the side panel can send you back to it
    const rememberProject = () => {
      const m = location.pathname.match(/^(\/u\/\d+)?\/project\/[0-9a-f-]+/i);
      if (m) store.set('bg_lastProject', location.origin + m[0]);
    };
    rememberProject();
    rememberTimer = setInterval(rememberProject, 15000);
    // resume after a page reload
    (async () => {
      const saved = await store.get('bg_run', null);
      if (saved && saved.running && !saved.finished && saved.items) {
        run = saved;
        pauseFlag = !!saved.paused;
        await sleep(4000);
        const where = location.pathname.replace(/[0-9a-f-]{36}/gi, 'ID');
        await log(pauseFlag ? `Page reloaded (${where}). The run is paused, click Resume to continue.` : `Page reloaded (${where}), resuming the queue.`);
        mainLoop();
      }
    })();

    // Test bridge for developer builds (loaded unpacked): lets a test script on the page drive the run
    if (!chrome.runtime.getManifest().update_url) {
      window.addEventListener('message', async (ev) => {
        const d = ev.data;
        if (ev.source !== window || !d || d.__bulkgen !== 'cmd') return;
        let res;
        try {
          if (d.type === 'bg-set-cfg') { await store.set('bg_cfg', Object.assign(await store.get('bg_cfg', {}), d.cfg)); res = { ok: true }; }
          else if (d.type === 'bg-set-refs') { await store.set('bg_refs', d.refs || []); res = { ok: true }; }
          else if (d.type === 'bg-forget-saved') { await store.set('bg_saved', {}); res = { ok: true }; }
          else if (d.type === 'bg-status') res = { ok: true, run: await store.get('bg_run', null), looping, version: chrome.runtime.getManifest().version };
          else if (d.type === 'bg-reload-extension') res = await sendBg({ type: 'bulkgen-reload-extension' });
          else res = await onMessage(d);
        } catch (e) { res = { ok: false, error: e.message }; }
        window.postMessage({ __bulkgen: 'res', id: d.id, res: JSON.parse(JSON.stringify(res)) }, '*');
      });
    }
  }

  // test hooks for dry runs
  window.__bulkgen = { chatBox, gridTiles, findClickable, submitButton, buildPrompt, openCards, cardInfo, userRowsMatching, matchItem, DRY };
})();
