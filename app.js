import { firebaseConfig, isConfigured } from "./config.js";
import { academicEvents, academicMeta } from "./academic-calendar.js";

// ============================================================
//  전역 상태
// ============================================================
const TZ = "Asia/Seoul";
const CAL_SCOPE = "https://www.googleapis.com/auth/calendar.events";

// 일정 분류 정의
const CATEGORIES = {
  work:    { label: "업무", color: "#3b6ef5", googleColorId: "9" },   // 파랑
  subject: { label: "교과", color: "#1c9963", googleColorId: "10" },  // 초록
};
const ACADEMIC_COLOR = "#e08a1e";  // 학사(주황)
const HOLIDAY_COLOR = "#e5484d";   // 공휴일(빨강)

function catColor(ev) {
  if (ev.category === "academic") return ev.holiday ? HOLIDAY_COLOR : ACADEMIC_COLOR;
  return CATEGORIES[ev.category]?.color || CATEGORIES.work.color;
}

const state = {
  view: new Date(),        // 현재 보고 있는 달
  selected: null,          // 선택한 날짜 (YYYY-MM-DD)
  events: [],              // 현재 달의 일정 (정규화된 형태)
  memos: [],               // 메모 목록
  user: null,              // Firebase 사용자
  calToken: null,          // 구글 캘린더 접근 토큰
  synced: false,           // 클라우드 동기화 활성 여부
  editingEventId: null,    // 모달에서 수정 중인 일정 id
  filters: { work: true, subject: true, academic: true }, // 레이어 표시 여부
  memoCats: [],            // 메모 항목(카테고리) 목록
};

// 메모 항목 관련
const DEFAULT_MEMO_CATS = ["수업", "업무", "개인"];
const UNCAT = "미분류";
const LOCAL_MEMOCATS_KEY = "myplanner.memocats";

// Firebase 핸들 (설정된 경우에만 채워짐)
let fb = null;

// ============================================================
//  유틸
// ============================================================
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}

function fmtMonthTitle(d) {
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}
function fmtDayTitle(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = ["일", "월", "화", "수", "목", "금", "토"][new Date(y, m - 1, d).getDay()];
  return `${m}월 ${d}일 (${wd})`;
}

// ============================================================
//  저장소 계층 — 클라우드(Firebase) 또는 로컬(localStorage)
// ============================================================
const LOCAL_EVENTS_KEY = "myplanner.events";
const LOCAL_MEMOS_KEY = "myplanner.memos";

function loadLocal(key) {
  try { return JSON.parse(localStorage.getItem(key)) || []; }
  catch { return []; }
}
function saveLocal(key, arr) {
  localStorage.setItem(key, JSON.stringify(arr));
}
function uid() {
  return "id-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ---------- 일정 ----------
async function fetchEvents(monthDate) {
  if (state.synced && state.calToken) {
    return fetchGoogleEvents(monthDate);
  }
  // 로컬: 해당 달의 일정만 필터
  const prefix = `${monthDate.getFullYear()}-${pad(monthDate.getMonth() + 1)}`;
  return loadLocal(LOCAL_EVENTS_KEY).filter((e) => e.date.startsWith(prefix));
}

async function saveEvent(ev) {
  if (state.synced && state.calToken) return saveGoogleEvent(ev);
  const all = loadLocal(LOCAL_EVENTS_KEY);
  if (ev.id) {
    const i = all.findIndex((e) => e.id === ev.id);
    if (i >= 0) all[i] = ev;
  } else {
    ev.id = uid();
    all.push(ev);
  }
  saveLocal(LOCAL_EVENTS_KEY, all);
}

async function deleteEvent(ev) {
  if (state.synced && state.calToken) return deleteGoogleEvent(ev);
  const all = loadLocal(LOCAL_EVENTS_KEY).filter((e) => e.id !== ev.id);
  saveLocal(LOCAL_EVENTS_KEY, all);
}

// ---------- 메모 (로컬 모드) ----------
function loadLocalMemos() {
  return loadLocal(LOCAL_MEMOS_KEY).sort((a, b) => b.createdAt - a.createdAt);
}

// ============================================================
//  구글 캘린더 API
// ============================================================
async function calApi(path, options = {}) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${state.calToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    state.calToken = null;
    toast("구글 인증이 만료되었습니다. 다시 로그인해 주세요.");
    throw new Error("calendar-auth-expired");
  }
  if (!res.ok) throw new Error(`calendar-api ${res.status}`);
  return res.status === 204 ? null : res.json();
}

