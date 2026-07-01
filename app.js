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
  activeView: "home",      // 현재 탭 (home/calendar/memo/...)
  timetable: { mon: [], tue: [], wed: [], thu: [], fri: [] },
  seating: { rows: 6, cols: 8, grid: [] },
  students: [],
  settings: { school: "", grade: "", teacher: "" },
  timerInterval: null,
  timerTime: 0,
  stopwatchInterval: null,
  stopwatchTime: 0,
};

const LOCAL_TODOS_KEY = "myplanner.todos";
const LOCAL_TIMETABLE_KEY = "myplanner.timetable";
const LOCAL_SEATING_KEY = "myplanner.seating";
const LOCAL_STUDENTS_KEY = "myplanner.students";
const LOCAL_SETTINGS_KEY = "myplanner.settings";

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
  const teacher = state.settings?.teacher?.trim();
  const name = teacher || (state.user?.displayName ? state.user.displayName.split(" ")[0] : "");
  $("greeting").textContent = name
    ? `안녕하세요, ${name} 선생님 👋`
    : "안녕하세요, 선생님 👋";
  $("greeting-date").textContent = `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 (${wd})`;
  renderDday();
  renderTodayEvents();
  renderTodayTimetable();
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
  const allViews = ["home", "timetable", "seating", "students", "calendar", "memo", "tools", "settings"];
  for (const v of allViews) {
    const el = $("view-" + v);
    if (el) el.classList.toggle("hidden", v !== name);
  }
  $("tabbar").querySelectorAll(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));

  // 각 뷰별 초기화
  if (name === "home") renderDashboard();
  if (name === "timetable") renderTimetable();
  if (name === "seating") renderSeating();
  if (name === "students") renderStudents();
  if (name === "calendar") { renderCalendar(); if (state.selected) renderDayDetail(); }
  if (name === "memo") renderMemos();

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

// ============================================================
//  시간표 (교사 본인 시간표 — 쌤핀 방식)
// ============================================================
const TT_DAY_KEYS = ["mon", "tue", "wed", "thu", "fri"];
const TT_DAY_LABELS = ["월", "화", "수", "목", "금"];
const PERIOD_MINUTES = 50;   // 한 교시 수업 시간

// 기본 시간표 (올려주신 시간표 이미지 기준 — 편집에서 자유롭게 수정)
const DEFAULT_TIMETABLE = {
  times: ["09:10", "10:10", "11:10", "12:10", "14:00", "15:00", "16:00"],
  cells: {
    mon: ["208 화언", "",         "206 화언", "207 화언", "",         "",         ""],
    tue: ["",         "206 화언", "",         "",         "207 화언", "209 화언", ""],
    wed: ["206 화언", "209 화언", "",         "208 화언", "",         "",         ""],
    thu: ["",         "208 화언", "207 화언", "",         "",         "209 화언", ""],
    fri: ["208 화언", "206 화언", "",         "207 화언", "",         "",         "209 화언"],
  },
};

function loadTimetable() {
  const t = loadLocal(LOCAL_TIMETABLE_KEY);
  // loadLocal은 빈 값일 때 []를 반환 → 객체 형태 검증 필수
  if (t && !Array.isArray(t) && Array.isArray(t.times) && t.cells) {
    state.timetable = t;
  } else {
    state.timetable = JSON.parse(JSON.stringify(DEFAULT_TIMETABLE));
  }
}
function saveTimetable() {
  saveLocal(LOCAL_TIMETABLE_KEY, state.timetable);
}

