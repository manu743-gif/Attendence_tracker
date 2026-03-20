/**
 * ════════════════════════════════════════════════════════════════
 *  GATE 2027 Daily Study Tracker — script.js
 *  Firebase : Realtime Database (compat SDK v10)
 *  Fallback : localStorage (works offline too)
 *
 *  ⚠️  FIREBASE DATABASE RULES (set in Firebase Console):
 *  {
 *    "rules": {
 *      "gate_tracker": {
 *        ".read":  "auth != null",
 *        ".write": "auth != null"
 *      }
 *    }
 *  }
 *  Anonymous Auth is used — no email/password Firebase auth needed.
 *
 *  Sections:
 *    1.  Firebase Layer       — init, read, write, sync
 *    2.  Storage Layer        — localStorage helpers (local cache)
 *    3.  Date Utilities
 *    4.  Streak Engine
 *    5.  Countdown Engine
 *    6.  UI: Header
 *    7.  UI: Attendance
 *    8.  UI: Stats
 *    9.  UI: Calendar
 *    10. UI: Target Date
 *    11. Quotes & Tips
 *    12. Toast System
 *    13. Profile Panel
 *    14. Setup & Auth Flow
 *    15. App Bootstrap (DOMContentLoaded — ALL event listeners here)
 * ════════════════════════════════════════════════════════════════
 */

'use strict';

/* ════════════════════════════════════════════════════════════════
   §1  FIREBASE LAYER
   ════════════════════════════════════════════════════════════════ */

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyD_7a-3ZEOmnVZGUOoKhgwS1bGAuSfVVro",
  authDomain:        "attendence-mark-3f637.firebaseapp.com",
  databaseURL:       "https://attendence-mark-3f637-default-rtdb.firebaseio.com",
  projectId:         "attendence-mark-3f637",
  storageBucket:     "attendence-mark-3f637.firebasestorage.app",
  messagingSenderId: "1013467197336",
  appId:             "1:1013467197336:web:9a6b0d5bc3ed4d69d285ed",
  measurementId:     "G-LKZS240JWL"
};

let _fbDb        = null;  // firebase.database() instance
let _fbUserPath  = null;  // gate_tracker/{uid}
let _fbReady     = false; // true once auth + db are ready

/** Initialise Firebase and sign in anonymously for a stable UID */
async function firebaseInit() {
  try {
    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }
    _fbDb = firebase.database();

    // Anonymous auth → stable UID scoped to this browser/device
    const result = await firebase.auth().signInAnonymously();
    const uid    = result.user.uid;

    // Backup UID in localStorage (in case IndexedDB is cleared)
    localStorage.setItem('gate_tracker_fbuid', uid);
    _fbUserPath = `gate_tracker/${uid}`;
    _fbReady    = true;

    setFirebaseStatus('☁️', 'Connected to Firebase');
    console.log('%c 🔥 Firebase ready · path:', 'color:#f97316;font-weight:bold;', _fbUserPath);
    return true;
  } catch (err) {
    // Try fallback: use a previously stored UID if auth fails
    const backupUid = localStorage.getItem('gate_tracker_fbuid');
    if (backupUid) {
      try {
        if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
        _fbDb       = firebase.database();
        _fbUserPath = `gate_tracker/${backupUid}`;
        _fbReady    = true;
        setFirebaseStatus('☁️', 'Firebase (offline fallback)');
        return true;
      } catch (_) { /* continue to offline-only */ }
    }
    console.warn('Firebase unavailable — running offline (localStorage only):', err);
    setFirebaseStatus('📴', 'Offline — data saved locally');
    return false;
  }
}

/** Write data to Firebase at a sub-path (non-blocking, fire-and-forget) */
function fbSet(subPath, data) {
  if (!_fbReady || !_fbDb) return Promise.resolve();
  return _fbDb.ref(`${_fbUserPath}/${subPath}`).set(data)
    .then(() => setFirebaseStatus('☁️ ✓', 'Synced'))
    .catch(e  => { console.warn('Firebase write failed:', e); setFirebaseStatus('⚠️', 'Sync error'); });
}

/** Read data from Firebase at a sub-path */
async function fbGet(subPath) {
  if (!_fbReady || !_fbDb) return null;
  try {
    const snap = await _fbDb.ref(`${_fbUserPath}/${subPath}`).get();
    return snap.exists() ? snap.val() : null;
  } catch (e) {
    console.warn('Firebase read failed:', e);
    return null;
  }
}