function monthRange(d) {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

async function fetchGoogleEvents(monthDate) {
  const { timeMin, timeMax } = monthRange(monthDate);
  const params = new URLSearchParams({
    timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250",
  });
  const data = await calApi(`/calendars/primary/events?${params}`);
  return (data.items || []).map(normalizeGoogleEvent);
}

function normalizeGoogleEvent(g) {
  const allDay = !!g.start.date;
  const date = allDay ? g.start.date : g.start.dateTime.slice(0, 10);
  const start = allDay ? null : g.start.dateTime.slice(11, 16);
  const end = allDay ? null : (g.end.dateTime ? g.end.dateTime.slice(11, 16) : null);
  const category = g.extendedProperties?.private?.category || "work";
  return { id: g.id, title: g.summary || "(제목 없음)", date, start, end, allDay, desc: g.description || "", category };
}

function toGoogleBody(ev) {
  const category = CATEGORIES[ev.category] ? ev.category : "work";
  const body = {
    summary: ev.title,
    description: ev.desc || "",
    colorId: CATEGORIES[category].googleColorId,
    extendedProperties: { private: { category } },
  };
  if (ev.allDay || !ev.start) {
    const [y, m, d] = ev.date.split("-").map(Number);
    const next = new Date(y, m - 1, d + 1);
    body.start = { date: ev.date };
    body.end = { date: ymd(next) };
  } else {
    body.start = { dateTime: `${ev.date}T${ev.start}:00`, timeZone: TZ };
    const endT = ev.end && ev.end > ev.start ? ev.end : ev.start;
    body.end = { dateTime: `${ev.date}T${endT}:00`, timeZone: TZ };
  }
  return body;
}

async function saveGoogleEvent(ev) {
  const body = toGoogleBody(ev);
  if (ev.id) {
    await calApi(`/calendars/primary/events/${ev.id}`, { method: "PATCH", body: JSON.stringify(body) });
  } else {
    await calApi(`/calendars/primary/events`, { method: "POST", body: JSON.stringify(body) });
  }
}

async function deleteGoogleEvent(ev) {
  await calApi(`/calendars/primary/events/${ev.id}`, { method: "DELETE" });
}

// ============================================================
//  캘린더 렌더링
// ============================================================
async function refreshEvents() {
  try {
    state.events = await fetchEvents(state.view);
  } catch (e) {
    state.events = [];
    if (e.message !== "calendar-auth-expired") toast("일정을 불러오지 못했습니다.");
  }
  renderCalendar();
  if (state.selected) renderDayDetail();
}

// 학사일정(해당 달) — 읽기 전용 레이어
function academicForMonth() {
  const prefix = `${state.view.getFullYear()}-${pad(state.view.getMonth() + 1)}`;
  return academicEvents
    .filter((a) => a.date.startsWith(prefix))
    .map((a, i) => ({
      id: `ac-${a.date}-${i}`, title: a.title, date: a.date,
      allDay: true, start: null, end: null, desc: "",
      category: "academic", holiday: a.holiday, readOnly: true,
    }));
}

// 필터를 적용한, 화면에 보일 일정 전체
function visibleEvents() {
  const out = [];
  for (const ev of state.events) {
    const cat = ev.category || "work";
    if (state.filters[cat]) out.push({ ...ev, category: cat });
  }
  if (state.filters.academic) out.push(...academicForMonth());
  return out;
}

function eventsByDate() {
  const map = {};
  for (const ev of visibleEvents()) (map[ev.date] ||= []).push(ev);
  // 정렬: 학사(공휴일 먼저) → 종일 → 시간순
  for (const k in map) {
    map[k].sort((a, b) => {
      const rank = (e) => (e.category === "academic" ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return (a.start || "").localeCompare(b.start || "");
    });
  }
  return map;
}

function renderCalendar() {
  $("cal-title").textContent = fmtMonthTitle(state.view);
  const grid = $("calendar-grid");
  grid.innerHTML = "";

  const year = state.view.getFullYear();
  const month = state.view.getMonth();
  const first = new Date(year, month, 1);
  const startDay = first.getDay();             // 0=일
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const map = eventsByDate();
  const today = todayStr();

  // 앞쪽 이전 달 빈칸
  const prevDays = new Date(year, month, 0).getDate();
  for (let i = startDay - 1; i >= 0; i--) {
    grid.appendChild(makeCell(new Date(year, month - 1, prevDays - i), true, map, today));
  }
  // 이번 달
  for (let d = 1; d <= daysInMonth; d++) {
    grid.appendChild(makeCell(new Date(year, month, d), false, map, today));
  }
  // 뒤쪽 다음 달 빈칸 (6주 채우기)
  const filled = startDay + daysInMonth;
  const trailing = (7 - (filled % 7)) % 7;
  for (let d = 1; d <= trailing; d++) {
    grid.appendChild(makeCell(new Date(year, month + 1, d), true, map, today));
  }
}

function makeCell(dateObj, otherMonth, map, today) {
  const cell = document.createElement("div");
  cell.className = "cal-cell";
  const dateStr = ymd(dateObj);
  const dow = dateObj.getDay();
  if (otherMonth) cell.classList.add("other-month");
  if (dow === 0) cell.classList.add("sun");
  if (dow === 6) cell.classList.add("sat");
  if (dateStr === today) cell.classList.add("today");
  if (dateStr === state.selected) cell.classList.add("selected");

  const num = document.createElement("div");
  num.className = "cal-date";
  num.textContent = dateObj.getDate();
  cell.appendChild(num);

  if (!otherMonth) {
    const evs = map[dateStr] || [];
    if (evs.length) {
      const dotRow = document.createElement("div");
      dotRow.className = "cal-dot-row";
      evs.slice(0, 4).forEach((ev) => {
        const dot = document.createElement("span");
        dot.className = "cal-dot";
        dot.style.background = catColor(ev);
        dotRow.appendChild(dot);
      });
      cell.appendChild(dotRow);
      if (evs.length > 4) {
        const more = document.createElement("div");
        more.className = "cal-more";
        more.textContent = `+${evs.length - 4}`;
        cell.appendChild(more);
      }
    }
    cell.addEventListener("click", () => selectDate(dateStr));
  }
  return cell;
}

function selectDate(dateStr) {
  state.selected = dateStr;
  renderCalendar();
  renderDayDetail();
}

function renderDayDetail() {
  $("day-detail-title").textContent = fmtDayTitle(state.selected);
  const list = $("event-list");
  list.innerHTML = "";
  const evs = eventsByDate()[state.selected] || [];
  if (!evs.length) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.textContent = "등록된 일정이 없습니다.";
    list.appendChild(li);
  } else {
    evs.forEach((ev) => list.appendChild(makeEventItem(ev)));
  }
  $("add-event-btn").classList.remove("hidden");
}

function makeEventItem(ev) {
  const li = document.createElement("li");
  const isAcademic = ev.category === "academic";
  const catClass = isAcademic ? (ev.holiday ? "cat-holiday" : "cat-academic") : `cat-${ev.category}`;
  li.className = `event-item ${catClass}`;

  const time = document.createElement("span");
  time.className = "event-time";
  time.textContent = ev.allDay || !ev.start ? "종일" : ev.start;

  const info = document.createElement("div");
  info.className = "event-info";
  const title = document.createElement("div");
  title.className = "event-title-txt";
  title.textContent = ev.title;
  info.appendChild(title);
  if (ev.desc) {
    const desc = document.createElement("div");
    desc.className = "event-desc-txt";
    desc.textContent = ev.desc;
    info.appendChild(desc);
  }

  const tag = document.createElement("span");
  const tagKind = isAcademic ? (ev.holiday ? "holiday" : "academic") : ev.category;
  const tagLabel = isAcademic ? (ev.holiday ? "휴일" : "학사") : CATEGORIES[ev.category].label;
  tag.className = `cat-tag ${tagKind}`;
  tag.textContent = tagLabel;

  li.append(time, info, tag);
  if (!ev.readOnly) {
    li.addEventListener("click", () => openEventModal(ev));
  }
  return li;
}

// ============================================================
//  일정 모달
// ============================================================
function openEventModal(ev) {
  state.editingEventId = ev ? ev.id : null;
  $("event-modal-title").textContent = ev ? "일정 수정" : "일정 추가";
  $("ev-category").value = ev && CATEGORIES[ev.category] ? ev.category : "work";
  $("ev-title").value = ev ? ev.title : "";
  $("ev-date").value = ev ? ev.date : state.selected || todayStr();
  $("ev-start").value = ev && ev.start ? ev.start : "";
  $("ev-end").value = ev && ev.end ? ev.end : "";
  $("ev-allday").checked = ev ? ev.allDay || !ev.start : false;
  $("ev-desc").value = ev ? ev.desc : "";
  $("ev-delete").classList.toggle("hidden", !ev);
  toggleTimeInputs();
  $("event-modal").classList.remove("hidden");
  $("ev-title").focus();
}

function closeEventModal() {
  $("event-modal").classList.add("hidden");
  state.editingEventId = null;
}

function toggleTimeInputs() {
  const allday = $("ev-allday").checked;
  $("ev-start").disabled = allday;
  $("ev-end").disabled = allday;
}

async function onSaveEvent() {
  const title = $("ev-title").value.trim();
  const date = $("ev-date").value;
  if (!title) return toast("제목을 입력하세요.");
  if (!date) return toast("날짜를 선택하세요.");
  const allDay = $("ev-allday").checked;
  const ev = {
    id: state.editingEventId,
    title,
    date,
    allDay,
    start: allDay ? null : ($("ev-start").value || null),
    end: allDay ? null : ($("ev-end").value || null),
    desc: $("ev-desc").value.trim(),
    category: $("ev-category").value,
  };
  try {
    await saveEvent(ev);
    closeEventModal();
    state.selected = date;
    state.view = new Date(date + "T00:00:00");
    toast(state.synced ? "구글 캘린더에 저장했습니다." : "일정을 저장했습니다.");
    await refreshEvents();
  } catch (e) {
    if (e.message !== "calendar-auth-expired") toast("저장에 실패했습니다.");
  }
}

async function onDeleteEvent() {
  if (!state.editingEventId) return;
  if (!confirm("이 일정을 삭제할까요?")) return;
  try {
    await deleteEvent({ id: state.editingEventId });
    closeEventModal();
    toast("일정을 삭제했습니다.");
    await refreshEvents();
  } catch (e) {
    if (e.message !== "calendar-auth-expired") toast("삭제에 실패했습니다.");
  }
}

// ============================================================
//  메모
// ============================================================
let memoUnsub = null;

// ---------- 메모 항목(카테고리) 관리 ----------
function loadSavedMemoCats() {
  try { return JSON.parse(localStorage.getItem(LOCAL_MEMOCATS_KEY)) || []; }
  catch { return []; }
}
function persistMemoCats() {
  // 기본 항목을 제외한 사용자 추가 항목만 저장
  const extra = state.memoCats.filter((c) => !DEFAULT_MEMO_CATS.includes(c));
  localStorage.setItem(LOCAL_MEMOCATS_KEY, JSON.stringify(extra));
}
function rebuildMemoCats() {
  const fromMemos = state.memos.map((m) => m.category).filter((c) => c && c !== UNCAT);
  state.memoCats = [...new Set([...DEFAULT_MEMO_CATS, ...loadSavedMemoCats(), ...fromMemos])];
}
function currentMemoCat() {
  return $("memo-category").value || state.memoCats[0] || DEFAULT_MEMO_CATS[0];
}
function renderMemoCatSelect() {
  const sel = $("memo-category");
  const prev = sel.value;
  sel.innerHTML = "";
  for (const c of state.memoCats) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    sel.appendChild(opt);
  }
  if (prev && state.memoCats.includes(prev)) sel.value = prev;
}
function addMemoCategory() {
  const name = (prompt("새 항목 이름을 입력하세요 (예: 학생상담, 아이디어)") || "").trim();
  if (!name) return;
  if (name === UNCAT) return toast(`"${UNCAT}"는 사용할 수 없는 이름입니다.`);
  if (state.memoCats.includes(name)) {
    $("memo-category").value = name;
    return toast("이미 있는 항목입니다.");
  }
  state.memoCats.push(name);
  persistMemoCats();
  renderMemoCatSelect();
  $("memo-category").value = name;
  $("memo-text").focus();
}