// "09:10" → 분 단위 숫자
function timeToMin(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((t || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
// 지금 진행 중인 교시 index (없으면 -1)
function currentPeriodIndex() {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return state.timetable.times.findIndex((t) => {
    const start = timeToMin(t);
    return start !== null && nowMin >= start && nowMin < start + PERIOD_MINUTES;
  });
}
function todayDayKey() {
  const idx = new Date().getDay() - 1;   // 월=0 … 금=4
  return idx >= 0 && idx < 5 ? TT_DAY_KEYS[idx] : null;
}

function renderTimetable() {
  const display = $("timetable-display");
  if (!display) return;
  const tt = state.timetable;
  const todayKey = todayDayKey();
  const nowP = currentPeriodIndex();

  let html = '<table class="timetable-grid"><thead><tr><th>교시</th>';
  TT_DAY_KEYS.forEach((k, i) => {
    html += `<th class="${k === todayKey ? "tt-today" : ""}">${TT_DAY_LABELS[i]}</th>`;
  });
  html += "</tr></thead><tbody>";

  tt.times.forEach((time, p) => {
    html += `<tr><td>${p + 1}<span class="tt-time">${time}</span></td>`;
    TT_DAY_KEYS.forEach((k) => {
      const subj = tt.cells[k]?.[p] || "";
      const isNow = k === todayKey && p === nowP && subj;
      html += `<td class="${isNow ? "tt-now" : ""}">${subj}${isNow ? '<span class="tt-now-badge">지금</span>' : ""}</td>`;
    });
    html += "</tr>";
  });
  html += "</tbody></table>";
  display.innerHTML = html;

  renderTodayTimetable();
}

// 대시보드 카드: 오늘 수업만 추려서 표시 + 현재 교시 강조
function renderTodayTimetable() {
  const box = $("today-timetable");
  if (!box) return;
  const todayKey = todayDayKey();
  if (!todayKey) {
    box.innerHTML = '<div class="today-timetable-empty">주말입니다 🎉</div>';
    return;
  }
  const nowP = currentPeriodIndex();
  const items = [];
  state.timetable.times.forEach((time, p) => {
    const subj = state.timetable.cells[todayKey]?.[p];
    if (!subj) return;
    const isNow = p === nowP;
    items.push(
      `<div class="today-timetable-item${isNow ? " now" : ""}">` +
      `<b>${p + 1}교시</b> <span class="tt-time">${time}</span> ${subj}` +
      `${isNow ? '<span class="tt-now-badge">지금</span>' : ""}</div>`
    );
  });
  box.innerHTML = items.length
    ? items.join("")
    : '<div class="today-timetable-empty">오늘은 수업이 없습니다</div>';
}

function renderTimetableEditor() {
  const grid = $("timetable-grid");
  if (!grid) return;
  const tt = state.timetable;
  const periods = Math.min(Math.max(parseInt($("tt-periods").value) || tt.times.length, 1), 10);

  let html = '<thead><tr><th>교시 (시작 시각)</th>';
  TT_DAY_LABELS.forEach((d) => (html += `<th>${d}</th>`));
  html += "</tr></thead><tbody>";
  for (let p = 0; p < periods; p++) {
    const time = tt.times[p] || "";
    html += `<tr><td>${p + 1} <input type="text" class="tt-time-input" data-period="${p}" value="${time}" placeholder="09:10" /></td>`;
    TT_DAY_KEYS.forEach((d) => {
      const val = tt.cells[d]?.[p] || "";
      html += `<td><input type="text" data-day="${d}" data-period="${p}" value="${val}" placeholder="반·과목" /></td>`;
    });
    html += "</tr>";
  }
  html += "</tbody>";
  grid.innerHTML = html;
}

// 편집 그리드의 입력값을 state.timetable로 수집
function collectTimetableInputs() {
  const grid = $("timetable-grid");
  if (!grid) return;
  const timeInputs = grid.querySelectorAll(".tt-time-input");
  if (!timeInputs.length) return;   // 편집 그리드가 아직 없음

  const periods = timeInputs.length;
  const times = [];
  const cells = { mon: [], tue: [], wed: [], thu: [], fri: [] };
  timeInputs.forEach((inp) => { times[Number(inp.dataset.period)] = inp.value.trim(); });
  grid.querySelectorAll("input[data-day]").forEach((inp) => {
    cells[inp.dataset.day][Number(inp.dataset.period)] = inp.value.trim();
  });
  // 빈 시각은 기본 패턴으로 채움
  for (let p = 0; p < periods; p++) {
    if (!times[p]) times[p] = DEFAULT_TIMETABLE.times[p] || "";
    TT_DAY_KEYS.forEach((d) => { if (cells[d][p] === undefined) cells[d][p] = ""; });
  }
  state.timetable = { times, cells };
}

// ============================================================
//  자리배치
// ============================================================
let seatPicked = null;   // 자리 바꾸기용 첫 번째 선택 좌석 {r, c}

function loadSeating() {
  const s = loadLocal(LOCAL_SEATING_KEY);
  // loadLocal은 빈 값일 때 []를 반환 → 객체 형태 검증 필수
  if (s && !Array.isArray(s) && s.rows && s.cols && Array.isArray(s.grid)) {
    state.seating = s;
  } else {
    state.seating = { rows: 5, cols: 6, grid: [] };
    initSeatingGrid();
  }
}
function initSeatingGrid() {
  state.seating.grid = Array(state.seating.rows).fill(null).map(() => Array(state.seating.cols).fill(""));
}
function saveSeating() {
  saveLocal(LOCAL_SEATING_KEY, state.seating);
}
function renderSeating() {
  const display = $("seating-display");
  if (!display) return;
  const { rows, cols, grid } = state.seating;
  let html = '<div class="seating-board">칠판</div>';
  html += `<div class="seating-grid" style="grid-template-columns: repeat(${cols}, 1fr)">`;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const name = grid[r]?.[c] || "";
      const sel = seatPicked && seatPicked.r === r && seatPicked.c === c;
      html += `<div class="seating-seat${name ? "" : " empty"}${sel ? " selected" : ""}" data-row="${r}" data-col="${c}">${name || "－"}</div>`;
    }
  }
  html += "</div>";
  html += '<p class="seating-hint muted">좌석을 하나 누른 뒤 다른 좌석을 누르면 서로 자리가 바뀝니다.</p>';
  display.innerHTML = html;
}
// 좌석 두 개를 차례로 눌러 맞바꾸기
function onSeatClick(r, c) {
  if (!seatPicked) {
    seatPicked = { r, c };
  } else if (seatPicked.r === r && seatPicked.c === c) {
    seatPicked = null;   // 같은 좌석 다시 누르면 선택 해제
  } else {
    const g = state.seating.grid;
    [g[seatPicked.r][seatPicked.c], g[r][c]] = [g[r][c], g[seatPicked.r][seatPicked.c]];
    seatPicked = null;
    saveSeating();
  }
  renderSeating();
}
function randomSeating() {
  const students = state.students.map((s) => s.name);
  if (!students.length) { toast("먼저 '학생' 메뉴에서 학생을 등록해 주세요"); return; }
  const seats = state.seating.rows * state.seating.cols;
  if (students.length > seats) {
    toast(`좌석(${seats}석)보다 학생(${students.length}명)이 많습니다. 행/열을 늘려 주세요.`, 5000);
    return;
  }
  for (let i = students.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [students[i], students[j]] = [students[j], students[i]];
  }
  initSeatingGrid();
  let idx = 0;
  for (let r = 0; r < state.seating.rows && idx < students.length; r++) {
    for (let c = 0; c < state.seating.cols && idx < students.length; c++) {
      state.seating.grid[r][c] = students[idx++];
    }
  }
  seatPicked = null;
  saveSeating();
  renderSeating();
  toast(`🔀 ${students.length}명 자리배치 완료`);
}

// ============================================================
//  학생 기록
// ============================================================
function loadStudents() {
  const s = loadLocal(LOCAL_STUDENTS_KEY);
  state.students = Array.isArray(s) ? s : [];
}
function saveStudents() {
  saveLocal(LOCAL_STUDENTS_KEY, state.students);
}
function addStudent() {
  const name = $("student-name")?.value?.trim();
  if (!name) return;
  state.students.push({ id: uid(), name, class: "", number: "", notes: "", date: new Date().toISOString() });
  saveStudents();
  renderStudents();
  $("student-name").value = "";
}
function removeStudent(id) {
  state.students = state.students.filter((s) => s.id !== id);
  saveStudents();
  renderStudents();
}
function updateStudentNotes(id, notes) {
  const s = state.students.find((x) => x.id === id);
  if (s) { s.notes = notes; saveStudents(); }
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function renderStudents() {
  const list = $("students-list");
  if (!list) return;
  if (!state.students.length) {
    list.innerHTML = '<p style="text-align:center; color: var(--muted); padding: 20px;">학생을 추가하거나 NEIS 명렬표를 업로드해 주세요.</p>';
    return;
  }
  // 반 → 번호 → 이름 순 정렬
  const sorted = [...state.students].sort((a, b) =>
    (Number(a.class) || 0) - (Number(b.class) || 0) ||
    (Number(a.number) || 0) - (Number(b.number) || 0) ||
    a.name.localeCompare(b.name, "ko"));

  let html = `<p class="muted" style="margin: 0 0 10px;">총 ${sorted.length}명</p>`;
  let lastClass = null;
  for (const s of sorted) {
    if (s.class && s.class !== lastClass) {
      html += `<h3 class="student-class-head">${escapeHtml(s.class)}반</h3>`;
      lastClass = s.class;
    }
    html += `
    <div class="student-card" data-id="${s.id}">
      <div class="student-header">
        <span>${s.number ? `<b class="student-num">${escapeHtml(s.number)}번</b> ` : ""}${escapeHtml(s.name)}</span>
        <button class="btn btn-danger btn-sm student-del" data-id="${s.id}">삭제</button>
      </div>
      <textarea class="student-note" data-id="${s.id}" placeholder="메모..." style="width: 100%; padding: 8px; border: 1px solid var(--line); border-radius: 6px; font-family: inherit;">${escapeHtml(s.notes)}</textarea>
    </div>`;
  }
  list.innerHTML = html;
}

// ---------- NEIS 명렬표 파싱 (CSV/Excel) ----------
// 나이스 원본 xlsx 구조: 위쪽 여러 행이 제목/날짜/담당교사이고,
// 헤더 행("학년/학과/반/번호/성 명")이 중간(예: 9행)에 있음. 숫자는 8.0처럼 실수형.

// "8.0" → "8" 정규화
function cellStr(v) {
  const s = String(v ?? "").trim();
  const m = /^(\d+)(\.0+)?$/.exec(s);
  return m ? m[1] : s;
}

function parseNEISData(data) {
  if (!Array.isArray(data) || !data.length) return { success: false, msg: "파일이 비어있습니다" };

  // 1) 헤더 행 탐색: 위에서 30행 안에서 '성명'/'이름' 칸이 있는 행 ("성 명"처럼 띄어쓰기 허용)
  let headerRow = -1;
  let classIdx = -1, numberIdx = -1, nameIdx = -1;
  const scanMax = Math.min(data.length, 30);
  for (let r = 0; r < scanMax; r++) {
    const row = data[r] || [];
    let cI = -1, nI = -1, nmI = -1;
    for (let i = 0; i < row.length; i++) {
      const h = cellStr(row[i]).replace(/\s+/g, "").toLowerCase();
      if (!h) continue;
      if (h === "반" || h === "class") cI = i;
      if (h === "번호" || h === "번" || h === "no" || h === "number") nI = i;
      if (h === "성명" || h === "이름" || h === "name") nmI = i;
    }
    if (nmI !== -1) {
      headerRow = r; classIdx = cI; numberIdx = nI; nameIdx = nmI;
      break;
    }
  }

  // 2) 제목 행에서 "2-8" 같은 반 정보 추출 (반 칸이 없는 파일 대비)
  let fallbackClass = "";
  for (let r = 0; r < Math.max(headerRow, 0); r++) {
    const joined = (data[r] || []).map((v) => String(v ?? "")).join(" ");
    const m = /(\d{1,2})\s*학년\s*(\d{1,2})\s*반/.exec(joined) || /(\d{1,2})\s*-\s*(\d{1,2})/.exec(joined);
    if (m) { fallbackClass = m[2]; break; }
  }

  let added = 0, skippedDup = 0;

  for (let i = headerRow + 1; i < data.length; i++) {
    const row = (data[i] || []).map(cellStr);
    if (!row.some(Boolean)) continue;   // 빈 행

    let name, klass, number;
    if (nameIdx !== -1) {
      name = row[nameIdx] || "";
      klass = (classIdx !== -1 ? row[classIdx] : "") || fallbackClass;
      number = numberIdx !== -1 ? row[numberIdx] : "";
    } else {
      // 헤더 없는 단순 형식: 반, 번호, 이름 순 (2칸이면 번호, 이름)
      const vals = row.filter(Boolean);
      if (vals.length >= 3) [klass, number, name] = vals;
      else if (vals.length === 2) { [number, name] = vals; klass = fallbackClass; }
      else { name = vals[0] || ""; klass = fallbackClass; number = ""; }
    }

    if (!name || /^\d+$/.test(name)) continue;   // 이름이 비었거나 숫자면 데이터 행 아님
    klass = (klass || "").replace(/반$/, "");
    number = (number || "").replace(/번$/, "");

    if (state.students.find((s) => s.name === name && s.class === klass && s.number === number)) {
      skippedDup++;
      continue;
    }
    state.students.push({
      id: uid(), name, class: klass, number,
      notes: "", date: new Date().toISOString(),
    });
    added++;
  }

  if (!added && !skippedDup) return { success: false, msg: "학생 데이터를 찾지 못했습니다. 파일 형식을 확인해 주세요." };
  saveStudents();
  const dupMsg = skippedDup ? ` (중복 ${skippedDup}명 제외)` : "";
  return added
    ? { success: true, added, msg: `${added}명의 학생이 추가되었습니다${dupMsg}` }
    : { success: true, added, msg: `추가된 학생이 없습니다${dupMsg} — 이미 모두 등록되어 있어요` };
}

function parseNEISFile(content) {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { success: false, msg: "파일이 비어있습니다" };
  return parseNEISData(lines.map((line) => line.split(",")));
}

// XLSX 라이브러리 보장 (CDN 차단/로드 실패 대비 2차 소스 폴백)
function ensureXLSX() {
  if (typeof XLSX !== "undefined") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("엑셀 처리 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요."));
    document.head.appendChild(s);
  });
}