/**
 * On app start (after auth): pull everything from Firebase and
 * overwrite local cache. Firebase is the source of truth.
 */
async function syncFromFirebase() {
  if (!_fbReady) return;
  try {
    const snap = await _fbDb.ref(_fbUserPath).get();
    if (!snap.exists()) {
      // First time on this device — push local data up
      await syncLocalToFirebase();
      return;
    }
    const d = snap.val();
    if (d.attendance) storageSet(KEYS.attendance, d.attendance);
    if (d.user)       storageSet(KEYS.user,       d.user);
    if (d.title)      storageSet(KEYS.title,      d.title);
    if (d.setup != null) storageSet(KEYS.setup,   d.setup);
    console.log('✅ Synced from Firebase');
    setFirebaseStatus('☁️ ✓', 'Synced from cloud');
    refreshAll(); // refresh UI with cloud data
  } catch (e) {
    console.warn('Firebase sync-from failed:', e);
  }
}

/** Push all local data up to Firebase (used when a new device connects) */
async function syncLocalToFirebase() {
  if (!_fbReady) return;
  const payload = {
    attendance: attendanceLoad(),
    user:       userLoad(),
    title:      titleLoad(),
    setup:      isSetupDone(),
  };
  await fbSet('', payload).catch(e => console.warn('syncLocal failed:', e));
}

function setFirebaseStatus(icon, tip) {
  const el = document.getElementById('firebaseStatus');
  if (!el) return;
  el.textContent = icon;
  el.title = tip;
}


/* ════════════════════════════════════════════════════════════════
   §2  STORAGE LAYER  (localStorage as local cache)
   Keys:
     gate2027_attendance  → { "YYYY-MM-DD": { attended, goalMet } }
     gate_tracker_title   → string
     gate_tracker_user    → { name, email, passwordHash, targetDate }
     gate_tracker_setup   → boolean
   ════════════════════════════════════════════════════════════════ */

const KEYS = {
  attendance : 'gate2027_attendance',
  title      : 'gate_tracker_title',
  user       : 'gate_tracker_user',
  setup      : 'gate_tracker_setup',
};

function storageGet(key)        { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function storageSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn('StorageSet:', e); } }

function attendanceLoad()              { return storageGet(KEYS.attendance) || {}; }
function attendanceGetDate(dateStr)    { return attendanceLoad()[dateStr] || null; }

function attendanceMark(dateStr, updates) {
  const data = attendanceLoad();
  data[dateStr] = { ...(data[dateStr] || {}), ...updates };
  storageSet(KEYS.attendance, data);
  // Firebase: update just the one date record
  fbSet(`attendance/${dateStr}`, data[dateStr]);
}

function userLoad()         { return storageGet(KEYS.user) || null; }
function userSave(data)     { storageSet(KEYS.user, data); fbSet('user', data); }

function titleLoad()        { return storageGet(KEYS.title) || 'GATE 2027'; }
function titleSave(t)       { storageSet(KEYS.title, t); fbSet('title', t); }

function isSetupDone()      { return storageGet(KEYS.setup) === true; }
function markSetupDone()    { storageSet(KEYS.setup, true); fbSet('setup', true); }

function resetAllData() {
  Object.values(KEYS).forEach(k => localStorage.removeItem(k));
  localStorage.removeItem('gate_tracker_fbuid');
  // Also wipe Firebase node (best-effort)
  if (_fbReady && _fbDb) _fbDb.ref(_fbUserPath).remove().catch(() => {});
}


/* ════════════════════════════════════════════════════════════════
   §3  AUTH HELPERS
   ⚠️  LOCAL ONLY — this is a device privacy lock, not server auth.
   Firebase Auth used only for RTDB access (anonymous sign-in).
   ════════════════════════════════════════════════════════════════ */

async function hashPassword(plaintext) {
  const encoder  = new TextEncoder();
  const data     = encoder.encode(plaintext);
  const hashBuf  = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(plaintext, storedHash) {
  return (await hashPassword(plaintext)) === storedHash;
}


/* ════════════════════════════════════════════════════════════════
   §4  DATE UTILITIES
   ════════════════════════════════════════════════════════════════ */

function getTodayStr() { return formatDate(new Date()); }

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function subtractDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() - n);
  return formatDate(d);
}