// ---------- 메모 추가/삭제/이동 ----------
async function addMemo() {
  const text = $("memo-text").value.trim();
  if (!text) return;
  const category = currentMemoCat();
  if (state.synced && fb) {
    const { addDoc, collection, serverTimestamp } = fb.fs;
    await addDoc(collection(fb.db, "users", state.user.uid, "memos"), {
      text, category, createdAt: serverTimestamp(),
    });
  } else {
    const memos = loadLocal(LOCAL_MEMOS_KEY);
    memos.push({ id: uid(), text, category, createdAt: Date.now() });
    saveLocal(LOCAL_MEMOS_KEY, memos);
    state.memos = loadLocalMemos();
    renderMemos();
  }
  $("memo-text").value = "";
}

async function removeMemo(id) {
  if (state.synced && fb) {
    const { deleteDoc, doc } = fb.fs;
    await deleteDoc(doc(fb.db, "users", state.user.uid, "memos", id));
  } else {
    saveLocal(LOCAL_MEMOS_KEY, loadLocal(LOCAL_MEMOS_KEY).filter((m) => m.id !== id));
    state.memos = loadLocalMemos();
    renderMemos();
  }
}

async function moveMemo(id, category) {
  if (state.synced && fb) {
    const { updateDoc, doc } = fb.fs;
    await updateDoc(doc(fb.db, "users", state.user.uid, "memos", id), { category });
  } else {
    const memos = loadLocal(LOCAL_MEMOS_KEY);
    const m = memos.find((x) => x.id === id);
    if (m) { m.category = category; saveLocal(LOCAL_MEMOS_KEY, memos); }
    state.memos = loadLocalMemos();
    renderMemos();
  }
}

