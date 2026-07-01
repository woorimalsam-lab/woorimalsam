import { firebaseConfig, isConfigured } from "./config.js";
import { academicEvents, academicMeta } from "./academic-calendar.js";

// ============================================================
//  전역 상태
// ============================================================
// 일정 분류 정의 (표시 순서: 개인 → 업무 → 교과)
const CATEGORIES = {
  personal: { label: "개인", color: "#8b5cf6", googleColorId: "3" },   // 보라
  work:     { label: "업무", color: "#3b6ef5", googleColorId: "9" },   // 파랑
  subject:  { label: "교과", color: "#1c9963", googleColorId: "10" },  // 초록
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
  allEvents: [],           // 클라우드 일정 전체 (로그인 시)
  user: null,              // Firebase 사용자
  synced: false,           // 클라우드 동기화 활성 여부
  editingEventId: null,    // 모달에서 수정 중인 일정 id
  filters: { personal: true, work: true, subject: true, academic: true }, // 레이어 표시 여부
  memoCats: [],            // 메모 항목(카테고리) 목록
  memoSearch: "",          // 메모 검색어
  paletteFor: null,        // 색상 팔레트가 열린 메모 id
  todos: [],               // 할 일 목록
  activeView: "home",      // 현재 탭 (home/calendar/memo)
};

const LOCAL_TODOS_KEY = "myplanner.todos";

// 메모 항목 관련
const DEFAULT_MEMO_CATS = ["수업", "업무", "개인"];
const UNCAT = "미분류";
const LOCAL_MEMOCATS_KEY = "myplanner.memocats";

// 메모 색상 팔레트 (Google Keep 스타일)
const MEMO_COLORS = ["default", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "gray"];

// Firebase 핸들 (설정된 경우에만 채워짐)
let fb = null;
let migrationChecked = false;  // 로그인 세션당 로컬→클라우드 업로드 제안 1회

// ============================================================
//  유틸
// ============================================================
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());

function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
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

// ---------- 일정 (클라우드=Firestore / 비로그인=로컬) ----------
async function fetchEvents(monthDate) {
  const prefix = `${monthDate.getFullYear()}-${pad(monthDate.getMonth() + 1)}`;
  if (state.synced && fb) {
    return state.allEvents.filter((e) => (e.date || "").startsWith(prefix));
  }
  return loadLocal(LOCAL_EVENTS_KEY).filter((e) => e.date.startsWith(prefix));
}

async function saveEvent(ev) {
  if (state.synced && fb) {
    const { addDoc, updateDoc, doc, collection } = fb.fs;
    const data = {
      title: ev.title,
      date: ev.date,
      allDay: !!ev.allDay,
      start: ev.start || null,
      end: ev.end || null,
      desc: ev.desc || "",
      category: ev.category || "work",
    };
    if (ev.id) {
      await updateDoc(doc(fb.db, "users", state.user.uid, "events", ev.id), data);
    } else {
      await addDoc(collection(fb.db, "users", state.user.uid, "events"), data);
    }
    return;
  }
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
  if (state.synced && fb) {
    const { deleteDoc, doc } = fb.fs;
    await deleteDoc(doc(fb.db, "users", state.user.uid, "events", ev.id));
    return;
  }
  const all = loadLocal(LOCAL_EVENTS_KEY).filter((e) => e.id !== ev.id);
  saveLocal(LOCAL_EVENTS_KEY, all);
}

// 클라우드 일정 실시간 구독
let eventsUnsub = null;
function subscribeEvents() {
  if (!(state.synced && fb)) return;
  const { collection, onSnapshot } = fb.fs;
  if (eventsUnsub) eventsUnsub();
  eventsUnsub = onSnapshot(collection(fb.db, "users", state.user.uid, "events"), (snap) => {
    state.allEvents = snap.docs.map((d) => {
      const x = d.data();
      return {
        id: d.id,
        title: x.title,
        date: x.date,
        allDay: !!x.allDay,
        start: x.start || null,
        end: x.end || null,
        desc: x.desc || "",
        category: x.category || "work",
      };
    });
    refreshEvents();
  });
}