function friendlyDate(date) {
  return date.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function daysSince(firstDateStr) {
  const first = parseDate(firstDateStr); first.setHours(0,0,0,0);
  const today = new Date(); today.setHours(0,0,0,0);
  return Math.max(1, Math.floor((today - first) / 86400000) + 1);
}

function formatExamDate(dateStr) {
  if (!dateStr) return null;
  return parseDate(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}


/* ════════════════════════════════════════════════════════════════
   §5  STREAK ENGINE
   ════════════════════════════════════════════════════════════════ */

function calculateStreak(data) {
  let streak = 0, check = getTodayStr();
  while (true) {
    if (data[check]?.attended) { streak++; check = subtractDays(check, 1); }
    else break;
  }
  return streak;
}

function computeStats(data) {
  const allDates  = Object.keys(data).filter(d => data[d]?.attended).sort();
  const total     = allDates.length;
  const streak    = calculateStreak(data);
  let consistency = 0;
  if (total > 0) consistency = Math.min(100, Math.round((total / daysSince(allDates[0])) * 100));
  return { total, streak, consistency, firstDate: allDates[0] || null };
}


/* ════════════════════════════════════════════════════════════════
   §6  COUNTDOWN ENGINE
   ════════════════════════════════════════════════════════════════ */

function computeCountdown(targetDateStr, firstStudyDateStr) {
  if (!targetDateStr) return null;
  const today  = new Date(); today.setHours(0,0,0,0);
  const target = parseDate(targetDateStr); target.setHours(0,0,0,0);
  const daysLeft = Math.round((target - today) / 86400000);
  if (daysLeft < 0) return { daysLeft: 0, totalDays: 0, pctElapsed: 100, urgency: 'past' };
  const start     = parseDate(firstStudyDateStr || getTodayStr()); start.setHours(0,0,0,0);
  const totalDays  = Math.max(1, Math.round((target - start) / 86400000));
  const elapsed    = Math.round((today - start) / 86400000);
  const pctElapsed = Math.min(100, Math.max(0, Math.round((elapsed / totalDays) * 100)));
  let urgency = daysLeft <= 21 ? 'urgent' : daysLeft <= 60 ? 'soon' : 'normal';
  return { daysLeft, totalDays, pctElapsed, urgency };
}


/* ════════════════════════════════════════════════════════════════
   §7  UI: HEADER
   ════════════════════════════════════════════════════════════════ */

function renderTitle() {
  const t = titleLoad();
  const el = document.getElementById('brandTagText');
  if (el) el.textContent = t;
  const lockTitle = document.getElementById('lockAppTitle');
  if (lockTitle) lockTitle.textContent = t;
  document.title = `${t} Study Tracker`;
}

function renderHeaderDate() {
  const el = document.getElementById('currentDateDisplay');
  if (el) el.textContent = friendlyDate(new Date()).toUpperCase();
}

function renderHeaderUser() {
  const user = userLoad();
  if (!user) return;
  const name = user.name || 'User';
  const greeting = document.getElementById('headerGreeting');
  if (greeting) greeting.textContent = `Hello, ${name} 👋`;
  const avatar = document.getElementById('profileAvatar');
  if (avatar) avatar.textContent = name.charAt(0).toUpperCase();
}

function initEditableTitle() {
  const tag   = document.getElementById('brandTag');
  const text  = document.getElementById('brandTagText');
  const input = document.getElementById('brandTagInput');
  if (!tag || !text || !input) return;

  function enterEdit() {
    input.value = titleLoad();
    tag.classList.add('editing');
    input.focus(); input.select();
  }
  function exitEdit() {
    const newVal = input.value.trim() || 'GATE 2027';
    titleSave(newVal);
    tag.classList.remove('editing');
    renderTitle();
    showToast(`App title updated to "${newVal}"`, 'success');
  }

  tag.addEventListener('click', () => { if (!tag.classList.contains('editing')) enterEdit(); });
  document.getElementById('brandTagPencil')?.addEventListener('click', e => { e.stopPropagation(); enterEdit(); });
  input.addEventListener('blur',    exitEdit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); exitEdit(); }
    if (e.key === 'Escape') { tag.classList.remove('editing'); }
  });
}


/* ════════════════════════════════════════════════════════════════
   §8  UI: ATTENDANCE
   ════════════════════════════════════════════════════════════════ */