function renderMemos() {
  rebuildMemoCats();
  renderMemoCatSelect();

  const list = $("memo-list");
  list.innerHTML = "";
  $("memo-count").textContent = state.memos.length ? `${state.memos.length}개` : "";

  if (!state.memos.length) {
    const p = document.createElement("div");
    p.className = "empty-note";
    p.textContent = "메모가 없습니다. 위에서 항목을 고르고 메모를 추가해 보세요.";
    list.appendChild(p);
    return;
  }

  // 표시 순서: 사용자 항목 순서대로, 미분류는 맨 뒤
  const order = [...state.memoCats];
  const hasUncat = state.memos.some((m) => !m.category || !state.memoCats.includes(m.category));
  if (hasUncat) order.push(UNCAT);

  for (const cat of order) {
    const items = state.memos.filter((m) =>
      cat === UNCAT
        ? (!m.category || !state.memoCats.includes(m.category))
        : m.category === cat
    );
    if (items.length) list.appendChild(makeMemoGroup(cat, items));
  }
}

function makeMemoGroup(cat, items) {
  const group = document.createElement("div");
  group.className = "memo-group";

  const head = document.createElement("div");
  head.className = "memo-group-head";
  const name = document.createElement("span");
  name.className = "memo-group-name";
  name.textContent = cat;
  const count = document.createElement("span");
  count.className = "memo-group-count";
  count.textContent = items.length;
  head.append(name, count);

  const ul = document.createElement("ul");
  ul.className = "memo-group-items";
  for (const m of items) ul.appendChild(makeMemoItem(m, cat));

  group.append(head, ul);
  return group;
}

