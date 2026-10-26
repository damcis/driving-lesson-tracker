// ==UserScript==
// @name         Frisco lesson filler (TDS portal)
// @namespace    https://damcis.github.io/driving-lesson-tracker/
// @version      0.1.0
// @description  Fills in the in-car evaluation and lesson notes on the TDS staff portal from the summary copied in the Driving Lesson Tracker app.
// @match        https://www.tdsm.app/StaffMobile/*
// @match        https://tdsm.app/StaffMobile/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
  HOW IT WORKS
  1. In the tracker app, tap "Copy Summary" for the lesson you just finished.
  2. Open the TDS portal in this browser and tap the blue "Fill lesson" button
     (bottom-left). It reads the clipboard, finds the student in Needs
     Attention, and walks Action > Process > PROCESS > In-Car Lesson on its own
     (it keeps going across page loads), or - if you're already on the
     evaluation page - just fills it in.
  3. It sets every skill (Needs Improvement for the ones marked practice, Met
     Standards for the rest; Attitude / Comfort Level use Needs work / Good) and
     pastes your notes into the first Lesson Notes box.
  4. It NEVER taps "Complete Lesson (Send Email)". Check the form, then do
     that yourself.

  Nothing is stored except the pending lesson (in the userscript manager's own
  storage) while it is working; that is deleted when it finishes or you cancel.
*/