// ---------- 메모 (로컬 모드) ----------
function loadLocalMemos() {
  return loadLocal(LOCAL_MEMOS_KEY).sort((a, b) => b.createdAt - a.createdAt);
}

// ============================================================
//  캘린더 렌더링
// ============================================================
async function refreshEvents() {
  try {
    state.events = await fetchEvents(state.view);
  } catch (e) {
    state.events = [];
    console.error("일정 로드 오류", e);
  }
  renderCalendar();
  if (state.selected) renderDayDetail();
  if (state.activeView === "home") renderTodayEvents();
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
      const wrap = document.createElement("div");
      wrap.className = "cal-ev-wrap";
      const MAX = 3;
      evs.slice(0, MAX).forEach((ev) => {
        const bar = document.createElement("div");
        bar.className = "cal-ev";
        bar.style.background = catColor(ev);
        bar.textContent = (ev.allDay || !ev.start) ? ev.title : `${ev.start} ${ev.title}`;
        bar.title = ev.title;
        wrap.appendChild(bar);
      });
      cell.appendChild(wrap);
      if (evs.length > MAX) {
        const more = document.createElement("div");
        more.className = "cal-more";
        more.textContent = `+${evs.length - MAX}개 더`;
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
    toast("일정을 저장했습니다.");
    await refreshEvents();
  } catch (e) {
    console.error("일정 저장 오류", e);
    toast("저장에 실패했습니다.");
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
    console.error("일정 삭제 오류", e);
    toast("삭제에 실패했습니다.");
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
      text, category, color: "default", pinned: false, createdAt: serverTimestamp(),
    });
  } else {
    const memos = loadLocal(LOCAL_MEMOS_KEY);
    memos.push({ id: uid(), text, category, color: "default", pinned: false, createdAt: Date.now() });
    saveLocal(LOCAL_MEMOS_KEY, memos);
    state.memos = loadLocalMemos();
    renderMemos();
  }
  $("memo-text").value = "";
  $("memo-text").style.height = "auto";
}