function renderTodayStatus(attended) {
  const dot   = document.getElementById('statusDot');
  const text  = document.getElementById('statusText');
  const btn   = document.getElementById('markBtn');
  const icon  = document.getElementById('markBtnIcon');
  const label = document.getElementById('markBtnText');
  if (!dot) return;
  if (attended) {
    dot.className = 'status-dot dot--marked';
    text.textContent  = 'Marked Today ✅';
    btn.disabled      = true;
    icon.textContent  = '✅';
    label.textContent = 'Already Marked Today';
  } else {
    dot.className = 'status-dot dot--missed';
    text.textContent  = 'Not Marked Today ❌';
    btn.disabled      = false;
    icon.textContent  = '✅';
    label.textContent = "Mark Today's Study";
  }
}

function renderGoalState(goalMet) {
  const check = document.getElementById('goalCheck');
  const badge = document.getElementById('goalBadge');
  if (!check) return;
  check.checked = !!goalMet;
  if (goalMet) { badge.textContent = '2hrs ✓'; badge.classList.add('visible'); }
  else         { badge.textContent = '—';       badge.classList.remove('visible'); }
}

function handleMarkToday() {
  const todayStr = getTodayStr();
  if (attendanceGetDate(todayStr)?.attended) { showToast('Already marked for today! ✅', 'warn'); return; }
  attendanceMark(todayStr, { attended: true });
  triggerRipple();
  refreshAll();
  showToast('🔥 Attendance marked! Keep the streak alive.', 'success');
}

function handleGoalToggle(e) {
  const todayStr = getTodayStr();
  const goalMet  = e.target.checked;
  if (!attendanceGetDate(todayStr)?.attended) {
    e.target.checked = false;
    showToast('Mark attendance first! ⚠️', 'warn');
    return;
  }
  attendanceMark(todayStr, { goalMet });
  renderGoalState(goalMet);
  renderCalendar();
  showToast(goalMet ? '🎯 2-hour goal logged!' : '2-hour goal unmarked.', goalMet ? 'success' : 'warn');
}

function triggerRipple() {
  const ripple = document.getElementById('btnRipple');
  if (!ripple) return;
  ripple.classList.remove('ripple--active');
  void ripple.offsetWidth;
  ripple.classList.add('ripple--active');
  setTimeout(() => ripple.classList.remove('ripple--active'), 700);
}


/* ════════════════════════════════════════════════════════════════
   §9  UI: STATS
   ════════════════════════════════════════════════════════════════ */

function renderStats(stats) {
  animateCount('streakCount', stats.streak);
  animateCount('totalCount',  stats.total);
  const el = document.getElementById('consistencyPercent');
  if (el) el.textContent = stats.consistency + '%';
}

function animateCount(elId, target) {
  const el = document.getElementById(elId);
  if (!el) return;
  const current = parseInt(el.textContent) || 0;
  if (current === target) return;
  const step  = target > current ? 1 : -1;
  const steps = Math.abs(target - current);
  const delay = Math.max(16, Math.min(60, 400 / steps));
  let val = current;
  const timer = setInterval(() => { val += step; el.textContent = val; if (val === target) clearInterval(timer); }, delay);
}


/* ════════════════════════════════════════════════════════════════
   §10  UI: CALENDAR
   ════════════════════════════════════════════════════════════════ */

let calState = { year: new Date().getFullYear(), month: new Date().getMonth() };
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function renderCalendar() {
  const { year, month } = calState;
  const data     = attendanceLoad();
  const todayStr = getTodayStr();
  const todayMid = new Date(); todayMid.setHours(0,0,0,0);

  document.getElementById('calMonthLabel').textContent = `${MONTH_NAMES[month]} ${year}`;
  const grid = document.getElementById('calGrid');
  grid.innerHTML = '';

  const firstDow    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  for (let i = 0; i < firstDow; i++) {
    const blank = document.createElement('div');
    blank.className = 'cal-day cal-day--empty';
    blank.setAttribute('aria-hidden', 'true');
    grid.appendChild(blank);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr  = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const rec      = data[dateStr] || {};
    const isToday  = dateStr === todayStr;
    const cellDate = new Date(year, month, d); cellDate.setHours(0,0,0,0);
    const isPast   = cellDate < todayMid && !isToday;
    const isFuture = cellDate > todayMid;

    const cell = document.createElement('div');
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('aria-label', `${d} ${MONTH_NAMES[month]} ${year}`);

    let cls = 'cal-day';
    if (isFuture)                  cls += ' cal-day--future';
    else if (rec.attended && rec.goalMet) { cls += ' cal-day--goal';     cell.title = 'Attended + 2-hr goal ✅🎯'; }
    else if (rec.attended)         { cls += ' cal-day--attended'; cell.title = 'Attended ✅'; }
    else if (isPast)               { cls += ' cal-day--missed';   cell.title = 'Missed ❌'; }
    if (isToday) cls += ' cal-day--today';

    cell.className   = cls;
    cell.textContent = d;
    grid.appendChild(cell);
  }
  renderProgress(year, month);
}