(function () {
  'use strict';

  if (/login/i.test(location.pathname)) return; // nothing to do on the login page

  const T = globalThis.__LF_TEST__; // only ever set by my offline tests

  // ---------------------------------------------------------------- data
  const MARKER = '###SKILLS_DATA###';
  const PENDING_KEY = 'lesson-filler-pending';
  const PENDING_MAX_AGE = 20 * 60 * 1000; // ms
  const POLL = (T && T.poll) || 500;      // ms between checks while working
  const STUCK_AFTER = (T && T.stuckAfter) || 30000;

  // The app's skill names -> the portal's wording, only where the spelling
  // differs (case, spaces and punctuation are ignored when matching).
  const ALIASES = {
    'Accelerator Control': 'Accelerater control', // portal's own typo
    'Parallel Parking': 'Parallell parking',       // portal's own typo
  };

  // Did Not Cover / Needs Improvement / Met Standards scale
  const STANDARD_SKILLS = [
    'Car Familiarity', 'Hand Position', 'Steering', 'Braking Control',
    'Braking Distance', 'Accelerator Control', 'Speed Control',
    'Speed During Turns', 'Use of Turn Signals', 'Use of Mirrors - General',
    'Shoulder Checks', 'Blind Spots', 'Lane Position', 'Lane Changes',
    'Right & Left Turns', 'Right & Left Turns in Double Lanes',
    'Approach a Corner', 'Intersections', 'Scanning Intersections',
    'Stop Signs', 'Traffic Lights (Arrows)', '4-Way Stops', 'Right on Red',
    'Right of Way', 'Following Distance', 'Stopping Distance', 'Passing',
    'Merging', 'Freeways', 'Traffic Circles', 'Curved Roads',
    'Backing in a Straight Line', 'U-Turns', '3-Point Turn & 2-Point Turns',
    'Parallel Parking', 'Perpendicular Parking', 'Road Signs - Knowledge',
    'General Observation / Commentary Driving',
  ];
  // Needs work / Good / Excellent scale
  const RATING_SKILLS = ['Attitude', 'Comfort Level'];

  // ------------------------------------------------------------- helpers
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const tokensOf = (name) =>
    (String(name || '').match(/[A-Za-z0-9'\u2019]+/g) || []).map((t) => t.toLowerCase());

  const store = {
    get(k) {
      try { return typeof GM_getValue === 'function' ? GM_getValue(k, null) : localStorage.getItem(k); }
      catch (e) { return null; }
    },
    set(k, v) {
      try { if (typeof GM_setValue === 'function') GM_setValue(k, v); else localStorage.setItem(k, v); }
      catch (e) { /* ignore */ }
    },
    del(k) {
      try { if (typeof GM_deleteValue === 'function') GM_deleteValue(k); else localStorage.removeItem(k); }
      catch (e) { /* ignore */ }
    },
  };

  function parseClip(text) {
    if (!text || !text.includes(MARKER)) return null;
    const i = text.indexOf(MARKER);
    try {
      const d = JSON.parse(text.slice(i + MARKER.length).trim());
      return {
        essay: text.slice(0, i).trim(),
        studentName: String(d.studentName || ''),
        needsPractice: (d.needsPractice || []).map(String),
      };
    } catch (e) { return null; }
  }

  // ----------------------------------------------------- reading the page
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === 'none') return false;
      if (n === el && (s.visibility === 'hidden' || s.visibility === 'collapse')) return false;
    }
    return T && T.noLayout ? true : el.getClientRects().length > 0;
  }

  // Every short piece of text on the page, in document order.
  function indexTexts() {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const t = n.nodeValue;
        if (!t || t.length > 90 || !/\S/.test(t)) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName) || p.closest('#lf-panel,#lf-status')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      out.push({ key: norm(n.nodeValue), text: n.nodeValue.trim(), el: n.parentElement });
    }
    return out;
  }

  // Index of the first visible entry with this key after position `from`
  // (and no more than `maxGap` entries later), or -1.
  function firstVisible(idx, key, from = -1, maxGap = Infinity) {
    for (let i = from + 1; i < idx.length && i - from <= maxGap; i++) {
      if (idx[i].key === key && isVisible(idx[i].el)) return i;
    }
    return -1;
  }

  const clickable = (el) => el.closest('a,button,[role="button"],li,label') || el;

  function tap(el, scroll) {
    if (scroll && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((type) =>
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    );
    el.click();
  }

  function setValue(el, value) {
    try {
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    } catch (e) {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // --------------------------------------------------------- the checklist
  function chooseOption(textEl) {
    const label = textEl.closest('label');
    let input = null;
    if (label) input = label.control || label.querySelector('input[type="radio"]');
    if (!input) {
      const f = textEl.closest('[for]');
      if (f) input = document.getElementById(f.getAttribute('for'));
    }
    tap(label || textEl, false);
    if (input && input.type === 'radio' && !input.checked) {
      input.checked = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return input ? input.checked : true;
  }

  function fillSkills(needsSet) {
    let done = 0;
    const missed = [];
    for (const name of [...STANDARD_SKILLS, ...RATING_SKILLS]) {
      const rating = RATING_SKILLS.includes(name);
      const needs = needsSet.has(norm(name));
      const option = rating ? (needs ? 'Needs work' : 'Good') : (needs ? 'Needs Improvement' : 'Met Standards');
      const idx = indexTexts(); // fresh each time in case the page re-renders
      const li = firstVisible(idx, norm(ALIASES[name] || name));
      const oi = li < 0 ? -1 : firstVisible(idx, norm(option), li, 8);
      if (oi < 0) { missed.push(name); continue; }
      if (chooseOption(idx[oi].el)) done++; else missed.push(name);
    }
    return { done, missed };
  }

  function fillNotes(essay) {
    const ta = [...document.querySelectorAll('textarea')].find(isVisible);
    if (!ta) return false;
    setValue(ta, essay);
    return true;
  }

  // --------------------------------------------------- evaluation dropdown
  async function pickInCarLesson() {
    let idx = indexTexts();
    const fi = firstVisible(idx, 'selectevaluation');
    if (fi >= 0) { // styled dropdown: open it, then choose the item
      tap(clickable(idx[fi].el), true);
      await sleep(T ? 20 : 400);
      idx = indexTexts();
      const ii = firstVisible(idx, 'incarlesson');
      if (ii >= 0) { tap(clickable(idx[ii].el), true); return true; }
    }
    for (const sel of document.querySelectorAll('select')) { // plain <select>
      const opt = [...sel.options].find((o) => norm(o.text) === 'incarlesson');
      if (opt && isVisible(sel)) {
        if (sel.value !== opt.value) setValue(sel, opt.value);
        return true;
      }
    }
    return false;
  }

  const evaluationDropdownShowing = () => {
    const idx = indexTexts();
    if (firstVisible(idx, 'selectevaluation') >= 0) return true;
    return [...document.querySelectorAll('select')].some(
      (s) => isVisible(s) && [...s.options].some((o) => norm(o.text) === 'incarlesson')
    );
  };

  // ------------------------------------------------------- the dashboard
  const isActionEl = (el) => {
    const t = (el.textContent || '').trim().toLowerCase();
    return t.startsWith('action') && t.length < 12;
  };

  function findActionToggle(nameEl) {
    let box = nameEl;
    for (let depth = 0; box && box !== document.body && depth < 10; depth++, box = box.parentElement) {
      const found = [...box.querySelectorAll('button,a,[role="button"],.btn,span,div')]
        .find((el) => isActionEl(el) && isVisible(el));
      if (found) return { toggle: found, card: box };
    }
    return null;
  }

  // ------------------------------------------------------- the state machine
  const persist = (rec) => store.set(PENDING_KEY, JSON.stringify(rec));
  const canTap = (rec, key, ms) => {
    rec.taps = rec.taps || {};
    if (Date.now() - (rec.taps[key] || 0) < ms) return false;
    rec.taps[key] = Date.now();
    persist(rec);
    return true;
  };

  async function advance(rec) {
    let idx = indexTexts();

    // 1. The skills checklist is showing -> fill it in.
    if (firstVisible(idx, norm('Car Familiarity')) >= 0) return fillEverything(rec);

    // 2. On the lesson page (BTW hours shown).
    if (idx.some((e) => e.key.includes('btwhoursenrolled') && isVisible(e.el))) {
      if (evaluationDropdownShowing()) {
        if (!canTap(rec, 'evaluation', 3000)) return { state: 'progress', stage: 'evaluation-dropdown' };
        rec.evalTries = (rec.evalTries || 0) + 1;
        if (rec.evalTries > 4) {
          return { state: 'stuck', message: 'I couldn’t pick In-Car Lesson. Pick it yourself, then tap Fill lesson again.' };
        }
        await pickInCarLesson();
        return { state: 'progress', stage: 'evaluation-dropdown' };
      }
      const pi = firstVisible(idx, 'process');
      if (pi >= 0 && canTap(rec, 'processButton', 4000)) {
        tap(clickable(idx[pi].el), true);
        return { state: 'progress', stage: 'process-button' };
      }
      return { state: 'progress', stage: 'lesson-page' };
    }

    // 3. On the dashboard -> find the student's card.
    if (idx.some((e) => e.key.includes('needsattention') && isVisible(e.el))) {
      const tokens = tokensOf(rec.studentName);
      if (!tokens.length) {
        return { state: 'stuck', message: 'There’s no student name in the copied summary. Add it in the app and copy again.' };
      }
      let entries = idx.filter((e) => isVisible(e.el) && tokens.every((t) => e.text.toLowerCase().includes(t)));
      if (rec.pick) entries = entries.filter((e) => e.text === rec.pick);
      if (entries.length > 1) {
        const names = [...new Set(entries.map((e) => e.text))];
        if (names.length > 1) {
          const ans = prompt('Which student?\n' + names.map((n, i) => `${i + 1}) ${n}`).join('\n'), '1');
          const n = parseInt(ans, 10);
          if (!(n >= 1 && n <= names.length)) return { state: 'stuck', message: 'Cancelled - nothing was changed.' };
          rec.pick = names[n - 1];
          persist(rec);
          entries = entries.filter((e) => e.text === rec.pick);
        }
      }
      if (!entries.length) return { state: 'progress', stage: 'finding-student' };

      const found = findActionToggle(entries[0].el);
      if (!found) return { state: 'progress', stage: 'finding-action-button' };

      idx = indexTexts();
      const pi = idx.findIndex((e) => e.key === 'process' && isVisible(e.el) && found.card.contains(e.el));
      if (pi >= 0) {
        if (canTap(rec, 'menuProcess', 5000)) {
          rec.viaDashboard = true;
          persist(rec);
          tap(clickable(idx[pi].el), true);
        }
        return { state: 'progress', stage: 'process-menu' };
      }
      if (canTap(rec, 'actionButton', 4000)) tap(found.toggle, true);
      return { state: 'progress', stage: 'action-menu' };
    }

    return { state: 'progress', stage: 'waiting-for-page' };
  }

  function fillEverything(rec) {
    if (!rec.viaDashboard) {
      const tokens = tokensOf(rec.studentName);
      const bodyText = typeof document.body.innerText === 'string' ? document.body.innerText : document.body.textContent;
      const body = (bodyText || '').toLowerCase();
      if (tokens.length && !tokens.every((t) => body.includes(t))) {
        if (!confirm(`I can’t see “${rec.studentName}” on this page. Fill it in anyway?`)) {
          return { state: 'stuck', message: 'Cancelled - nothing was changed.' };
        }
      }
    }
    const needs = new Set(rec.needsPractice.map(norm));
    const { done, missed } = fillSkills(needs);
    const noted = fillNotes(rec.essay);
    let msg = `Done: set ${done} skills` + (noted ? ' and pasted the notes.' : '.');
    if (!noted) msg += ' I couldn’t find the Lesson Notes box - paste them by hand.';
    if (missed.length) msg += ` Set by hand: ${missed.join(', ')}.`;
    msg += ' Check everything, then tap COMPLETE LESSON yourself.';
    return { state: 'done', message: msg };
  }

  // --------------------------------------------------------------- the UI
  let running = false;
  let cancelled = false;
  let ui = null;

  function buildUI() {
    const css = (el, s) => { el.style.cssText = s; return el; };
    const btn = (text, bg) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      return css(b, `background:${bg};color:#fff;border:0;border-radius:22px;padding:10px 16px;font:600 14px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.35)`);
    };
    const panel = css(document.createElement('div'),
      'position:fixed;left:8px;bottom:8px;z-index:2147483647;display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;max-width:82vw');
    panel.id = 'lf-panel';
    const go = btn('Fill lesson', '#1565c0');
    const cancel = css(btn('Cancel', '#8a1c1c'), 'display:none');
    cancel.style.cssText += ';background:#8a1c1c;color:#fff;border:0;border-radius:22px;padding:10px 16px;font:600 14px system-ui,sans-serif';
    const use = btn('Use pasted text', '#2e7d32');
    use.style.display = 'none';
    const paste = css(document.createElement('textarea'),
      'display:none;width:100%;height:80px;box-sizing:border-box;font:14px system-ui,sans-serif');
    paste.placeholder = 'Long-press here → Paste the copied summary';
    panel.append(paste, go, use, cancel);

    const status = css(document.createElement('div'),
      'position:fixed;left:8px;bottom:64px;z-index:2147483647;display:none;max-width:82vw;background:#1f2a37;color:#fff;padding:10px 34px 10px 12px;border-radius:10px;font:14px/1.35 system-ui,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.4)');
    status.id = 'lf-status';
    const msg = document.createElement('span');
    const x = css(document.createElement('span'), 'position:absolute;right:10px;top:6px;font-size:18px;cursor:pointer');
    x.textContent = '×';
    x.onclick = () => { status.style.display = 'none'; };
    status.append(msg, x);

    document.body.append(status, panel);
    return { panel, go, use, cancel, paste, status, msg };
  }

  function say(text) {
    if (!ui) return;
    ui.msg.textContent = text;
    ui.status.style.display = text ? 'block' : 'none';
  }

  function showWorking(on) {
    if (!ui) return;
    ui.go.style.display = on ? 'none' : '';
    ui.cancel.style.display = on ? '' : 'none';
  }

  async function run(rec) {
    if (running) return;
    running = true;
    cancelled = false;
    showWorking(true);
    let lastStage = '';
    let lastProgress = Date.now();
    try {
      for (;;) {
        if (cancelled) return;
        const r = await advance(rec);
        if (r.state === 'done') { store.del(PENDING_KEY); say(r.message); return r; }
        if (r.state === 'stuck') { store.del(PENDING_KEY); say(r.message); return r; }
        if (r.stage !== lastStage) { lastStage = r.stage; lastProgress = Date.now(); say(`Working… (${r.stage})`); }
        if (Date.now() - lastProgress > STUCK_AFTER) {
          const m = `I’m stuck at “${lastStage}”. Do that step yourself, then tap Fill lesson again.`;
          store.del(PENDING_KEY);
          say(m);
          return { state: 'stuck', message: m };
        }
        await sleep(POLL);
      }
    } finally {
      running = false;
      showWorking(false);
    }
  }

  function begin(data) {
    const rec = { ...data, startedAt: Date.now() };
    persist(rec);
    say('Working…');
    return run(rec);
  }

  async function startFromClipboard() {
    let text = null;
    try { text = await navigator.clipboard.readText(); } catch (e) { /* fall back to pasting */ }
    const data = parseClip(text);
    if (data) return begin(data);
    ui.paste.style.display = 'block';
    ui.use.style.display = '';
    say('I couldn’t read the clipboard. Long-press the box → Paste, then tap “Use pasted text”.');
  }

  function init() {
    ui = buildUI();
    ui.go.onclick = startFromClipboard;
    ui.cancel.onclick = () => { cancelled = true; store.del(PENDING_KEY); say('Cancelled.'); };
    ui.use.onclick = () => {
      const data = parseClip(ui.paste.value);
      if (!data) { say('That text doesn’t look like a copied summary from the tracker app.'); return; }
      ui.paste.style.display = 'none';
      ui.use.style.display = 'none';
      begin(data);
    };

    // Carry on after a page load if we were in the middle of a lesson.
    const raw = store.get(PENDING_KEY);
    if (raw) {
      try {
        const rec = JSON.parse(raw);
        if (Date.now() - rec.startedAt < PENDING_MAX_AGE) { say('Continuing…'); run(rec); }
        else store.del(PENDING_KEY);
      } catch (e) { store.del(PENDING_KEY); }
    }
  }

  if (T) {
    T.api = { parseClip, fillSkills, fillNotes, begin, advance, norm, tokensOf, store, PENDING_KEY, say, init };
  }
  if (!T || !T.manualInit) init();
})();