function makeMemoItem(m, cat) {
  const li = document.createElement("li");
  li.className = "memo-item";

  const body = document.createElement("div");
  body.className = "memo-body";
  const content = document.createElement("div");
  content.className = "memo-content";
  content.textContent = m.text;

  const meta = document.createElement("div");
  meta.className = "memo-meta";

  // 다른 항목으로 이동하는 드롭다운
  const move = document.createElement("select");
  move.className = "memo-move";
  move.title = "다른 항목으로 이동";
  const opts = cat === UNCAT ? [UNCAT, ...state.memoCats] : [...state.memoCats];
  for (const c of opts) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    move.appendChild(o);
  }
  move.value = cat;
  move.addEventListener("change", () => {
    if (move.value !== cat && move.value !== UNCAT) moveMemo(m.id, move.value);
  });

  const date = document.createElement("span");
  date.className = "memo-date";
  date.textContent = m.createdAt ? new Date(m.createdAt).toLocaleString("ko-KR") : "";

  meta.append(move, date);
  body.append(content, meta);

  const del = document.createElement("button");
  del.className = "memo-del";
  del.textContent = "✕";
  del.title = "삭제";
  del.addEventListener("click", () => removeMemo(m.id));

  li.append(body, del);
  return li;
}

function subscribeMemos() {
  if (!(state.synced && fb)) {
    state.memos = loadLocalMemos();
    renderMemos();
    return;
  }
  const { collection, onSnapshot, query, orderBy } = fb.fs;
  const q = query(
    collection(fb.db, "users", state.user.uid, "memos"),
    orderBy("createdAt", "desc")
  );
  if (memoUnsub) memoUnsub();
  memoUnsub = onSnapshot(q, (snap) => {
    state.memos = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        text: data.text,
        category: data.category || "",
        createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : Date.now(),
      };
    });
    renderMemos();
  });
}