function renderProgress(year, month) {
  const data  = attendanceLoad();
  const today = new Date();
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const lastDay = (year === today.getFullYear() && month === today.getMonth()) ? today.getDate() : daysInMonth;
  let attended = 0;
  for (let d = 1; d <= lastDay; d++) {
    const ds = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if (data[ds]?.attended) attended++;
  }
  const pct = lastDay > 0 ? Math.round((attended / lastDay) * 100) : 0;
  const fill = document.getElementById('progressFill');
  const bar  = document.getElementById('progressBar');
  const lbl  = document.getElementById('progressLabel');
  if (fill) fill.style.width = pct + '%';
  if (bar)  bar.setAttribute('aria-valuenow', pct);
  if (lbl)  lbl.textContent = `${attended} / ${lastDay} days`;
}


/* ════════════════════════════════════════════════════════════════
   §11  UI: TARGET DATE & COUNTDOWN
   ════════════════════════════════════════════════════════════════ */

function renderTargetDate() {
  const user       = userLoad();
  const targetDate = user?.targetDate || null;
  const display    = document.getElementById('targetDateDisplay');
  const input      = document.getElementById('targetDateInput');
  if (display) display.textContent = targetDate ? formatExamDate(targetDate) : 'Not set';
  if (input && targetDate) input.value = targetDate;
  renderCountdown(targetDate);
}

function renderCountdown(targetDateStr) {
  const stats = computeStats(attendanceLoad());
  const info  = computeCountdown(targetDateStr, stats.firstDate);
  const numEl   = document.getElementById('daysLeft');
  const lblEl   = document.getElementById('daysLeftLabel');
  const examEl  = document.getElementById('countdownExamName');
  const barEl   = document.getElementById('countdownBar');
  const progLbl = document.getElementById('countdownProgressLabel');

  if (!info) {
    if (numEl)  numEl.textContent  = '—';
    if (examEl) examEl.textContent = 'Set your target date →';
    if (barEl)  barEl.style.width  = '0%';
    return;
  }
  if (info.urgency === 'past') {
    if (numEl)  { numEl.textContent = '0'; numEl.className = 'countdown-number'; }
    if (examEl) examEl.textContent = 'Exam date has passed!';
    if (barEl)  barEl.style.width  = '100%';
    return;
  }
  if (numEl) {
    numEl.textContent = info.daysLeft;
    numEl.className   = `countdown-number${info.urgency === 'urgent' ? ' urgent' : ''}`;
  }
  if (lblEl)   lblEl.textContent  = info.daysLeft === 1 ? 'day left' : 'days left';
  if (examEl)  examEl.textContent = `${titleLoad()} — ${formatExamDate(targetDateStr)}`;
  if (barEl)   barEl.style.width  = info.pctElapsed + '%';
  if (progLbl) progLbl.textContent = `${info.pctElapsed}% of prep time elapsed`;
}

function handleSaveTargetDate() {
  const input = document.getElementById('targetDateInput');
  const val   = input?.value;
  if (!val) { showToast('Please select a date first.', 'warn'); return; }
  const user = userLoad() || {};
  user.targetDate = val;
  userSave(user);
  renderTargetDate();
  refreshTip();
  showToast(`🎯 Target date set to ${formatExamDate(val)}!`, 'success');
}


/* ════════════════════════════════════════════════════════════════
   §12  QUOTES & TIPS
   ════════════════════════════════════════════════════════════════ */

const QUOTES = [
  "Consistency beats motivation — show up every day.",
  "GATE is a marathon, not a sprint. Pace yourself.",
  "One focused hour is worth ten distracted ones.",
  "Your future self is counting on today's effort.",
  "Small daily improvements lead to stunning results.",
  "Don't break the chain.",
  "Excellence is not an act — it's a habit.",
  "Study like your rank depends on it — because it does.",
  "Pressure makes diamonds. Keep going.",
  "You didn't come this far to only come this far.",
  "Hard work quietly defeats talent every single time.",
  "One day or day one. You decide.",
  "Sleep is not laziness when paired with discipline.",
  "Every formula you memorize today saves marks tomorrow.",
];