// 메모 속성 변경(색상/고정) 공통 처리
async function updateMemo(id, patch) {
  if (state.synced && fb) {
    const { updateDoc, doc } = fb.fs;
    await updateDoc(doc(fb.db, "users", state.user.uid, "memos", id), patch);
  } else {
    const memos = loadLocal(LOCAL_MEMOS_KEY);
    const m = memos.find((x) => x.id === id);
    if (m) { Object.assign(m, patch); saveLocal(LOCAL_MEMOS_KEY, memos); }
    state.memos = loadLocalMemos();
    renderMemos();
  }
}
function setMemoColor(id, color) {
  state.paletteFor = null;
  updateMemo(id, { color });
}
function togglePin(id, pinned) {
  updateMemo(id, { pinned: !pinned });
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

function byPinnedThenDate(a, b) {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  return (b.createdAt || 0) - (a.createdAt || 0);
}
function emptyNote(text) {
  const p = document.createElement("div");
  p.className = "empty-note";
  p.textContent = text;
  return p;
}

function renderMemos() {
  rebuildMemoCats();
  renderMemoCatSelect();

  const list = $("memo-list");
  list.innerHTML = "";
  $("memo-count").textContent = state.memos.length ? `${state.memos.length}개` : "";

  if (!state.memos.length) {
    list.appendChild(emptyNote("메모가 없습니다. 위에 작성해 보세요."));
    return;
  }

  const term = state.memoSearch.trim().toLowerCase();

  // 검색 중: 그룹 없이 평면 결과
  if (term) {
    const found = state.memos
      .filter((m) => (m.text || "").toLowerCase().includes(term))
      .sort(byPinnedThenDate);
    if (!found.length) {
      list.appendChild(emptyNote(`"${state.memoSearch}" 검색 결과가 없습니다.`));
      return;
    }
    list.appendChild(makeMemoGroup("🔍 검색 결과", found));
    return;
  }

  // 고정된 메모 먼저 (항목 무관)
  const pinned = state.memos.filter((m) => m.pinned).sort(byPinnedThenDate);
  if (pinned.length) list.appendChild(makeMemoGroup("📌 고정됨", pinned));

  // 나머지: 항목(라벨)별 그룹
  const rest = state.memos.filter((m) => !m.pinned);
  const order = [...state.memoCats];
  const hasUncat = rest.some((m) => !m.category || !state.memoCats.includes(m.category));
  if (hasUncat) order.push(UNCAT);

  for (const cat of order) {
    const items = rest.filter((m) =>
      cat === UNCAT
        ? (!m.category || !state.memoCats.includes(m.category))
        : m.category === cat
    );
    if (items.length) list.appendChild(makeMemoGroup(cat, items));
  }
}

function makeMemoGroup(label, items) {
  const group = document.createElement("div");
  group.className = "memo-group";

  const head = document.createElement("div");
  head.className = "memo-group-head";
  const name = document.createElement("span");
  name.className = "memo-group-name";
  name.textContent = label;
  const count = document.createElement("span");
  count.className = "memo-group-count";
  count.textContent = items.length;
  head.append(name, count);

  const ul = document.createElement("ul");
  ul.className = "memo-group-items";
  for (const m of items) ul.appendChild(makeMemoItem(m));

  group.append(head, ul);
  return group;
}

function iconBtn(label, title) {
  const b = document.createElement("button");
  b.className = "memo-ibtn";
  b.textContent = label;
  b.title = title;
  return b;
}

function makeColorPalette(m) {
  const wrap = document.createElement("div");
  wrap.className = "memo-palette";
  const cur = MEMO_COLORS.includes(m.color) ? m.color : "default";
  for (const c of MEMO_COLORS) {
    const sw = document.createElement("button");
    sw.className = `memo-swatch sw-${c}` + (c === cur ? " sel" : "");
    sw.title = c === "default" ? "기본" : c;
    sw.addEventListener("click", () => setMemoColor(m.id, c));
    wrap.appendChild(sw);
  }
  return wrap;
}

function makeMemoItem(m) {
  const li = document.createElement("li");
  const color = MEMO_COLORS.includes(m.color) ? m.color : "default";
  li.className = `memo-item mc-${color}` + (m.pinned ? " pinned" : "");

  if (m.pinned) {
    const badge = document.createElement("span");
    badge.className = "memo-pin-badge";
    badge.textContent = "📌";
    li.appendChild(badge);
  }

  const content = document.createElement("div");
  content.className = "memo-content";
  content.textContent = m.text;
  li.appendChild(content);

  const foot = document.createElement("div");
  foot.className = "memo-foot";
  const date = document.createElement("span");
  date.className = "memo-date";
  date.textContent = m.createdAt
    ? new Date(m.createdAt).toLocaleDateString("ko-KR", { month: "short", day: "numeric" })
    : "";
  foot.appendChild(date);

  const actions = document.createElement("div");
  actions.className = "memo-actions";

  // 고정
  const pin = iconBtn(m.pinned ? "📌" : "📍", m.pinned ? "고정 해제" : "고정");
  if (m.pinned) pin.classList.add("on");
  pin.addEventListener("click", () => togglePin(m.id, m.pinned));

  // 색상
  const palette = iconBtn("🎨", "색상 바꾸기");
  palette.addEventListener("click", () => {
    state.paletteFor = state.paletteFor === m.id ? null : m.id;
    renderMemos();
  });

  // 항목 이동
  const cat = (m.category && state.memoCats.includes(m.category)) ? m.category : UNCAT;
  const move = document.createElement("select");
  move.className = "memo-move";
  move.title = "항목(라벨) 이동";
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

  // 삭제
  const del = iconBtn("🗑", "삭제");
  del.classList.add("memo-del");
  del.addEventListener("click", () => removeMemo(m.id));

  actions.append(pin, palette, move, del);
  foot.appendChild(actions);
  li.appendChild(foot);

  if (state.paletteFor === m.id) li.appendChild(makeColorPalette(m));

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
        color: data.color || "default",
        pinned: !!data.pinned,
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

  authMod.onAuthStateChanged(auth, async (user) => {
    state.user = user || null;
    updateAccountUI();
    if (user) {
      state.synced = true;
      subscribeMemos();
      subscribeEvents();
      subscribeTodos();
      refreshEvents();
      // 로그인/세션복원 어느 경우든, 이 기기의 로컬 데이터가 있으면 1회 업로드 제안
      if (!migrationChecked) {
        migrationChecked = true;
        await maybeMigrateLocal(user);
      }
    } else {
      state.synced = false;
      state.allEvents = [];
      migrationChecked = false;
      if (memoUnsub) { memoUnsub(); memoUnsub = null; }
      if (eventsUnsub) { eventsUnsub(); eventsUnsub = null; }
      if (todosUnsub) { todosUnsub(); todosUnsub = null; }
      subscribeMemos();   // 로컬 메모로 폴백
      subscribeTodos();
      refreshEvents();
    }
    if (state.activeView === "home") renderDashboard();
  });

  // 리디렉션 로그인으로 돌아온 경우 환영 메시지
  try {
    const redirectResult = await authMod.getRedirectResult(auth);
    if (redirectResult && redirectResult.user) afterSignIn(redirectResult);
  } catch (e) {
    console.error("리디렉션 결과 오류", e);
    toast(authErrorMessage(e), 7000);
  }
}

// 로그인 오류를 사람이 읽을 수 있게 변환
function authErrorMessage(e) {
  const code = e?.code || "";
  const map = {
    "auth/unauthorized-domain": "이 주소가 Firebase '승인된 도메인'에 없습니다.",
    "auth/operation-not-allowed": "구글 로그인이 Firebase에서 사용 설정되지 않았습니다.",
    "auth/popup-blocked": "브라우저가 로그인 팝업을 차단했습니다.",
    "auth/popup-closed-by-user": "로그인 창이 닫혔습니다. 다시 시도해 주세요.",
    "auth/cancelled-popup-request": "로그인 요청이 취소되었습니다.",
    "auth/network-request-failed": "네트워크 오류입니다. 연결을 확인해 주세요.",
    "auth/internal-error": "인증 처리 중 오류가 발생했습니다.",
    "auth/invalid-api-key": "Firebase API 키가 올바르지 않습니다.",
  };
  const friendly = map[code] || "로그인에 실패했습니다.";
  return code ? `${friendly}  [${code}]` : friendly;
}

// 로그인 성공 환영 메시지 (데이터 로딩/마이그레이션은 onAuthStateChanged에서 처리)
function afterSignIn(result) {
  toast(`${result.user.displayName || "사용자"}님 로그인 완료`);
}

async function login() {
  if (!fb) return;
  const { GoogleAuthProvider, signInWithPopup, signInWithRedirect } = fb.authMod;
  const provider = new GoogleAuthProvider();
  // 구글 캘린더 등 민감한 권한은 요청하지 않음(→ '확인되지 않은 앱' 경고 없음)
  try {
    const result = await signInWithPopup(fb.auth, provider);
    await afterSignIn(result);
  } catch (e) {
    console.error("로그인 오류", e);
    const code = e?.code || "";
    // 팝업이 막히거나 미지원 환경(모바일 등)이면 페이지 이동 방식으로 재시도
    if (["auth/popup-blocked", "auth/cancelled-popup-request",
         "auth/popup-closed-by-user", "auth/operation-not-supported-in-this-environment"].includes(code)) {
      try {
        toast("팝업이 막혀 페이지 이동 방식으로 로그인합니다…");
        await signInWithRedirect(fb.auth, provider);
        return;
      } catch (e2) {
        console.error("리디렉션 로그인 오류", e2);
        toast(authErrorMessage(e2), 7000);
        return;
      }
    }
    toast(authErrorMessage(e), 7000);
  }
}

// 로그인 시, 이 기기에만 있던 로컬 메모·일정·할 일을 클라우드로 올림
async function maybeMigrateLocal(user) {
  const localMemos = loadLocal(LOCAL_MEMOS_KEY);
  const localEvents = loadLocal(LOCAL_EVENTS_KEY);
  const localTodos = loadLocal(LOCAL_TODOS_KEY);
  if (!localMemos.length && !localEvents.length && !localTodos.length) return;

  const ok = confirm(
    `이 기기에만 저장된 메모 ${localMemos.length}개, 일정 ${localEvents.length}개, 할 일 ${localTodos.length}개가 있습니다.\n` +
    `내 계정(클라우드)으로 올려서 다른 기기에서도 보이게 할까요?`
  );
  if (!ok) return;

  const { addDoc, collection, Timestamp } = fb.fs;
  let memoOk = 0, evOk = 0, todoOk = 0;

  // 메모 → Firestore (작성 시각 유지)
  for (const m of localMemos) {
    try {
      await addDoc(collection(fb.db, "users", user.uid, "memos"), {
        text: m.text,
        category: m.category || "",
        color: m.color || "default",
        pinned: !!m.pinned,
        createdAt: Timestamp.fromMillis(m.createdAt || Date.now()),
      });
      memoOk++;
    } catch (e) { console.error("메모 업로드 실패", e); }
  }

  // 일정 → Firestore
  for (const ev of localEvents) {
    try { await saveEvent({ ...ev, id: null }); evOk++; }
    catch (e) { console.error("일정 업로드 실패", e); }
  }

  // 할 일 → Firestore
  for (const t of localTodos) {
    try {
      await addDoc(collection(fb.db, "users", user.uid, "todos"), {
        text: t.text,
        done: !!t.done,
        createdAt: Timestamp.fromMillis(t.createdAt || Date.now()),
      });
      todoOk++;
    } catch (e) { console.error("할 일 업로드 실패", e); }
  }

  // 성공적으로 올라간 만큼 로컬에서 정리(중복 방지)
  if (memoOk === localMemos.length) saveLocal(LOCAL_MEMOS_KEY, []);
  if (evOk === localEvents.length) saveLocal(LOCAL_EVENTS_KEY, []);
  if (todoOk === localTodos.length) saveLocal(LOCAL_TODOS_KEY, []);

  toast(`클라우드로 올렸습니다 (메모 ${memoOk}, 일정 ${evOk}, 할 일 ${todoOk})`);
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
//  대시보드 (홈) — D-Day / 오늘 일정 / 요약
// ============================================================
function dateDiffDays(fromStr, toStr) {
  const [y1, m1, d1] = fromStr.split("-").map(Number);
  const [y2, m2, d2] = toStr.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}
function fmtDdayDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = ["일", "월", "화", "수", "목", "금", "토"][new Date(y, m - 1, d).getDay()];
  return `${m}월 ${d}일 (${wd})`;
}

// 다가오는 학사일정 D-Day (제목별 최근접 1개)
function upcomingDdays(limit = 6) {
  const today = todayStr();
  const byTitle = new Map();
  for (const a of academicEvents) {
    if (a.date < today) continue;
    const prev = byTitle.get(a.title);
    if (!prev || a.date < prev.date) byTitle.set(a.title, a);
  }
  return [...byTitle.values()]
    .sort((x, y) => x.date.localeCompare(y.date))
    .slice(0, limit)
    .map((a) => ({ ...a, dday: dateDiffDays(today, a.date) }));
}

function renderDday() {
  const box = $("dday-list");
  box.innerHTML = "";
  const items = upcomingDdays(6);
  if (!items.length) { box.appendChild(emptyNote("다가오는 학사일정이 없습니다.")); return; }
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "dday-item";
    const badge = document.createElement("div");
    badge.className = "dday-badge" + (it.dday <= 7 ? " soon" : "");
    badge.textContent = it.dday === 0 ? "D-DAY" : `D-${it.dday}`;
    const info = document.createElement("div");
    info.className = "dday-info";
    const t = document.createElement("div"); t.className = "dday-title"; t.textContent = it.title;
    const d = document.createElement("div"); d.className = "dday-date"; d.textContent = fmtDdayDate(it.date);
    info.append(t, d);
    row.append(badge, info);
    box.appendChild(row);
  }
}