// ============================================================
//  설정
// ============================================================
function loadSettings() {
  const s = loadLocal(LOCAL_SETTINGS_KEY);
  // loadLocal은 빈 값일 때 []를 반환 → 객체 형태 검증 필수
  state.settings = (s && !Array.isArray(s)) ? s : { school: "", grade: "", teacher: "" };
  $("setting-school").value = state.settings.school || "";
  $("setting-grade").value = state.settings.grade || "";
  $("setting-teacher").value = state.settings.teacher || "";
}
function saveSettings() {
  state.settings = {
    school: $("setting-school").value,
    grade: $("setting-grade").value,
    teacher: $("setting-teacher").value
  };
  saveLocal(LOCAL_SETTINGS_KEY, state.settings);
  renderDashboard();   // 인사말에 즉시 반영
  toast("설정이 저장되었습니다.");
}
function exportData() {
  const data = {
    memos: loadLocal(LOCAL_MEMOS_KEY),
    events: loadLocal(LOCAL_EVENTS_KEY),
    todos: loadLocal(LOCAL_TODOS_KEY),
    timetable: loadLocal(LOCAL_TIMETABLE_KEY),
    seating: loadLocal(LOCAL_SEATING_KEY),
    students: loadLocal(LOCAL_STUDENTS_KEY),
    settings: loadLocal(LOCAL_SETTINGS_KEY),
    memoCats: loadLocal(LOCAL_MEMOCATS_KEY)
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `내교실_${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  toast("데이터 다운로드 완료");
}
function importData() {
  $("import-file").click();
}

// ============================================================
//  도구 — 타이머
// ============================================================
function startTimer() {
  if (state.timerInterval) return;
  const seconds = parseInt($("timer-input").value) || 300;
  // 종료 시각 기준으로 계산 (탭이 백그라운드여도 정확)
  const endAt = Date.now() + seconds * 1000;
  const tick = () => {
    const remain = Math.max(0, Math.round((endAt - Date.now()) / 1000));
    state.timerTime = remain;
    const m = Math.floor(remain / 60), s = remain % 60;
    $("timer-display").textContent = `${pad(m)}:${pad(s)}`;
    if (remain <= 0) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
      toast("⏱️ 시간 완료!", 8000);
      $("timer-start-btn").classList.remove("hidden");
      $("timer-stop-btn").classList.add("hidden");
    }
  };
  tick();
  state.timerInterval = setInterval(tick, 500);
  $("timer-start-btn").classList.add("hidden");
  $("timer-stop-btn").classList.remove("hidden");
}
function stopTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  $("timer-start-btn").classList.remove("hidden");
  $("timer-stop-btn").classList.add("hidden");
}
function resetTimer() {
  stopTimer();
  $("timer-display").textContent = "00:00";
  $("timer-input").value = 300;
}

// ============================================================
//  도구 — 스톱워치
// ============================================================
function startStopwatch() {
  if (state.stopwatchInterval) return;
  // 실제 시각 기준으로 계산 (탭이 백그라운드여도 정확)
  const startedAt = Date.now() - state.stopwatchTime * 100;
  state.stopwatchInterval = setInterval(() => {
    state.stopwatchTime = Math.floor((Date.now() - startedAt) / 100);
    const total = state.stopwatchTime;
    const m = Math.floor(total / 600), s = Math.floor((total % 600) / 10), d = total % 10;
    $("stopwatch-display").textContent = `${pad(m)}:${pad(s)}.${d}`;
  }, 100);
  $("stopwatch-start-btn").classList.add("hidden");
  $("stopwatch-stop-btn").classList.remove("hidden");
}
function stopStopwatch() {
  if (state.stopwatchInterval) {
    clearInterval(state.stopwatchInterval);
    state.stopwatchInterval = null;
  }
  $("stopwatch-start-btn").classList.remove("hidden");
  $("stopwatch-stop-btn").classList.add("hidden");
}
function resetStopwatch() {
  stopStopwatch();
  state.stopwatchTime = 0;
  $("stopwatch-display").textContent = "00:00.0";
}

// ============================================================
//  도구 — 주사위, 투표, 번호뽑기, 가위바위보
// ============================================================
function rollDice() {
  const count = parseInt($("dice-count").value) || 1;
  let result = 0;
  for (let i = 0; i < count; i++) result += Math.floor(Math.random() * 6) + 1;
  $("dice-display").textContent = result;
  toast(`🎲 ${count}개 주사위: 합 ${result}`);
}
let voteState = null;   // { options: [...], counts: [...] }

function createVote() {
  const input = $("vote-option").value.split(",").map((s) => s.trim()).filter(Boolean);
  if (input.length < 2) { toast("선택지를 쉼표로 구분해 2개 이상 입력하세요"); return; }
  voteState = { options: input, counts: input.map(() => 0) };
  renderVote();
  $("vote-option").value = "";
}
function renderVote() {
  const display = $("vote-display");
  if (!display || !voteState) return;
  const total = voteState.counts.reduce((a, b) => a + b, 0);
  display.innerHTML =
    voteState.options.map((opt, i) => {
      const n = voteState.counts[i];
      const pct = total ? Math.round((n / total) * 100) : 0;
      return `
      <button class="vote-option" data-vote="${i}" title="누르면 1표 추가">
        <span class="vote-option-text">${escapeHtml(opt)}</span>
        <span class="vote-option-track"><span class="vote-option-bar" style="width:${pct}%"></span></span>
        <span class="vote-option-count">${n}표</span>
      </button>`;
    }).join("") +
    `<div class="vote-total muted">총 ${total}표 · 선택지를 누르면 표가 올라갑니다 <button class="linkbtn" data-vote-reset>초기화</button></div>`;
}
function castVote(i) {
  if (!voteState) return;
  voteState.counts[i]++;
  renderVote();
}
function pickNumber() {
  const min = parseInt($("numberpick-min").value) || 1;
  const max = parseInt($("numberpick-max").value) || 30;
  const picked = Math.floor(Math.random() * (max - min + 1)) + min;
  $("numberpick-result").innerHTML = `<div style="font-size: 3rem; font-weight: 700; color: var(--primary); text-align: center; padding: 30px;">${picked}</div>`;
  toast(`🎯 ${picked}번이 선택되었습니다`);
}
function playRPS(choice) {
  const choices = ["rock", "paper", "scissors"];
  const comp = choices[Math.floor(Math.random() * 3)];
  const icons = { rock: "✊", paper: "✋", scissors: "✌️" };
  const result = (choice === comp) ? "무승부" :
    (choice === "rock" && comp === "scissors") ||
    (choice === "paper" && comp === "rock") ||
    (choice === "scissors" && comp === "paper") ? "승리" : "패배";
  $("rps-display").innerHTML = `
    <div style="font-size: 2rem;">${icons[choice]} vs ${icons[comp]}</div>
    <div style="font-size: 1.5rem; margin-top: 10px; color: var(--primary);">${result}</div>
  `;
}

// 새로운 이벤트 바인딩 추가
function bindEventsNew() {
  // 시간표
  $("edit-timetable-btn")?.addEventListener("click", () => {
    $("tt-periods").value = state.timetable.times.length;
    $("timetable-editor").classList.toggle("hidden");
    renderTimetableEditor();
  });
  $("tt-periods")?.addEventListener("change", () => {
    // 교시 수를 바꾸기 전에 입력 중이던 값을 보존
    collectTimetableInputs();
    renderTimetableEditor();
  });
  $("save-timetable-btn")?.addEventListener("click", () => {
    collectTimetableInputs();
    saveTimetable();
    $("timetable-editor").classList.add("hidden");
    renderTimetable();
    toast("시간표가 저장되었습니다");
  });
  $("cancel-timetable-btn")?.addEventListener("click", () => {
    loadTimetable();   // 편집 중 변경 되돌리기
    $("timetable-editor").classList.add("hidden");
  });

  // 자리배치
  $("random-seating-btn")?.addEventListener("click", randomSeating);
  $("edit-seating-btn")?.addEventListener("click", () => {
    $("seating-rows").value = state.seating.rows;
    $("seating-cols").value = state.seating.cols;
    document.querySelector(".seating-config")?.classList.toggle("hidden");
  });
  $("create-seating-btn")?.addEventListener("click", () => {
    state.seating.rows = Math.min(Math.max(parseInt($("seating-rows").value) || 5, 1), 10);
    state.seating.cols = Math.min(Math.max(parseInt($("seating-cols").value) || 6, 1), 10);
    initSeatingGrid();
    seatPicked = null;
    saveSeating();
    renderSeating();
    document.querySelector(".seating-config")?.classList.add("hidden");
  });
  // 좌석 클릭 → 자리 바꾸기 (이벤트 위임)
  $("seating-display")?.addEventListener("click", (e) => {
    const seat = e.target.closest(".seating-seat");
    if (seat) onSeatClick(Number(seat.dataset.row), Number(seat.dataset.col));
  });

  // 학생 - 탭 전환
  document.querySelectorAll(".student-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".student-tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".student-tab-content").forEach(c => c.classList.add("hidden"));
      btn.classList.add("active");
      $("student-tab-" + btn.dataset.tab)?.classList.remove("hidden");
    });
  });

  // 학생 - 수동 추가
  $("add-student-btn")?.addEventListener("click", addStudent);
  $("student-name")?.addEventListener("keydown", (e) => { if (e.key === "Enter") addStudent(); });

  // 학생 - 삭제/메모 (이벤트 위임 — 카드가 동적으로 생성되므로)
  $("students-list")?.addEventListener("click", (e) => {
    const del = e.target.closest(".student-del");
    if (!del) return;
    const st = state.students.find((s) => s.id === del.dataset.id);
    if (st && confirm(`'${st.name}' 학생을 삭제할까요? 메모도 함께 지워집니다.`)) {
      removeStudent(del.dataset.id);
    }
  });
  $("students-list")?.addEventListener("change", (e) => {
    if (e.target.classList.contains("student-note")) {
      updateStudentNotes(e.target.dataset.id, e.target.value);
    }
  });

  // 학생 - NEIS 파일 업로드 (CSV / Excel)
  $("neis-import-btn")?.addEventListener("click", async () => {
    const file = $("neis-file")?.files?.[0];
    if (!file) { toast("파일을 선택해 주세요"); return; }

    const resultDiv = $("import-result");
    const showResult = (result) => {
      if (resultDiv) {
        resultDiv.classList.remove("hidden", "success", "error");
        resultDiv.classList.add(result.success ? "success" : "error");
        resultDiv.textContent = `${result.success ? "✅" : "❌"} ${result.msg}`;
      }
      if (result.success && result.added) {
        renderStudents();
        toast(result.msg);
        setTimeout(() => { $("neis-file").value = ""; resultDiv?.classList.add("hidden"); }, 3000);
      }
    };

    const lower = file.name.toLowerCase();
    const isExcel = lower.endsWith(".xlsx") || lower.endsWith(".xls");

    if (isExcel) {
      try {
        await ensureXLSX();   // CDN 실패 시 2차 소스에서 로드
      } catch (err) {
        showResult({ success: false, msg: err.message });
        return;
      }
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      let result;
      try {
        if (isExcel) {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: "array" });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
          result = parseNEISData(rows);
        } else {
          result = parseNEISFile(e.target.result);
        }
      } catch (err) {
        result = { success: false, msg: `파일 읽기 오류: ${err.message}` };
      }
      showResult(result);
    };
    reader.onerror = () => showResult({ success: false, msg: "파일을 읽을 수 없습니다" });

    if (isExcel) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  });

  // 설정
  $("save-settings-btn")?.addEventListener("click", saveSettings);
  $("export-data-btn")?.addEventListener("click", exportData);
  $("import-data-btn")?.addEventListener("click", importData);
  $("import-file")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = JSON.parse(evt.target.result);
        if (data.memos) saveLocal(LOCAL_MEMOS_KEY, data.memos);
        if (data.events) saveLocal(LOCAL_EVENTS_KEY, data.events);
        if (data.todos) saveLocal(LOCAL_TODOS_KEY, data.todos);
        if (data.timetable) saveLocal(LOCAL_TIMETABLE_KEY, data.timetable);
        if (data.seating) saveLocal(LOCAL_SEATING_KEY, data.seating);
        if (data.students) saveLocal(LOCAL_STUDENTS_KEY, data.students);
        if (data.settings) saveLocal(LOCAL_SETTINGS_KEY, data.settings);
        toast("데이터 가져오기 완료! 페이지를 새로고침하세요.");
      } catch (e) {
        toast("파일 형식이 올바르지 않습니다");
      }
    };
    reader.readAsText(file);
  });
  $("clear-local-btn")?.addEventListener("click", () => {
    if (confirm("로컬 데이터를 모두 삭제하시겠습니까?")) {
      localStorage.clear();
      location.reload();
    }
  });

  // 도구 - 타이머
  $("timer-start-btn")?.addEventListener("click", startTimer);
  $("timer-stop-btn")?.addEventListener("click", stopTimer);
  $("timer-reset-btn")?.addEventListener("click", resetTimer);

  // 도구 - 스톱워치
  $("stopwatch-start-btn")?.addEventListener("click", startStopwatch);
  $("stopwatch-stop-btn")?.addEventListener("click", stopStopwatch);
  $("stopwatch-reset-btn")?.addEventListener("click", resetStopwatch);

  // 도구 - 주사위
  $("dice-roll-btn")?.addEventListener("click", rollDice);

  // 도구 - 투표 (선택지 클릭 = 1표, 이벤트 위임)
  $("vote-create-btn")?.addEventListener("click", createVote);
  $("vote-option")?.addEventListener("keydown", (e) => { if (e.key === "Enter") createVote(); });
  $("vote-display")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-vote-reset]")) {
      if (voteState) { voteState.counts = voteState.options.map(() => 0); renderVote(); }
      return;
    }
    const opt = e.target.closest("[data-vote]");
    if (opt) castVote(Number(opt.dataset.vote));
  });

  // 도구 - 번호뽑기
  $("numberpick-btn")?.addEventListener("click", pickNumber);

  // 도구 - 가위바위보
  document.querySelectorAll("[data-rps]").forEach(btn => {
    btn.addEventListener("click", () => playRPS(btn.dataset.rps));
  });
}

async function start() {
  initTheme();
  bindEvents();
  bindEventsNew();
  state.selected = todayStr();
  updateAccountUI();

  // 각 기능 데이터 로드
  loadTimetable();
  loadSeating();
  loadStudents();
  loadSettings();

  // 현재 교시 하이라이트를 1분마다 갱신
  setInterval(() => {
    if (state.activeView === "home") renderTodayTimetable();
    if (state.activeView === "timetable") renderTimetable();
  }, 60000);

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
  renderTimetable();
  renderSeating();
  renderStudents();
  setView("home");   // 기본 화면: 대시보드
}

start();