let lastQuoteIdx = -1;

function showRandomQuote() {
  let idx;
  do { idx = Math.floor(Math.random() * QUOTES.length); }
  while (idx === lastQuoteIdx && QUOTES.length > 1);
  lastQuoteIdx = idx;
  const el = document.getElementById('quoteText');
  if (!el) return;
  el.style.opacity = '0';
  setTimeout(() => { el.textContent = `"${QUOTES[idx]}"`; el.style.opacity = '1'; }, 200);
}

const STUDY_TIPS = [
  "Revise yesterday's notes before starting today.",
  "Use the Pomodoro technique: 25 min study, 5 min break.",
  "Solve at least one PYQ every day.",
  "Write formulas from memory — don't just read them.",
  "Sleep 7–8 hours. Memory consolidates during sleep.",
  "Start with your weakest subject each morning.",
  "Mock tests are practice exams — take them seriously.",
];

function refreshTip() {
  const el = document.getElementById('tipText');
  if (!el) return;
  const user = userLoad();
  if (user?.targetDate) {
    const info = computeCountdown(user.targetDate, null);
    if (info?.daysLeft <= 30) { el.textContent = "📣 Final stretch! Focus on weak areas and PYQs only."; return; }
  }
  el.textContent = STUDY_TIPS[Math.floor(Math.random() * STUDY_TIPS.length)];
}


/* ════════════════════════════════════════════════════════════════
   §13  TOAST SYSTEM
   ════════════════════════════════════════════════════════════════ */

let toastTimer = null;

function showToast(msg, type = 'success', duration = 3200) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  if (toastTimer) clearTimeout(toastTimer);
  toast.className = 'toast';
  void toast.offsetWidth;
  toast.textContent = msg;
  toast.classList.add('toast--show', `toast--${type}`);
  toastTimer = setTimeout(() => toast.classList.remove('toast--show'), duration);
}


/* ════════════════════════════════════════════════════════════════
   §14  PROFILE PANEL
   ════════════════════════════════════════════════════════════════ */

function showProfileCard() {
  const card  = document.getElementById('profileCard');
  const input = document.getElementById('editName');
  if (!card || !input) return;
  input.value = userLoad()?.name || '';
  card.hidden = false;
}

function hideProfileCard() {
  const card = document.getElementById('profileCard');
  if (card) card.hidden = true;
}

function handleSaveProfile() {
  const input = document.getElementById('editName');
  const name  = input?.value.trim();
  if (!name) { showToast('Name cannot be empty.', 'warn'); return; }
  const user = userLoad() || {};
  user.name = name;
  userSave(user);
  renderHeaderUser();
  hideProfileCard();
  showToast(`Profile updated! Hello, ${name} 👋`, 'success');
}


/* ════════════════════════════════════════════════════════════════
   §15  SETUP FLOW HELPERS
   ════════════════════════════════════════════════════════════════ */

let currentStep = 1;

function showStep(n) {
  [1, 2, 3].forEach(i => {
    const s = document.getElementById(`step${i}`);
    if (s) s.hidden = (i !== n);
    const dot = document.querySelector(`.step-dot[data-step="${i}"]`);
    if (dot) dot.classList.toggle('step-dot--active', i === n);
  });
  currentStep = n;
}

function showStepError(step, msg, highlightId = null) {
  const el = document.getElementById(`setupError${step}`);
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  if (highlightId) {
    const field = document.getElementById(highlightId);
    if (field) {
      field.style.borderColor = 'var(--accent-red)';
      field.style.boxShadow   = '0 0 0 3px rgba(239,68,68,0.2)';
      field.classList.add('field-shake');
      field.focus();
      setTimeout(() => field.classList.remove('field-shake'), 500);
      field.addEventListener('input', () => { field.style.borderColor = ''; field.style.boxShadow = ''; }, { once: true });
    }
  }
}

function clearStepError(step) {
  const el = document.getElementById(`setupError${step}`);
  if (el) el.hidden = true;
}

function showSetupModal() {
  const el = document.getElementById('setupOverlay');
  const targetInput = document.getElementById('setupTargetDate');
  if (targetInput) {
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    targetInput.min = formatDate(tomorrow);
  }
  showStep(1);
  if (el) el.hidden = false;
}