// 오늘 일정 (학사 + 내 일정)
function todaysEvents() {
  const today = todayStr();
  const list = [];
  for (const a of academicEvents) {
    if (a.date === today) list.push({ title: a.title, allDay: true, start: null, category: "academic", holiday: a.holiday });
  }
  const userEv = (state.synced && fb) ? state.allEvents : loadLocal(LOCAL_EVENTS_KEY);
  for (const e of userEv) {
    if (e.date === today) list.push({ ...e, category: e.category || "work" });
  }
  list.sort((a, b) => {
    const rank = (x) => (x.category === "academic" ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (a.start || "").localeCompare(b.start || "");
  });
  return list;
}

function renderTodayEvents() {
  const ul = $("today-events");
  ul.innerHTML = "";
  const evs = todaysEvents();
  if (!evs.length) { ul.appendChild(emptyNote("오늘 일정이 없습니다.")); return; }
  for (const ev of evs) {
    const li = document.createElement("li");
    const isAca = ev.category === "academic";
    const cls = isAca ? (ev.holiday ? "cat-holiday" : "cat-academic") : `cat-${ev.category}`;
    li.className = `today-ev ${cls}`;
    const time = document.createElement("span");
    time.className = "t-time";
    time.textContent = (ev.allDay || !ev.start) ? "종일" : ev.start;
    const title = document.createElement("span");
    title.className = "t-title";
    title.textContent = ev.title;
    li.append(time, title);
    ul.appendChild(li);
  }
}

function renderDashboard() {
  const now = new Date();
  const wd = ["일", "월", "화", "수", "목", "금", "토"][now.getDay()];
  const name = state.user?.displayName ? state.user.displayName.split(" ")[0] : "";
  $("greeting").textContent = name ? `안녕하세요, ${name}님 👋` : "안녕하세요 👋";
  $("greeting-date").textContent = `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 (${wd})`;
  renderDday();
  renderTodayEvents();
  renderTodos();
}

// ============================================================
//  할 일 (체크리스트)
// ============================================================
let todosUnsub = null;
function loadLocalTodos() {
  return loadLocal(LOCAL_TODOS_KEY).sort((a, b) => (a.done - b.done) || (b.createdAt - a.createdAt));
}

async function addTodo() {
  const input = $("todo-text");
  const text = input.value.trim();
  if (!text) return;
  if (state.synced && fb) {
    const { addDoc, collection, serverTimestamp } = fb.fs;
    await addDoc(collection(fb.db, "users", state.user.uid, "todos"), { text, done: false, createdAt: serverTimestamp() });
  } else {
    const todos = loadLocal(LOCAL_TODOS_KEY);
    todos.push({ id: uid(), text, done: false, createdAt: Date.now() });
    saveLocal(LOCAL_TODOS_KEY, todos);
    state.todos = loadLocalTodos();
    renderTodos();
  }
  input.value = "";
}

async function toggleTodo(id, done) {
  if (state.synced && fb) {
    const { updateDoc, doc } = fb.fs;
    await updateDoc(doc(fb.db, "users", state.user.uid, "todos", id), { done: !done });
  } else {
    const todos = loadLocal(LOCAL_TODOS_KEY);
    const t = todos.find((x) => x.id === id);
    if (t) { t.done = !done; saveLocal(LOCAL_TODOS_KEY, todos); }
    state.todos = loadLocalTodos();
    renderTodos();
  }
}

async function removeTodo(id) {
  if (state.synced && fb) {
    const { deleteDoc, doc } = fb.fs;
    await deleteDoc(doc(fb.db, "users", state.user.uid, "todos", id));
  } else {
    saveLocal(LOCAL_TODOS_KEY, loadLocal(LOCAL_TODOS_KEY).filter((t) => t.id !== id));
    state.todos = loadLocalTodos();
    renderTodos();
  }
}

function subscribeTodos() {
  if (!(state.synced && fb)) {
    state.todos = loadLocalTodos();
    renderTodos();
    return;
  }
  const { collection, onSnapshot } = fb.fs;
  if (todosUnsub) todosUnsub();
  todosUnsub = onSnapshot(collection(fb.db, "users", state.user.uid, "todos"), (snap) => {
    state.todos = snap.docs
      .map((d) => {
        const x = d.data();
        return { id: d.id, text: x.text, done: !!x.done, createdAt: x.createdAt?.toMillis ? x.createdAt.toMillis() : Date.now() };
      })
      .sort((a, b) => (a.done - b.done) || (b.createdAt - a.createdAt));
    renderTodos();
  });
}

function renderTodos() {
  const ul = $("todo-list");
  if (!ul) return;
  ul.innerHTML = "";
  const total = state.todos.length;
  const done = state.todos.filter((t) => t.done).length;
  $("todo-progress").textContent = total ? `${done}/${total} 완료` : "";
  if (!total) { ul.appendChild(emptyNote("할 일을 추가해 보세요.")); return; }
  for (const t of state.todos) {
    const li = document.createElement("li");
    li.className = "todo-item" + (t.done ? " done" : "");
    const check = document.createElement("button");
    check.className = "todo-check";
    check.textContent = t.done ? "✓" : "";
    check.title = t.done ? "완료 취소" : "완료";
    check.addEventListener("click", () => toggleTodo(t.id, t.done));
    const text = document.createElement("span");
    text.className = "todo-text";
    text.textContent = t.text;
    const del = document.createElement("button");
    del.className = "todo-del";
    del.textContent = "✕";
    del.title = "삭제";
    del.addEventListener("click", () => removeTodo(t.id));
    li.append(check, text, del);
    ul.appendChild(li);
  }
}

// ============================================================
//  탭(뷰) 전환
// ============================================================
function setView(name) {
  state.activeView = name;
  for (const v of ["home", "calendar", "memo"]) {
    $("view-" + v).classList.toggle("hidden", v !== name);
  }
  $("tabbar").querySelectorAll(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name === "home") renderDashboard();
  if (name === "calendar") { renderCalendar(); if (state.selected) renderDayDetail(); }
  window.scrollTo(0, 0);
}

// ============================================================
//  다크 모드
// ============================================================
const THEME_KEY = "myplanner.theme";

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = $("theme-btn");
  if (btn) {
    btn.textContent = theme === "dark" ? "☀️" : "🌙";
    btn.title = theme === "dark" ? "라이트 모드 전환" : "다크 모드 전환";
  }
}
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"));
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

