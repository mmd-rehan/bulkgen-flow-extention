/* BulkGen for Google Flow - content script (drives the Flow page) */
(() => {
  // After an extension reload the old (orphaned) copy can still hold the page. Retire it and take over.
  try { if (typeof window.__bulkgenDispose === 'function') window.__bulkgenDispose(); } catch (e) { /* ignore */ }

  const HAS_CHROME = typeof chrome !== 'undefined' && chrome.storage && chrome.runtime && chrome.runtime.id;
  const DRY = !HAS_CHROME; // dry mode lets helpers be tested from a plain page console

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // ---------- storage ----------
  const mem = {};
  const store = {
    async get(key, def) {
      if (DRY) return key in mem ? mem[key] : def;
      const o = await chrome.storage.local.get(key);
      return key in o ? o[key] : def;
    },
    async set(key, val) {
      if (DRY) { mem[key] = val; return; }
      await chrome.storage.local.set({ [key]: val });
    }
  };

  let run = null; // live run state
  let stopFlag = false;
  let pauseFlag = false;
  let looping = false;
  window.__bulkgenDispose = () => { stopFlag = true; };

  async function saveRun() { await store.set('bg_run', run); }
  async function log(msg, level = 'info') {
    const line = { t: Date.now(), level, msg };
    if (run) {
      run.log = (run.log || []).concat(line).slice(-200);
      await saveRun();
    }
    console.log('[BulkGen]', msg);
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

  // Real (trusted) click through the background page. Flow ignores scripted clicks on the Start button.
  async function trustedClick(el) {
    el.scrollIntoView({ block: 'center' });
    await sleep(150);
    if (HAS_CHROME) {
      const r = el.getBoundingClientRect();
      const res = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: 'bulkgen-click', x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }, (x) => {
            if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
            else resolve(x || { ok: false });
          });
        } catch (e) { resolve({ ok: false, error: e.message }); }
      });
      if (res.ok) return true;
      console.warn('[BulkGen] trusted click failed, using scripted click:', res.error);
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

  function chatBox() {
    const cands = document.querySelectorAll('textarea,[contenteditable="true"],[role=textbox]');
    for (const el of cands) {
      if (!visible(el)) continue;
      const hint = norm(
        (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' +
        (el.getAttribute('data-placeholder') || '') + ' ' + (el.getAttribute('aria-placeholder') || '')
      );
      if (/what do you want to create/i.test(hint)) return el;
    }
    return null;
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
    const b = document.querySelector('button[aria-label="Start generation"]');
    return b && visible(b) ? b : findClickable(/^start generation$/i);
  }

  // Media tiles in the library grid (exclude the right hand chat panel and tiny images)
  function gridTiles() {
    const out = [];
    const media = document.querySelectorAll('img,video');
    for (const m of media) {
      const r = m.getBoundingClientRect();
      if (r.width < 150 || r.height < 90) continue;
      if (r.top < 60) continue;
      if (r.left > window.innerWidth * 0.70) continue; // chat panel
      const src = (m.currentSrc || m.src || '').split('?')[0];
      if (!src || /gstatic\.com\/gb|ogw\//.test(src)) continue;
      // climb to a reasonable tile container
      let box = m;
      for (let i = 0; i < 4 && box.parentElement; i++) {
        const pr = box.parentElement.getBoundingClientRect();
        if (pr.width > r.width * 1.6 || pr.height > r.height * 1.8) break;
        box = box.parentElement;
      }
      const text = norm(box.innerText || '');
      const isVideo = m.tagName === 'VIDEO' || /play_circle|play_arrow|videocam/i.test(text);
      const generating = /\b\d{1,3}\s?%|generating|queued|in queue|creating/i.test(text);
      const failed = /failed|couldn.t|could not|error|violat|blocked/i.test(text);
      out.push({ key: src, el: m, box, text, generating, failed, isVideo });
    }
    // de-dupe by key
    const seen = new Set();
    return out.filter((t) => (seen.has(t.key) ? false : seen.add(t.key)));
  }

  function onGridView() { return !!chatBox(); }

  async function goToVideosGrid() {
    // Back from an edit view if needed
    if (/\/edit\//.test(location.pathname)) {
      const back = document.querySelector('button[aria-label^="Back button"]') || findClickable(/^back button/i);
      if (back) realClick(back);
      await waitFor(() => !/\/edit\//.test(location.pathname), 8000);
      await sleep(800);
    }
    const tab = findClickable(/^videos$/i);
    if (tab) { realClick(tab); await sleep(900); }
  }

  // ---------- Flow settings (best effort, optional) ----------
  async function applyFlowSettings(cfg) {
    await goToVideosGrid();
    const buttons = [...document.querySelectorAll('button[aria-label="Settings"]')].filter(visible);
    const btn = buttons[buttons.length - 1];
    if (!btn) return 'Settings button not found in prompt box';
    realClick(btn);
    const panel = await waitFor(() => findClickable(/^save$/i), 5000);
    if (!panel) return 'Agent settings did not open';
    const notes = [];
    if (cfg.confirmNever) {
      const never = findClickable(/^never\b/i);
      if (never) { realClick(never); notes.push('confirm=never'); await sleep(200); }
    }
    if (cfg.aspect) {
      // second group of aspect buttons is the video one, so take the last match
      const all = [...document.querySelectorAll('button,[role=button],[role=radio]')].filter((e) => visible(e) && accName(e) === cfg.aspect);
      const el = all[all.length - 1];
      if (el) { realClick(el); notes.push('aspect=' + cfg.aspect); await sleep(200); }
    }
    if (cfg.count) {
      const all = [...document.querySelectorAll('button,[role=button],[role=radio]')].filter((e) => visible(e) && accName(e) === 'x' + cfg.count);
      const el = all[all.length - 1];
      if (el) { realClick(el); notes.push('count=x' + cfg.count); await sleep(200); }
    }
    if (cfg.model) {
      const dds = [...document.querySelectorAll('[role=combobox],[aria-haspopup],button')].filter((e) => visible(e) && /omni|veo|flash|fast|quality|lite/i.test(accName(e)));
      const dd = dds[dds.length - 1];
      if (dd) {
        realClick(dd);
        await sleep(500);
        const opt = [...document.querySelectorAll('[role=option],[role=menuitem],li')].find((e) => visible(e) && accName(e).toLowerCase().includes(cfg.model.toLowerCase()));
        if (opt) { realClick(opt); notes.push('model=' + cfg.model); await sleep(300); }
        else notes.push('model "' + cfg.model + '" not found in list');
      }
    }
    const save = findClickable(/^save$/i);
    if (save) realClick(save);
    await sleep(600);
    return 'Applied: ' + (notes.join(', ') || 'nothing changed');
  }

  // ---------- generation ----------
  function buildPrompt(cfg, p) {
    const parts = [];
    const dot = (s) => { s = s.trim(); return /[.!?]$/.test(s) ? s : s + '.'; };
    if (cfg.character && cfg.character.trim()) parts.push('Character and world notes (keep consistent): ' + dot(cfg.character));
    parts.push('Generate a video. ' + dot(p));
    if (cfg.style && cfg.style.trim()) parts.push('Style: ' + dot(cfg.style));
    if (cfg.duration) parts.push('Make it a ' + cfg.duration + '-second video clip.');
    return parts.join(' ');
  }

  async function handleApproval(cfg) {
    // Wait for the credit confirmation card, then approve (or reject if too expensive)
    const end = Date.now() + 20000;
    while (Date.now() < end && !stopFlag) {
      const txt = norm(document.body.innerText);
      const m = txt.match(/costing\s+(\d+)\s+credits?/gi);
      const radio = findClickable(/^approve$/i);
      if (radio) {
        let cost = 0;
        if (m && m.length) cost = parseInt(m[m.length - 1].match(/\d+/)[0], 10);
        if (cfg.maxCredits && cost > cfg.maxCredits) {
          const rej = findClickable(/^reject$/i);
          if (rej) realClick(rej);
          return { ok: false, reason: `cost ${cost} credits is above your cap of ${cfg.maxCredits}` };
        }
        realClick(radio);
        return { ok: true, cost };
      }
      await sleep(400);
    }
    return { ok: true, cost: 0, note: 'no approval card seen (auto approve may be on)' };
  }

  async function submitOne(cfg, idx) {
    if (!onGridView()) await goToVideosGrid();
    const box = await waitFor(chatBox, 8000);
    if (!box) throw new Error('Prompt box not found. Open a Flow project page first.');
    const text = buildPrompt(cfg, run.prompts[idx]);
    setText(box, text);
    await sleep(400);
    const btn = await waitFor(() => {
      const b = submitButton();
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    }, 5000);
    if (!btn) throw new Error('Start generation button not available');
    await trustedClick(btn);
    await sleep(800);
    // if the text is still sitting in the box the click did not go through
    if (chatBox() && norm(chatBox().innerText).length > 0) {
      await sleep(1500);
      if (chatBox() && norm(chatBox().innerText).length > 0) throw new Error('Start click did not send the prompt');
    }
    const ap = await handleApproval(cfg);
    if (!ap.ok) throw new Error(ap.reason);
    return ap;
  }

  // ---------- downloading ----------
  function slug(s) { return norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'video'; }

  async function bgDownload(url, filename) {
    if (DRY) return { ok: true, dry: true };
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'bulkgen-download', url, filename }, (res) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(res || { ok: false, error: 'no response' });
      });
    });
  }

  async function anchorDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return { ok: true };
  }

  function detachDebugger() {
    if (!HAS_CHROME) return;
    try { chrome.runtime.sendMessage({ type: 'bulkgen-detach' }, () => void chrome.runtime.lastError); } catch (e) { /* ignore */ }
  }

  function expectDownload(filename) {
    if (!HAS_CHROME) return;
    try { chrome.runtime.sendMessage({ type: 'bulkgen-expect-download', filename }, () => void chrome.runtime.lastError); } catch (e) { /* ignore */ }
  }

  // Flow's own Download media menu: 270p GIF, 720p original, 1080p upscaled, 4K upscaled (paid)
  async function clickDownloadMenu(filename, quality) {
    const btn = document.querySelector('button[aria-label="Download media"]') || findClickable(/^download media$/i);
    if (!btn) return false;
    await trustedClick(btn);
    const items = await waitFor(() => {
      const list = [...document.querySelectorAll('[role=menuitem]')].filter(visible);
      return list.length ? list : null;
    }, 4000);
    if (!items) return false;
    const want = quality === '1080p' ? /1080/ : /720/;
    const choice = items.find((e) => want.test(accName(e))) || items.find((e) => /720|original/i.test(accName(e)));
    if (!choice) return false;
    expectDownload(filename);
    await trustedClick(choice);
    // Flow shows a toast when the file is ready
    const ok = await waitFor(() => /your video has been downloaded|downloaded/i.test(document.body.innerText), 40000, 500);
    return ok ? true : 'unconfirmed';
  }

  async function downloadOpenedVideo(filename, quality) {
    const viaMenu = await clickDownloadMenu(filename, quality);
    if (viaMenu) return viaMenu === 'unconfirmed' ? 'menu (unconfirmed)' : 'menu';
    // fallback: a readable video source, if Flow exposes one
    const v = [...document.querySelectorAll('video')].find((x) => (x.currentSrc || x.src) && visible(x));
    if (v) {
      const src = v.currentSrc || v.src;
      if (/^https?:/.test(src)) {
        const res = await bgDownload(src, filename);
        if (res.ok) return 'direct';
      } else if (src.startsWith('blob:')) {
        await anchorDownload(src, filename);
        return 'blob';
      }
    }
    return null;
  }

  function openedTitle() {
    const t = document.querySelector('input[type=text]');
    return t && t.value ? t.value : '';
  }

  async function harvest(cfg) {
    await goToVideosGrid();
    await sleep(1200);
    const tiles = gridTiles();
    const fresh = tiles.filter((t) => !run.seen.includes(t.key));
    let downloaded = 0;
    run.dlTries = run.dlTries || {};
    const maxTries = Math.max(1, parseInt(cfg.downloadRetries, 10) || 3);
    for (const t of fresh) {
      if (stopFlag) break;
      if (!t.isVideo) { run.seen.push(t.key); continue; } // stills and other media are not ours
      if (t.failed && !t.generating) {
        run.seen.push(t.key);
        run.failed += 1;
        run.inFlight = Math.max(0, run.inFlight - 1);
        await log('A generation failed on the Flow side (tile reported an error).', 'warn');
        await saveRun();
        continue;
      }
      if (t.generating) continue;
      // open it (scripted click first, then a real one)
      realClick(t.el);
      let opened = await waitFor(() => /\/edit\//.test(location.pathname), 4000);
      if (!opened) { await trustedClick(t.el); opened = await waitFor(() => /\/edit\//.test(location.pathname), 6000); }
      if (!opened) { await log('Could not open a finished video tile, will retry.', 'warn'); continue; }
      await sleep(1500);
      const isVideoPage = await waitFor(() => document.querySelector('button[aria-label="Play"],button[aria-label="Pause"],button[aria-label="Skip to next clip"]'), 6000);
      if (!isVideoPage) {
        run.seen.push(t.key);
        await log('Opened item was not a video, skipping it.', 'info');
        await saveRun();
        await goToVideosGrid();
        await sleep(900);
        continue;
      }
      const vid = [...document.querySelectorAll('video')].find((x) => visible(x));
      if (vid && vid.readyState < 1) await sleep(2500);
      const n = run.downloaded + 1;
      const title = openedTitle() || run.prompts[Math.min(n - 1, run.prompts.length - 1)];
      const fname = `${cfg.prefix || 'flow'}_${String(n).padStart(3, '0')}_${slug(title)}.mp4`;
      const how = await downloadOpenedVideo(fname, cfg.quality);
      if (how) {
        run.seen.push(t.key);
        run.downloaded += 1;
        run.inFlight = Math.max(0, run.inFlight - 1);
        downloaded += 1;
        await log(`Downloaded video ${run.downloaded} (${how}).`);
      } else {
        run.dlTries[t.key] = (run.dlTries[t.key] || 0) + 1;
        if (run.dlTries[t.key] >= maxTries) {
          run.seen.push(t.key);
          run.failed += 1;
          run.inFlight = Math.max(0, run.inFlight - 1);
          await log(`Gave up downloading "${title}" after ${maxTries} tries. It is still in Flow, please download it by hand.`, 'error');
        } else {
          await log(`Download failed for "${title}" (try ${run.dlTries[t.key]} of ${maxTries}), will try again.`, 'warn');
        }
      }
      await saveRun();
      await sleep(cfg.downloadGapMs || 1200);
      await goToVideosGrid();
      await sleep(900);
    }
    return downloaded;
  }

  // ---------- main loop ----------
  async function mainLoop() {
    if (looping) return;
    looping = true;
    try {
      const cfg = await store.get('bg_cfg', {});
      while (run && run.running && !stopFlag) {
        if (pauseFlag) { await sleep(1000); continue; }
        // stay on the project the run started in
        if (run.project && !location.pathname.startsWith(run.project)) {
          await log('Flow moved to another page, going back to the project.', 'warn');
          location.assign(location.origin + run.project);
          await sleep(20000);
          continue;
        }
        const total = run.prompts.length;
        const canSubmit = run.next < total && run.inFlight < (cfg.maxInFlight || 2);
        if (canSubmit) {
          const idx = run.next;
          try {
            await log(`Submitting ${idx + 1} of ${total}...`);
            const ap = await submitOne(cfg, idx);
            run.next += 1;
            run.inFlight += 1;
            run.attempts[idx] = 0;
            run.lastSubmit = Date.now();
            await log(`Queued ${idx + 1} of ${total}${ap.cost ? ' (' + ap.cost + ' credits)' : ''}.`);
            await saveRun();
            await sleep(cfg.submitGapMs || 4000);
          } catch (e) {
            run.attempts[idx] = (run.attempts[idx] || 0) + 1;
            await log(`Submit ${idx + 1} failed: ${e.message}`, 'warn');
            if (run.attempts[idx] >= (cfg.retries || 2)) {
              run.next += 1;
              run.failed += 1;
              await log(`Skipping prompt ${idx + 1} after ${run.attempts[idx]} tries.`, 'error');
            }
            await saveRun();
            await sleep(3000);
          }
          continue;
        }
        if (run.inFlight > 0) {
          const got = await harvest(cfg);
          // timeout guard: free slots that never finish
          const limit = (cfg.timeoutMin || 20) * 60000;
          if (!got && run.lastSubmit && Date.now() - run.lastSubmit > limit) {
            await log('Generations timed out, moving on.', 'error');
            run.failed += run.inFlight;
            run.inFlight = 0;
            await saveRun();
          }
          if (!got) await sleep(cfg.pollMs || 8000);
          continue;
        }
        break; // nothing left
      }
      if (run && run.running && !stopFlag) {
        run.running = false;
        run.finished = true;
        await log(`All done. ${run.downloaded} downloaded, ${run.failed} failed.`);
        await saveRun();
        detachDebugger();
      }
    } catch (e) {
      await log('Run stopped by an error: ' + e.message, 'error');
      if (run) { run.running = false; await saveRun(); }
    } finally {
      looping = false;
    }
  }

  async function startRun() {
    const cfg = await store.get('bg_cfg', {});
    const prompts = (cfg.prompts || []).filter((p) => p && p.trim());
    if (!prompts.length) return { ok: false, error: 'Add at least one prompt.' };
    await goToVideosGrid();
    // wait until the grid has finished drawing so existing media is not mistaken for new output
    let existing = [];
    let stable = 0;
    for (let i = 0; i < 16 && stable < 3; i++) {
      await sleep(700);
      const keys = gridTiles().map((t) => t.key);
      stable = keys.length === existing.length ? stable + 1 : 0;
      existing = keys;
    }
    const pm = location.pathname.match(/^\/project\/[0-9a-f-]+/i);
    run = {
      running: true, finished: false, prompts, next: 0, inFlight: 0, downloaded: 0, failed: 0,
      attempts: {}, dlTries: {}, seen: existing, log: [], startedAt: Date.now(), project: pm ? pm[0] : ''
    };
    stopFlag = false; pauseFlag = false;
    await saveRun();
    await log(`Started with ${prompts.length} prompts.`);
    mainLoop();
    return { ok: true };
  }

  // ---------- messaging ----------
  async function onMessage(msg) {
    switch (msg && msg.type) {
      case 'bg-ping': return { ok: true, url: location.href, hasChat: !!chatBox() };
      case 'bg-start': return startRun();
      case 'bg-pause': pauseFlag = true; if (run) { run.paused = true; await saveRun(); } await log('Paused.'); return { ok: true };
      case 'bg-resume':
        pauseFlag = false;
        if (run) { run.paused = false; run.running = true; stopFlag = false; await saveRun(); mainLoop(); }
        await log('Resumed.');
        return { ok: true };
      case 'bg-stop':
        stopFlag = true;
        if (run) { run.running = false; run.paused = false; await saveRun(); }
        await log('Stopped.');
        detachDebugger();
        return { ok: true };
      case 'bg-apply-settings': {
        const cfg = await store.get('bg_cfg', {});
        const res = await applyFlowSettings({
          aspect: cfg.aspect, count: cfg.count, model: cfg.model, confirmNever: cfg.confirmNever
        });
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
      const m = location.pathname.match(/^\/project\/[0-9a-f-]+/i);
      if (m) store.set('bg_lastProject', location.origin + m[0]);
    };
    rememberProject();
    setInterval(rememberProject, 15000);
    // resume after a page reload
    (async () => {
      const saved = await store.get('bg_run', null);
      if (saved && saved.running && !saved.finished) {
        run = saved;
        await sleep(4000);
        await log('Page reloaded, resuming the queue.');
        mainLoop();
      }
    })();
  }

  // test hooks for dry runs
  window.__bulkgen = { chatBox, gridTiles, findClickable, submitButton, buildPrompt, onGridView, DRY };
})();