function showLockScreen() {
  const user = userLoad();
  const el = document.getElementById('lockOverlay');
  const nameEl   = document.getElementById('lockName');
  const emailEl  = document.getElementById('lockEmail');
  const avatarEl = document.getElementById('lockAvatar');
  const titleEl  = document.getElementById('lockAppTitle');
  if (nameEl)   nameEl.textContent   = user?.name  || 'User';
  if (emailEl)  emailEl.textContent  = user?.email || '';
  if (avatarEl) avatarEl.textContent = (user?.name || 'U').charAt(0).toUpperCase();
  if (titleEl)  titleEl.textContent  = titleLoad();
  if (el) el.hidden = false;
}

function hideOverlays() {
  document.getElementById('setupOverlay').hidden = true;
  document.getElementById('lockOverlay').hidden  = true;
}


/* ════════════════════════════════════════════════════════════════
   FULL REFRESH
   ════════════════════════════════════════════════════════════════ */

function refreshAll() {
  const data     = attendanceLoad();
  const todayStr = getTodayStr();
  const todayRec = data[todayStr] || {};
  const stats    = computeStats(data);
  renderStats(stats);
  renderTodayStatus(!!todayRec.attended);
  renderGoalState(!!todayRec.goalMet);
  renderCalendar();
  renderTargetDate();
}

function initMainApp() {
  const app = document.getElementById('mainApp');
  if (app) app.hidden = false;
  renderHeaderDate();
  renderTitle();
  renderHeaderUser();
  initEditableTitle();
  showRandomQuote();
  refreshAll();
  refreshTip();
  scheduleAutoRefreshAtMidnight();

  // Set min date for target date input
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const targetInput = document.getElementById('targetDateInput');
  if (targetInput) targetInput.min = formatDate(tomorrow);

  // Sync from Firebase in background (doesn't block UI)
  syncFromFirebase();

  console.log('%c GATE Tracker loaded ✅', 'color:#00e5a0;font-weight:bold;font-size:14px;');
}

function scheduleAutoRefreshAtMidnight() {
  const now  = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  setTimeout(() => {
    renderHeaderDate();
    refreshAll();
    showToast('🌅 New day! Keep your streak alive.', 'success', 5000);
    scheduleAutoRefreshAtMidnight();
  }, next - now);
}