// ============================================================
//  이벤트 바인딩 / 시작
// ============================================================
function bindEvents() {
  $("theme-btn").addEventListener("click", toggleTheme);
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

  // 탭 전환
  $("tabbar").querySelectorAll(".navbtn").forEach((b) => {
    b.addEventListener("click", () => setView(b.dataset.view));
  });
  document.querySelectorAll("[data-goto]").forEach((b) => {
    b.addEventListener("click", () => setView(b.dataset.goto));
  });

  // 할 일
  $("add-todo-btn").addEventListener("click", addTodo);
  $("todo-text").addEventListener("keydown", (e) => { if (e.key === "Enter") addTodo(); });

  $("add-memo-btn").addEventListener("click", addMemo);
  $("add-memo-cat").addEventListener("click", addMemoCategory);
  $("memo-text").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") addMemo();
  });
  // 작성 박스 자동 높이 조절
  $("memo-text").addEventListener("input", (e) => {
    e.target.style.height = "auto";
    e.target.style.height = e.target.scrollHeight + "px";
  });

  // 메모 검색
  $("memo-search").addEventListener("input", (e) => {
    state.memoSearch = e.target.value;
    $("memo-search-clear").classList.toggle("hidden", !e.target.value);
    renderMemos();
  });
  $("memo-search-clear").addEventListener("click", () => {
    $("memo-search").value = "";
    state.memoSearch = "";
    $("memo-search-clear").classList.add("hidden");
    renderMemos();
    $("memo-search").focus();
  });
}

async function start() {
  initTheme();
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
      subscribeTodos();
      await refreshEvents();
    }
  } else {
    // 로컬 모드
    subscribeMemos();
    subscribeTodos();
    await refreshEvents();
  }
  renderDayDetail();
  setView("home");   // 기본 화면: 대시보드
}

start();