// ============================================================
//  인증 / Firebase 초기화
// ============================================================
async function initFirebase() {
  const appMod = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
  const authMod = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
  const fsMod = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

  const app = appMod.initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);
  const db = fsMod.getFirestore(app);
  fb = { app, auth, db, authMod, fs: fsMod };

  authMod.onAuthStateChanged(auth, (user) => {
    state.user = user || null;
    updateAccountUI();
    if (user) {
      state.synced = true;
      subscribeMemos();
      refreshEvents();
    } else {
      state.synced = false;
      state.calToken = null;
      if (memoUnsub) { memoUnsub(); memoUnsub = null; }
      subscribeMemos();   // 로컬 메모로 폴백
      refreshEvents();
    }
  });
}

async function login() {
  if (!fb) return;
  const { GoogleAuthProvider, signInWithPopup } = fb.authMod;
  const provider = new GoogleAuthProvider();
  provider.addScope(CAL_SCOPE);
  provider.setCustomParameters({ access_type: "online", prompt: "consent" });
  try {
    const result = await signInWithPopup(fb.auth, provider);
    const cred = GoogleAuthProvider.credentialFromResult(result);
    state.calToken = cred?.accessToken || null;
    state.synced = true;
    toast(`${result.user.displayName || "사용자"}님 로그인 완료`);
    updateAccountUI();
    subscribeMemos();
    await refreshEvents();
  } catch (e) {
    console.error(e);
    toast("로그인에 실패했습니다.");
  }
}

async function logout() {
  if (!fb) return;
  await fb.authMod.signOut(fb.auth);
  toast("로그아웃 되었습니다.");
}

function updateAccountUI() {
  const badge = $("mode-badge");
  if (state.user) {
    $("user-name").textContent = state.user.displayName || state.user.email || "";
    $("login-btn").classList.add("hidden");
    $("logout-btn").classList.remove("hidden");
    badge.textContent = "구글 동기화 중";
    badge.classList.add("synced");
  } else {
    $("user-name").textContent = "";
    $("login-btn").classList.toggle("hidden", !isConfigured);
    $("logout-btn").classList.add("hidden");
    badge.textContent = isConfigured ? "로그인 필요" : "로컬 저장 모드";
    badge.classList.remove("synced");
  }
}

// ============================================================
//  이벤트 바인딩 / 시작
// ============================================================
function bindEvents() {
  $("prev-month").addEventListener("click", () => {
    state.view = new Date(state.view.getFullYear(), state.view.getMonth() - 1, 1);
    refreshEvents();
  });
  $("next-month").addEventListener("click", () => {
    state.view = new Date(state.view.getFullYear(), state.view.getMonth() + 1, 1);
    refreshEvents();
  });
  $("today-btn").addEventListener("click", () => {
    state.view = new Date();
    selectDate(todayStr());
    refreshEvents();
  });

  $("add-event-btn").addEventListener("click", () => openEventModal(null));
  $("ev-cancel").addEventListener("click", closeEventModal);
  $("ev-save").addEventListener("click", onSaveEvent);
  $("ev-delete").addEventListener("click", onDeleteEvent);
  $("ev-allday").addEventListener("change", toggleTimeInputs);
  $("event-modal").addEventListener("click", (e) => {
    if (e.target.id === "event-modal") closeEventModal();
  });

  $("legend").querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const cat = chip.dataset.cat;
      state.filters[cat] = !state.filters[cat];
      chip.classList.toggle("active", state.filters[cat]);
      renderCalendar();
      if (state.selected) renderDayDetail();
    });
  });

  $("login-btn").addEventListener("click", login);
  $("logout-btn").addEventListener("click", logout);

  $("add-memo-btn").addEventListener("click", addMemo);
  $("add-memo-cat").addEventListener("click", addMemoCategory);
  $("memo-text").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") addMemo();
  });
}

async function start() {
  bindEvents();
  state.selected = todayStr();
  updateAccountUI();

  if (isConfigured) {
    try {
      await initFirebase();
    } catch (e) {
      console.error("Firebase 초기화 실패:", e);
      toast("Firebase 설정을 확인하세요. 로컬 모드로 전환합니다.");
      state.synced = false;
      subscribeMemos();
      await refreshEvents();
    }
  } else {
    // 로컬 모드
    subscribeMemos();
    await refreshEvents();
  }
  renderDayDetail();
}

start();