/* ════════════════════════════════════════════════════════════════
   §16  BOOTSTRAP — ALL EVENT LISTENERS inside DOMContentLoaded
   🔑  ROOT CAUSE FIX: Previously event listeners were attached at
       the top level BEFORE the DOM was parsed, so getElementById
       returned null and no handler was ever registered. Everything
       must be inside DOMContentLoaded.
   ════════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {

  // ── STEP 1 ──
  document.getElementById('step1Next').addEventListener('click', () => {
    const name  = document.getElementById('setupName').value.trim();
    const email = document.getElementById('setupEmail').value.trim();
    clearStepError(1);
    if (!name)                      { showStepError(1, 'Please enter your display name.', 'setupName'); return; }
    if (!email || !email.includes('@')) { showStepError(1, 'Please enter a valid email.', 'setupEmail'); return; }
    showStep(2);
    document.getElementById('setupPassword').focus();
  });

  // ── STEP 2 ──
  document.getElementById('step2Back').addEventListener('click', () => { clearStepError(2); showStep(1); });
  document.getElementById('step2Next').addEventListener('click', () => {
    const pw  = document.getElementById('setupPassword').value;
    const pw2 = document.getElementById('setupPasswordConfirm').value;
    clearStepError(2);
    if (pw.length < 4) { showStepError(2, 'Password must be at least 4 characters.', 'setupPassword'); return; }
    if (pw !== pw2)    { showStepError(2, 'Passwords do not match.', 'setupPasswordConfirm'); return; }
    showStep(3);
    document.getElementById('setupTargetDate').focus();
  });

  // ── STEP 3 / SUBMIT ──
  document.getElementById('step3Back').addEventListener('click', () => { clearStepError(3); showStep(2); });

  document.getElementById('setupSubmit').addEventListener('click', async () => {
    const name       = document.getElementById('setupName').value.trim();
    const email      = document.getElementById('setupEmail').value.trim();
    const pw         = document.getElementById('setupPassword').value;
    const titleVal   = document.getElementById('setupAppTitle').value.trim() || 'GATE 2027';
    const targetDate = document.getElementById('setupTargetDate').value;

    clearStepError(3);

    // Validate step 3 fields
    if (!targetDate) { showStepError(3, '📅 Please select your target exam date.', 'setupTargetDate'); return; }

    // Validate earlier steps' data is still present (in case of edge cases)
    if (!name || !email || !pw) {
      showStepError(3, 'Some required fields are missing. Please go back and fill them in.');
      return;
    }

    const btn = document.getElementById('setupSubmit');
    const originalHTML = btn.innerHTML;
    btn.disabled  = true;
    btn.innerHTML = '⏳ Setting up…';

    try {
      const passwordHash = await hashPassword(pw);

      // Save to localStorage immediately
      userSave({ name, email, passwordHash, targetDate });
      titleSave(titleVal);
      markSetupDone();

      // Now init Firebase and push data up
      await firebaseInit();
      await syncLocalToFirebase();

      hideOverlays();
      initMainApp();
      showToast(`Welcome, ${name}! 🚀 Let's crack GATE!`, 'success', 5000);
    } catch (err) {
      console.error('Setup error:', err);
      showStepError(3, `Error: ${err.message || 'Something went wrong. Try again.'}`);
      btn.disabled  = false;
      btn.innerHTML = originalHTML;
    }
  });

  // ── LOCK SCREEN ──
  document.getElementById('unlockBtn').addEventListener('click', async () => {
    const pw    = document.getElementById('lockPassword').value;
    const user  = userLoad();
    const errEl = document.getElementById('lockError');
    const btn   = document.getElementById('unlockBtn');

    btn.disabled  = true;
    btn.innerHTML = '⏳ Checking…';

    try {
      const ok = await verifyPassword(pw, user.passwordHash);
      if (ok) {
        errEl.hidden = true;
        document.getElementById('lockPassword').value = '';
        hideOverlays();
        // Init Firebase, then show app (Firebase sync happens inside initMainApp)
        firebaseInit().then(() => syncFromFirebase());
        initMainApp();
      } else {
        errEl.hidden          = false;
        document.getElementById('lockPassword').value = '';
        document.getElementById('lockPassword').focus();
      }
    } catch (e) {
      errEl.textContent = `Error: ${e.message}`;
      errEl.hidden      = false;
    } finally {
      btn.disabled  = false;
      btn.innerHTML = '🔓 Unlock';
    }
  });

  // Also unlock on Enter key in password field
  document.getElementById('lockPassword').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('unlockBtn').click();
  });

  // ── FORGOT PASSWORD ──
  document.getElementById('forgotBtn').addEventListener('click', () => {
    const ok = confirm('⚠️ RESET APP?\n\nThis will permanently delete ALL your attendance data and account info.\n\nClick OK to confirm.');
    if (!ok) return;
    const word = prompt('Type RESET to confirm:');
    if (word?.trim().toUpperCase() === 'RESET') {
      resetAllData();
      location.reload();
    } else {
      showToast('Reset cancelled — nothing deleted.', 'warn');
    }
  });

  // ── MAIN APP EVENTS ──
  document.getElementById('markBtn').addEventListener('click', handleMarkToday);
  document.getElementById('goalCheck').addEventListener('change', handleGoalToggle);
  document.getElementById('quoteRefresh').addEventListener('click', showRandomQuote);
  document.getElementById('saveTargetDateBtn').addEventListener('click', handleSaveTargetDate);

  document.getElementById('profileBtn').addEventListener('click', () => {
    const card = document.getElementById('profileCard');
    card.hidden ? showProfileCard() : hideProfileCard();
  });
  document.getElementById('saveProfileBtn').addEventListener('click', handleSaveProfile);
  document.getElementById('cancelProfileBtn').addEventListener('click', hideProfileCard);

  document.getElementById('prevMonth').addEventListener('click', () => {
    if (calState.month === 0) { calState.month = 11; calState.year--; }
    else calState.month--;
    renderCalendar();
  });
  document.getElementById('nextMonth').addEventListener('click', () => {
    if (calState.month === 11) { calState.month = 0; calState.year++; }
    else calState.month++;
    renderCalendar();
  });

  // ── BOOT DECISION ──
  if (!isSetupDone()) {
    showSetupModal();
  } else {
    showLockScreen();
    // Start Firebase in the background while user types password
    firebaseInit();
  }
});
