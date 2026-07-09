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
  memoFilter: "all",       // 메모 항목 필터 ("all" 또는 항목명)
  memoSearch: "",          // 메모 검색어
  paletteFor: null,        // 색상 팔레트가 열린 메모 id
  todos: [],               // 할 일 목록
  activeView: "home",      // 현재 탭 (home/calendar/memo/...)
  timetable: { mon: [], tue: [], wed: [], thu: [], fri: [] },
  seating: { rows: 6, cols: 8, grid: [] },
  students: [],
  classFilter: "all",      // 학생 목록 반 필터 ("all" 또는 반 이름)
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
// ---------- 메모 속 날짜 인식 → 달력 자동 반영 ----------
// 지원: 2026-07-15 · 7월 15일 · 7/15 · 오늘/내일/모레 (+ 14:00 · 오후 2시 · 2시 30분)
function extractDateFromMemo(text) {
  const now = new Date();
  let date = null, matched = "";
  let m;

  if ((m = /(\d{4})[.\/\-](\d{1,2})[.\/\-](\d{1,2})/.exec(text))) {
    const [, y, mo, d] = m.map(Number);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) { date = `${m[1]}-${pad(mo)}-${pad(d)}`; matched = m[0]; }
  } else if ((m = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(text))) {
    const mo = Number(m[1]), d = Number(m[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      let y = now.getFullYear();
      const cand = new Date(y, mo - 1, d);
      if (cand < now && (now - cand) / 86400000 > 120) y++;   // 4달 넘게 지난 날짜면 내년으로
      date = `${y}-${pad(mo)}-${pad(d)}`; matched = m[0];
    }
  } else if ((m = /(?:^|[^\d.\/])(\d{1,2})\/(\d{1,2})(?![\d\/])/.exec(text))) {
    const mo = Number(m[1]), d = Number(m[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      let y = now.getFullYear();
      const cand = new Date(y, mo - 1, d);
      if (cand < now && (now - cand) / 86400000 > 120) y++;
      date = `${y}-${pad(mo)}-${pad(d)}`; matched = m[1] + "/" + m[2];
    }
  } else if ((m = /오늘|내일|모레/.exec(text))) {
    const offset = { "오늘": 0, "내일": 1, "모레": 2 }[m[0]];
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    date = ymd(d); matched = m[0];
  }
  if (!date) return null;

  // 시간 추출 (선택)
  let time = null, timeMatched = "";
  let t;
  if ((t = /(\d{1,2}):(\d{2})/.exec(text))) {
    const h = Number(t[1]), mi = Number(t[2]);
    if (h <= 23 && mi <= 59) { time = `${pad(h)}:${pad(mi)}`; timeMatched = t[0]; }
  } else if ((t = /(오전|오후)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분|\s*(반))?/.exec(text))) {
    let h = Number(t[2]);
    const mi = t[4] ? 30 : Number(t[3] || 0);
    if (h >= 1 && h <= 24 && mi <= 59) {
      if (t[1] === "오후" && h < 12) h += 12;
      if (!t[1] && h <= 8) h += 12;   // 표기 없는 1~8시는 오후로 간주 (학교 일과 기준)
      if (h === 24) h = 0;
      time = `${pad(h)}:${pad(mi)}`; timeMatched = t[0];
    }
  }

  // 일정 제목: 날짜·시간 표현을 뺀 첫 줄
  let title = text.replace(matched, " ");
  if (timeMatched) title = title.replace(timeMatched, " ");
  title = title.split("\n")[0].replace(/\s+/g, " ").replace(/^[\s,.\-~에은는]+|[\s,.\-~에은는]+$/g, "").trim();
  if (title.length > 30) title = title.slice(0, 30) + "…";
  if (!title) title = "메모 일정";

  return { date, time, title };
}

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

  // 날짜가 들어 있으면 달력에도 자동 등록
  try {
    const hit = extractDateFromMemo(text);
    if (hit) {
      await saveEvent({
        id: null,
        title: hit.title,
        date: hit.date,
        allDay: !hit.time,
        start: hit.time || "",
        end: "",
        desc: `메모에서 자동 등록:\n${text}`,
        category: "personal",
      });
      await refreshEvents();
      toast(`📅 달력에도 추가했어요 — ${fmtDdayDate(hit.date)}${hit.time ? " " + hit.time : ""} '${hit.title}'`, 6000);
    }
  } catch (e) {
    console.error("메모→달력 자동 등록 실패", e);
  }
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

// 홈 대시보드의 최근 메모 카드 (고정 우선 + 최신순 5개)
function renderDashMemos() {
  const box = $("dash-memos");
  if (!box) return;
  const memos = [...state.memos].sort(byPinnedThenDate).slice(0, 5);
  if (!memos.length) {
    box.innerHTML = '<div class="today-timetable-empty">메모가 없습니다. 메모 탭에서 작성해 보세요.</div>';
    return;
  }
  box.innerHTML = memos.map((m) => `
    <div class="dash-memo mc-${m.color || "default"}" title="메모 탭으로 이동">
      ${m.pinned ? '<span class="dash-memo-pin">📌</span>' : ""}
      <span class="dash-memo-text">${escapeHtml(m.text)}</span>
      ${m.category ? `<span class="dash-memo-cat">${escapeHtml(m.category)}</span>` : ""}
    </div>`).join("");
}

// 메모가 특정 항목에 속하는지 (미분류 포함)
function memoInCat(m, cat) {
  return cat === UNCAT
    ? (!m.category || !state.memoCats.includes(m.category))
    : m.category === cat;
}
// 항목 필터 칩 (전체 · 수업 · 업무 · 개인 · … · 미분류)
function renderMemoFilter() {
  const bar = $("memo-filter");
  if (!bar) return;
  const hasUncat = state.memos.some((m) => memoInCat(m, UNCAT));
  const chips = [{ key: "all", label: "전체" }, ...state.memoCats.map((c) => ({ key: c, label: c }))];
  if (hasUncat) chips.push({ key: UNCAT, label: UNCAT });
  if (state.memoFilter !== "all" && !chips.some((c) => c.key === state.memoFilter)) state.memoFilter = "all";
  const countOf = (key) => key === "all" ? state.memos.length : state.memos.filter((m) => memoInCat(m, key)).length;
  bar.innerHTML = chips.map((c) =>
    `<button class="memo-chip${state.memoFilter === c.key ? " active" : ""}" data-cat="${escapeHtml(c.key)}">${escapeHtml(c.label)} ${countOf(c.key)}</button>`
  ).join("");
}

function renderMemos() {
  renderDashMemos();
  rebuildMemoCats();
  renderMemoCatSelect();
  renderMemoFilter();

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

  // 특정 항목 필터 선택 시: 그 항목만 평면 목록(고정 먼저)
  if (state.memoFilter !== "all") {
    const items = state.memos.filter((m) => memoInCat(m, state.memoFilter)).sort(byPinnedThenDate);
    if (!items.length) {
      list.appendChild(emptyNote(`'${state.memoFilter}' 항목의 메모가 없습니다.`));
      return;
    }
    list.appendChild(makeMemoGroup(state.memoFilter, items));
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
  content.title = "클릭하여 수정";
  content.addEventListener("click", () => startMemoEdit(li, m));
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

  // 수정
  const edit = iconBtn("✏️", "수정");
  edit.addEventListener("click", () => startMemoEdit(li, m));

  // 삭제
  const del = iconBtn("🗑", "삭제");
  del.classList.add("memo-del");
  del.addEventListener("click", () => removeMemo(m.id));

  actions.append(pin, palette, move, edit, del);
  foot.appendChild(actions);
  li.appendChild(foot);

  if (state.paletteFor === m.id) li.appendChild(makeColorPalette(m));

  return li;
}

// 메모 제자리 수정: 본문을 textarea로 바꿔 편집, 블러/Ctrl+Enter 저장, Esc 취소
function startMemoEdit(li, m) {
  if (li.querySelector(".memo-edit")) return;   // 이미 편집 중
  const content = li.querySelector(".memo-content");
  if (!content) return;

  const ta = document.createElement("textarea");
  ta.className = "memo-edit";
  ta.value = m.text;
  content.replaceWith(ta);
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.addEventListener("input", () => {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  });

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const text = ta.value.trim();
    if (!save || text === m.text.trim()) { renderMemos(); return; }   // 변경 없음/취소 → 원상복구
    if (!text) {
      if (confirm("내용이 비었습니다. 이 메모를 삭제할까요?")) await removeMemo(m.id);
      else renderMemos();
      return;
    }
    await updateMemo(m.id, { text });
    toast("메모를 수정했습니다");
  };
  ta.addEventListener("blur", () => finish(true));
  ta.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); ta.blur(); }
    if (e.key === "Escape") finish(false);
  });
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
      // 게시판 공유가 켜져 있으면 로그인 시점에 최신 출결을 한 번 발행
      if (attShare) publishAttendance();
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
  renderDashMemos();
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
  const allViews = ["home", "timetable", "seating", "students", "attendance", "observe", "calendar", "memo", "tools", "settings"];
  for (const v of allViews) {
    const el = $("view-" + v);
    if (el) el.classList.toggle("hidden", v !== name);
  }
  $("tabbar").querySelectorAll(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));

  // 각 뷰별 초기화
  if (name === "home") renderDashboard();
  if (name === "timetable") {
    const fr = $("tt-frame");
    const theme = document.documentElement.getAttribute("data-theme") || "light";
    if (fr && !fr.src) fr.src = `${COMCI_BASE}/?theme=${theme}`;   // 최초 진입 시에만 로드
    else if (fr) syncFrameTheme();   // 이미 로드됐으면 테마만 전달
    loadComci();
    renderProgress();
  }
  if (name === "seating") renderSeating();
  if (name === "students") renderStudents();
  if (name === "attendance") renderAttendance();
  if (name === "observe") renderObservations();
  if (name === "settings") {
    loadSettings();
    fillAggYear();
    renderAggSummary($("agg-year")?.value);
  }
  if (name === "calendar") { renderCalendar(); if (state.selected) renderDayDetail(); }
  if (name === "memo") renderMemos();
  if (name === "tools") renderToolClassSelects();

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
  syncFrameTheme();   // 임베드된 시간표 뷰어에도 테마 전달
}

// 임베드 시간표 뷰어에 현재 테마 전달 (postMessage)
function syncFrameTheme() {
  const fr = $("tt-frame");
  const theme = document.documentElement.getAttribute("data-theme") || "light";
  if (fr && fr.contentWindow && fr.src) {
    try { fr.contentWindow.postMessage({ type: "theme", theme }, "*"); } catch (e) { /* ignore */ }
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

  // 홈의 최근 메모 → 누르면 메모 탭으로
  $("dash-memos")?.addEventListener("click", () => setView("memo"));

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

  // 메모 항목 필터 칩 (전체/수업/업무/개인/…)
  $("memo-filter").addEventListener("click", (e) => {
    const chip = e.target.closest(".memo-chip");
    if (!chip) return;
    state.memoFilter = chip.dataset.cat;
    renderMemos();
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

// ============================================================
//  컴시간 시간표 데이터 (외부 뷰어와 동일 소스, CORS로 직접 fetch)
// ============================================================
const COMCI_BASE = "https://woorimalsam-lab.github.io/timetable";
const comci = { loaded: false, loading: false, teachers: [], perTeacher: {}, times: [], label: "", school: "" };

async function loadComci(force) {
  if (comci.loading || (comci.loaded && !force)) return comci.loaded;
  comci.loading = true;
  try {
    const idx = await (await fetch(`${COMCI_BASE}/data/index.json?t=${Date.now()}`)).json();
    const code = idx.school.code;
    const week = idx.current || (idx.weeks && idx.weeks[0] && idx.weeks[0].start);
    const data = await (await fetch(`${COMCI_BASE}/data/${code}_${week}.json?t=${Date.now()}`)).json();
    comci.teachers = data.teachers || [];
    comci.perTeacher = data.per_teacher || {};
    comci.times = data.period_times || [];
    comci.label = data.week_label || "";
    comci.school = idx.school.name || "";
    comci.loaded = true;
  } catch (e) {
    console.error("컴시간 데이터 로드 실패", e);
    comci.loaded = false;
  } finally {
    comci.loading = false;
  }
  // 로드 후 관련 화면 갱신
  if (state.activeView === "home") renderTodayTimetable();
  if (state.activeView === "timetable") renderProgress();
  return comci.loaded;
}

// 설정의 '내 이름'으로 담당 교사 찾기 (마스킹된 이름 대응: 김수* ← 김수연)
function myTeacherName() {
  return (state.settings?.teacher || "김수").replace(/\*/g, "").trim();
}
function myTeacher() {
  const key = myTeacherName();
  if (!key) return null;
  return comci.teachers.find((t) => {
    const n = (t.name || "").replace(/\*/g, "");
    return n && (key.startsWith(n) || n.startsWith(key));
  }) || null;
}
function myOcc() {
  const t = myTeacher();
  return t ? (comci.perTeacher[t.idx] || []) : [];
}
function comciPeriodIndex() {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return comci.times.findIndex((t) => {
    const start = timeToMin(t);
    return start !== null && nowMin >= start && nowMin < start + PERIOD_MINUTES;
  });
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

// 대시보드 카드: 컴시간 데이터에서 내 오늘 수업만 추려 표시 + 현재 교시 강조
function renderTodayTimetable() {
  const box = $("today-timetable");
  if (!box) return;
  const dayIdx = new Date().getDay() - 1;   // 월=0 … 금=4
  if (dayIdx < 0 || dayIdx > 4) {
    box.innerHTML = '<div class="today-timetable-empty">주말입니다 🎉</div>';
    return;
  }
  if (!comci.loaded) {
    box.innerHTML = comci.loading
      ? '<div class="today-timetable-empty">시간표 불러오는 중…</div>'
      : '<div class="today-timetable-empty">시간표를 불러오지 못했습니다</div>';
    if (!comci.loading) loadComci();
    return;
  }
  const t = myTeacher();
  if (!t) {
    box.innerHTML = '<div class="today-timetable-empty">설정에서 \'내 이름\'을 등록하면 오늘 수업이 표시됩니다</div>';
    return;
  }
  const nowP = comciPeriodIndex();
  const todays = myOcc().filter((e) => e.day === dayIdx).sort((a, b) => a.period - b.period);
  if (!todays.length) {
    box.innerHTML = '<div class="today-timetable-empty">오늘은 수업이 없습니다</div>';
    return;
  }
  box.innerHTML = todays.map((e) => {
    const isNow = e.period === nowP;
    const time = comci.times[e.period] || "";
    return `<div class="today-timetable-item${isNow ? " now" : ""}">` +
      `<b>${e.period + 1}교시</b> <span class="tt-time">${time}</span> ${escapeHtml(e.cls)} ${escapeHtml(e.sub)}` +
      `${isNow ? '<span class="tt-now-badge">지금</span>' : ""}</div>`;
  }).join("");
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
//  학급별 수업진도표 (시간표의 학급 라벨 기준)
// ============================================================
const LOCAL_PROGRESS_KEY = "myplanner.progress";
// 저장 구조: { "<학급 라벨>": [ {id, date, content}, ... ] }
let progress = {};

function loadProgress() {
  const p = loadLocal(LOCAL_PROGRESS_KEY);
  progress = (p && !Array.isArray(p)) ? p : {};
}
function saveProgress() {
  saveLocal(LOCAL_PROGRESS_KEY, progress);
}
// 진도표 학급 열: 내 시간표(컴시간)에서 담당 학급 + 이미 기록이 있는 학급
function timetableClasses() {
  const set = new Set();
  for (const e of myOcc()) if (e.cls) set.add(e.cls);   // 컴시간에서 내가 가르치는 반
  for (const label of Object.keys(progress)) set.add(label);   // 기존 기록 학급 유지
  return [...set].sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
}

let progressDraftDates = new Set();   // 기록 전 임시로 추가한 수업일(세션 한정)

// (학급, 날짜)에 해당하는 기록 (없으면 null)
function progressCell(cls, date) {
  return (progress[cls] || []).find((r) => r.date === date) || null;
}

// 날짜 × 학급 진도표 렌더 — 일자별로 쭉, 각 학급 칸은 즉시 편집·저장
function renderProgress() {
  const list = $("progress-list");
  if (!list) return;
  if (!$("progress-date").value) $("progress-date").value = todayStr();

  const classes = timetableClasses();
  if (!classes.length) {
    $("progress-count").textContent = "";
    list.innerHTML = '<p class="muted" style="text-align:center; padding: 18px;">시간표에 수업(학급)을 먼저 입력하면 여기서 진도를 기록할 수 있어요.</p>';
    return;
  }

  // 모든 기록 날짜 + 임시로 추가한 날짜 → 오름차순(과거 → 최근)
  const dateSet = new Set(progressDraftDates);
  let total = 0;
  for (const c of classes) for (const r of (progress[c] || [])) { dateSet.add(r.date); total++; }
  const dates = [...dateSet].sort();

  $("progress-count").textContent = total ? `${total}건` : "";
  if (!dates.length) {
    list.innerHTML = '<p class="muted" style="text-align:center; padding: 18px;">위에서 <b>수업일</b>을 추가하면 날짜별로 진도를 적을 수 있어요.</p>';
    return;
  }

  const wdName = (ds) => { const [y, m, d] = ds.split("-").map(Number); return "일월화수목금토"[new Date(y, m - 1, d).getDay()]; };
  let html = '<table class="progress-matrix"><thead><tr><th class="pm-date-h">날짜</th>';
  for (const c of classes) html += `<th>${escapeHtml(c)}</th>`;
  html += "</tr></thead><tbody>";
  for (const ds of dates) {
    const [y, m, d] = ds.split("-").map(Number);
    html += `<tr><td class="pm-date">${m}/${d}<span class="pm-wd">(${wdName(ds)})</span></td>`;
    for (const c of classes) {
      const rec = progressCell(c, ds);
      html += `<td><textarea class="progress-cell" data-cls="${escapeHtml(c)}" data-date="${ds}" data-pid="${rec ? rec.id : ""}" rows="1" placeholder="–">${rec ? escapeHtml(rec.content) : ""}</textarea></td>`;
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  list.innerHTML = html;

  // 내용에 맞춰 칸 높이 자동
  list.querySelectorAll(".progress-cell").forEach((ta) => {
    ta.style.height = "auto";
    ta.style.height = Math.max(34, ta.scrollHeight) + "px";
  });
}

// 수업일(빈 행) 추가
function addProgressDate() {
  const date = $("progress-date").value || todayStr();
  progressDraftDates.add(date);
  renderProgress();
  // 방금 추가한 날짜의 첫 학급 칸에 포커스
  const first = $("progress-list").querySelector(`.progress-cell[data-date="${date}"]`);
  if (first) first.focus();
}

// 칸 편집 저장: 있으면 수정/삭제, 없으면 생성
function saveProgressCell(cls, date, pid, value) {
  const val = value.trim();
  const arr = (progress[cls] ||= []);
  if (pid) {
    const r = arr.find((x) => x.id === pid);
    if (!r) return false;
    if (!val) {
      progress[cls] = arr.filter((x) => x.id !== pid);
      if (!progress[cls].length) delete progress[cls];
      saveProgress();
      return true;   // 구조 변경 → 재렌더 필요
    }
    if (r.content !== val) { r.content = val; saveProgress(); }
    return false;
  }
  if (val) {
    arr.push({ id: uid(), date, content: val });
    saveProgress();
    return true;   // 새 칸 → 재렌더(칸에 pid 부여)
  }
  return false;
}

// 선택 학급 또는 전체 진도표를 엑셀로
async function exportProgress() {
  const total = Object.values(progress).reduce((n, arr) => n + arr.length, 0);
  if (!total) { toast("내보낼 진도 기록이 없습니다"); return; }
  try { await ensureXLSX(); } catch (e) { toast(e.message); return; }

  const rows = [["학급", "날짜", "진도 내용"]];
  for (const cls of timetableClasses()) {
    const recs = [...(progress[cls] || [])].sort((a, b) => a.date.localeCompare(b.date));
    for (const r of recs) rows.push([cls, r.date, r.content]);
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 12 }, { wch: 12 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, ws, "수업진도표");
  XLSX.writeFile(wb, `수업진도표_${todayStr()}.xlsx`);
  toast(`📥 진도 기록 ${total}건을 엑셀로 저장했습니다`);
}

// ============================================================
//  자리배치
// ============================================================
let seatPicked = null;   // 자리 바꾸기용 첫 번째 선택 좌석 {r, c}

// 저장 구조: { rows, cols, currentGrade, currentClass, grids: { "학년|반": [[{num,name}|null,...]], ... } }
// 학급(학년+반)마다 배치를 따로 저장.
function emptyGrid(rows, cols) {
  return Array(rows).fill(null).map(() => Array(cols).fill(null));
}
function loadSeating() {
  const s = loadLocal(LOCAL_SEATING_KEY);
  if (s && !Array.isArray(s) && s.rows && s.cols && s.grids) {
    state.seating = s;
  } else if (s && !Array.isArray(s) && s.rows && s.cols && Array.isArray(s.grid)) {
    // 예전 단일 grid(이름 문자열) 형식 → 새 형식으로 이행
    const grid = s.grid.map((row) => row.map((cell) => (cell ? { num: "", name: cell } : null)));
    state.seating = { rows: s.rows, cols: s.cols, currentClass: "all", grids: { all: grid } };
  } else {
    state.seating = { rows: 5, cols: 6, currentClass: "all", grids: {} };
  }
  // 새 옵션 기본값 (구버전 저장분 보완)
  if (state.seating.pair !== 1 && state.seating.pair !== 2) state.seating.pair = 2;
  if (state.seating.view !== "teacher" && state.seating.view !== "student") state.seating.view = "teacher";
}
function saveSeating() {
  saveLocal(LOCAL_SEATING_KEY, state.seating);
}
// 현재 학급의 grid 키: "학년|반"
function seatKey() {
  return `${state.seating.currentGrade || ""}|${state.seating.currentClass || ""}`;
}
// 현재 학급의 grid (치수가 안 맞거나 없으면 새로 만듦)
function currentGrid() {
  const { rows, cols, grids } = state.seating;
  const key = seatKey();
  // 구버전(반 이름만으로 저장)의 배치를 새 키로 이행
  const legacy = state.seating.currentClass;
  if (!grids[key] && legacy && Array.isArray(grids[legacy])) {
    grids[key] = grids[legacy];
    delete grids[legacy];
  }
  let g = grids[key];
  if (!Array.isArray(g) || g.length !== rows || (g[0] || []).length !== cols) {
    g = emptyGrid(rows, cols);
    grids[key] = g;
  }
  return g;
}
// 선택된 학년·반의 학생들 (번호순)
function seatingStudents() {
  return toolStudents("seating-grade", "seating-class");
}

function renderSeating() {
  const display = $("seating-display");
  if (!display) return;

  // 학년·반 드롭다운 갱신 (저장된 선택 우선 반영)
  const gSel = $("seating-grade"), cSel = $("seating-class");
  if (gSel && cSel) {
    gSel.value = state.seating.currentGrade ?? "";
    cSel.value = state.seating.currentClass ?? "";
    fillGradeClassSelects("seating-grade", "seating-class");
    state.seating.currentGrade = gSel.value;
    state.seating.currentClass = cSel.value;
  }
  const count = $("seating-count");
  if (count) count.textContent = `${seatingStudents().length}명`;
  const pairSel = $("seating-pair"), viewSel = $("seating-view");
  if (pairSel) pairSel.value = String(state.seating.pair);
  if (viewSel) viewSel.value = state.seating.view;

  const { rows, cols, pair, view } = state.seating;
  const grid = currentGrid();
  const teacher = view === "teacher";

  // 교탁에서 본 배치 = 좌우 반전 + 앞줄이 아래(교탁 앞)로 오도록 상하 반전,
  // 교탁은 그림 아래쪽에 배치 → 교탁에 서서 보는 방향과 일치
  const colOrder = [];
  for (let c = 0; c < cols; c++) colOrder.push(teacher ? cols - 1 - c : c);
  const rowOrder = [];
  for (let r = 0; r < rows; r++) rowOrder.push(teacher ? rows - 1 - r : r);

  // 줄 묶음: pair개 열마다 통로(간격) 삽입
  const template = [];
  colOrder.forEach((_, i) => {
    template.push("1fr");
    if ((i + 1) % pair === 0 && i !== cols - 1) template.push("18px");
  });

  const g = state.seating.currentGrade, c2 = state.seating.currentClass;
  let html = `<div class="seating-print-title">${g ? g + "학년 " : ""}${c2 ? c2 + "반 " : ""}좌석표</div>`;
  if (!teacher) html += '<div class="seating-board">칠판 · 교탁</div>';
  html += `<div class="seating-grid" style="grid-template-columns: ${template.join(" ")}">`;
  for (const r of rowOrder) {
    colOrder.forEach((c, i) => {
      const seat = grid[r]?.[c];
      const sel = seatPicked && seatPicked.r === r && seatPicked.c === c;
      const label = seat
        ? `${seat.num ? `<b class="seat-num">${escapeHtml(seat.num)}</b>` : ""}${escapeHtml(seat.name)}`
        : "－";
      html += `<div class="seating-seat${seat ? "" : " empty"}${sel ? " selected" : ""}" data-row="${r}" data-col="${c}">${label}</div>`;
      if ((i + 1) % pair === 0 && i !== cols - 1) html += '<div class="seat-spacer"></div>';
    });
  }
  html += "</div>";
  if (teacher) html += '<div class="seating-board bottom">교탁 (칠판)</div>';
  html += '<p class="seating-hint muted">좌석을 하나 누른 뒤 다른 좌석을 누르면 서로 자리가 바뀝니다. 인쇄는 현재 화면의 방향·묶음 그대로 나갑니다.</p>';
  display.innerHTML = html;
}

// 좌석표 인쇄 (가로 A4, 좌석표만)
function printSeating() {
  if (!seatingStudents().length && !Object.keys(state.seating.grids).length) {
    toast("먼저 자리배치를 만들어 주세요");
    return;
  }
  const style = document.createElement("style");
  style.id = "print-orient-style";
  style.textContent = "@page { size: A4 landscape; margin: 12mm; }";
  document.head.appendChild(style);
  document.body.classList.add("print-seating");
  const cleanup = () => {
    document.body.classList.remove("print-seating");
    $("print-orient-style")?.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
  setTimeout(cleanup, 3000);   // afterprint 미지원 브라우저 대비
}
// 좌석 두 개를 차례로 눌러 맞바꾸기 (현재 반의 배치에서)
function onSeatClick(r, c) {
  if (!seatPicked) {
    seatPicked = { r, c };
  } else if (seatPicked.r === r && seatPicked.c === c) {
    seatPicked = null;   // 같은 좌석 다시 누르면 선택 해제
  } else {
    const g = currentGrid();
    [g[seatPicked.r][seatPicked.c], g[r][c]] = [g[r][c], g[seatPicked.r][seatPicked.c]];
    seatPicked = null;
    saveSeating();
  }
  renderSeating();
}
function randomSeating() {
  const pool = seatingStudents();
  if (!pool.length) { toast("이 반에 학생이 없습니다. '학생' 메뉴에서 명렬표를 올려 주세요."); return; }
  const seats = state.seating.rows * state.seating.cols;
  if (pool.length > seats) {
    toast(`좌석(${seats}석)보다 학생(${pool.length}명)이 많습니다. 행·열 설정에서 늘려 주세요.`, 5000);
    return;
  }
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const g = emptyGrid(state.seating.rows, state.seating.cols);
  let idx = 0;
  for (let r = 0; r < state.seating.rows && idx < shuffled.length; r++) {
    for (let c = 0; c < state.seating.cols && idx < shuffled.length; c++) {
      const s = shuffled[idx++];
      g[r][c] = { num: s.number || "", name: s.name };
    }
  }
  state.seating.grids[seatKey()] = g;
  seatPicked = null;
  saveSeating();
  renderSeating();
  const g2 = state.seating.currentGrade, c2 = state.seating.currentClass;
  const label = (g2 ? g2 + "학년 " : "") + (c2 ? c2 + "반 " : "");
  toast(`🔀 ${label}${shuffled.length}명 자리배치 완료`);
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
// 등록된 반 목록 (숫자 오름차순, 반 미지정은 뒤로)
function studentClasses() {
  const set = new Set(state.students.map((s) => s.class || ""));
  return [...set].sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b, "ko");
  });
}

// 반 필터 칩 (전체 · 7반 · 8반 · …) — 반이 2개 이상일 때만 표시
function renderClassFilter() {
  const bar = $("student-class-filter");
  if (!bar) return;
  const classes = studentClasses();
  if (classes.length < 2) {
    bar.innerHTML = "";
    state.classFilter = "all";
    return;
  }
  // 현재 필터가 사라진 반이면 전체로 복귀
  if (state.classFilter !== "all" && !classes.includes(state.classFilter)) state.classFilter = "all";

  const countOf = (c) => state.students.filter((s) => (s.class || "") === c).length;
  let html = `<button class="class-chip${state.classFilter === "all" ? " active" : ""}" data-class="all">전체 ${state.students.length}</button>`;
  for (const c of classes) {
    const label = c === "" ? "반 미지정" : `${escapeHtml(c)}반`;
    html += `<button class="class-chip${state.classFilter === c ? " active" : ""}" data-class="${escapeHtml(c)}">${label} ${countOf(c)}</button>`;
  }
  bar.innerHTML = html;
}

function renderStudents() {
  const list = $("students-list");
  if (!list) return;
  renderClassFilter();

  if (!state.students.length) {
    list.innerHTML = '<p style="text-align:center; color: var(--muted); padding: 20px;">학생을 추가하거나 NEIS 명렬표를 업로드해 주세요.</p>';
    return;
  }

  // 반 필터 적용
  const filtered = state.classFilter === "all"
    ? state.students
    : state.students.filter((s) => (s.class || "") === state.classFilter);

  if (!filtered.length) {
    list.innerHTML = '<p style="text-align:center; color: var(--muted); padding: 20px;">이 반에는 학생이 없습니다.</p>';
    return;
  }

  // 반 → 번호 → 이름 순 정렬
  const sorted = [...filtered].sort((a, b) =>
    (Number(a.class) || 0) - (Number(b.class) || 0) ||
    (Number(a.number) || 0) - (Number(b.number) || 0) ||
    a.name.localeCompare(b.name, "ko"));

  const label = state.classFilter === "all" ? "총" : `${state.classFilter}반`;
  let html = `<p class="muted" style="margin: 0 0 10px;">${label} ${sorted.length}명</p>`;
  let lastClass = null;
  for (const s of sorted) {
    if (state.classFilter === "all" && s.class && s.class !== lastClass) {
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
  let classIdx = -1, numberIdx = -1, nameIdx = -1, gradeIdx = -1;
  const scanMax = Math.min(data.length, 30);
  for (let r = 0; r < scanMax; r++) {
    const row = data[r] || [];
    let cI = -1, nI = -1, nmI = -1, gI = -1;
    for (let i = 0; i < row.length; i++) {
      const h = cellStr(row[i]).replace(/\s+/g, "").toLowerCase();
      if (!h) continue;
      if (h === "반" || h === "class") cI = i;
      if (h === "번호" || h === "번" || h === "no" || h === "number") nI = i;
      if (h === "성명" || h === "이름" || h === "name") nmI = i;
      if (h === "학년" || h === "grade") gI = i;
    }
    if (nmI !== -1) {
      headerRow = r; classIdx = cI; numberIdx = nI; nameIdx = nmI; gradeIdx = gI;
      break;
    }
  }

  // 2) 제목 행에서 "2학년 8반"/"2-8" 같은 학년·반 정보 추출
  let fallbackClass = "", fallbackGrade = "";
  const titleScan = headerRow > 0 ? headerRow : Math.min(data.length, 10);
  for (let r = 0; r < titleScan; r++) {
    const joined = (data[r] || []).map((v) => String(v ?? "")).join(" ");
    const m = /(\d{1,2})\s*학년\s*(\d{1,2})\s*반/.exec(joined) || /(\d{1,2})\s*-\s*(\d{1,2})/.exec(joined);
    if (m) { fallbackGrade = m[1]; fallbackClass = m[2]; break; }
  }

  let added = 0, skippedDup = 0;
  const pushStudent = (name, klass, number, grade) => {
    name = (name || "").trim();
    if (!name || /^\d+$/.test(name)) return;
    klass = (klass || "").replace(/반$/, "");
    number = (number || "").replace(/번$/, "");
    grade = (grade || "").replace(/학년$/, "");
    if (state.students.find((s) => s.name === name && s.class === klass && s.number === number)) {
      skippedDup++;
      return;
    }
    state.students.push({ id: uid(), name, grade, class: klass, number, notes: "", date: new Date().toISOString() });
    added++;
  };

  // 2.5) 헤더가 없으면 '사진명렬표' 형식 시도: "1번 강건" 같은 셀들이 흩어져 있음
  if (headerRow === -1) {
    const found = [];
    for (const row of data) {
      for (const cell of row || []) {
        const m = /^(\d{1,3})\s*번\s*(.+)$/.exec(String(cell ?? "").trim());
        if (m && m[2].trim() && !/^\d+$/.test(m[2].trim())) found.push({ number: m[1], name: m[2].trim() });
      }
    }
    if (found.length >= 3) {
      for (const f of found) pushStudent(f.name, fallbackClass, f.number, fallbackGrade);
      saveStudents();
      const dupMsg = skippedDup ? ` (중복 ${skippedDup}명 제외)` : "";
      return added
        ? { success: true, added, msg: `${added}명의 학생이 추가되었습니다${dupMsg}` }
        : { success: true, added, msg: `추가된 학생이 없습니다${dupMsg} — 이미 모두 등록되어 있어요` };
    }
  }

  for (let i = headerRow + 1; i < data.length; i++) {
    const row = (data[i] || []).map(cellStr);
    if (!row.some(Boolean)) continue;   // 빈 행

    let name, klass, number, grade;
    if (nameIdx !== -1) {
      name = row[nameIdx] || "";
      klass = (classIdx !== -1 ? row[classIdx] : "") || fallbackClass;
      number = numberIdx !== -1 ? row[numberIdx] : "";
      grade = (gradeIdx !== -1 ? row[gradeIdx] : "") || fallbackGrade;
    } else {
      // 헤더 없는 단순 형식: 반, 번호, 이름 순 (2칸이면 번호, 이름)
      const vals = row.filter(Boolean);
      if (vals.length >= 3) [klass, number, name] = vals;
      else if (vals.length === 2) { [number, name] = vals; klass = fallbackClass; }
      else { name = vals[0] || ""; klass = fallbackClass; number = ""; }
      grade = fallbackGrade;
    }

    pushStudent(name, klass, number, grade);
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
  state.settings = (s && !Array.isArray(s)) ? s : { school: "", grade: "", teacher: "", home: "home" };
  $("setting-school").value = state.settings.school || "";
  $("setting-grade").value = state.settings.grade || "";
  $("setting-teacher").value = state.settings.teacher || "";
  if ($("setting-home")) $("setting-home").value = state.settings.home || "home";
  if ($("setting-theme")) $("setting-theme").value = document.documentElement.getAttribute("data-theme") || "light";
}
function saveSettings() {
  state.settings = {
    ...state.settings,
    school: $("setting-school").value,
    grade: $("setting-grade").value,
    teacher: $("setting-teacher").value,
    home: $("setting-home") ? $("setting-home").value : "home",
  };
  saveLocal(LOCAL_SETTINGS_KEY, state.settings);
  renderDashboard();     // 인사말에 즉시 반영
  loadComci(true);       // 교사명 변경 시 내 수업 다시 매칭
  toast("설정이 저장되었습니다.");
}

// ============================================================
//  연도별 데이터 취합 (엑셀 여러 시트)
// ============================================================
function studentLabel(sid) {
  const s = state.students.find((x) => x.id === sid);
  if (!s) return "(삭제된 학생)";
  return `${s.class ? s.class + "-" : ""}${s.number ? s.number + "번 " : ""}${s.name}`;
}
// 데이터에 존재하는 모든 연도 (+올해)
function dataYears() {
  const set = new Set();
  const addFromDate = (d) => { if (d && d.length >= 4) set.add(d.slice(0, 4)); };
  loadLocal(LOCAL_EVENTS_KEY).forEach((e) => addFromDate(e.date));
  Object.keys(attendance || {}).forEach(addFromDate);
  Object.values(observations || {}).forEach((arr) => arr.forEach((o) => addFromDate(o.date)));
  Object.values(progress || {}).forEach((arr) => arr.forEach((p) => addFromDate(p.date)));
  const yearOf = (ms) => { const d = new Date(ms || 0); return isNaN(d) ? null : String(d.getFullYear()); };
  loadLocal(LOCAL_MEMOS_KEY).forEach((m) => { const y = yearOf(m.createdAt); if (y) set.add(y); });
  loadLocal(LOCAL_TODOS_KEY).forEach((t) => { const y = yearOf(t.createdAt); if (y) set.add(y); });
  set.add(String(new Date().getFullYear()));
  return [...set].sort((a, b) => b.localeCompare(a));
}
function fillAggYear() {
  const sel = $("agg-year");
  if (!sel) return;
  const years = dataYears();
  const prev = sel.value;
  sel.innerHTML = years.map((y) => `<option value="${y}">${y}년</option>`).join("");
  if (years.includes(prev)) sel.value = prev;
}
async function exportYearAggregate() {
  const year = $("agg-year")?.value;
  if (!year) { toast("연도를 선택해 주세요"); return; }
  try { await ensureXLSX(); } catch (e) { toast(e.message); return; }

  const CAT = { personal: "개인", work: "업무", subject: "교과", academic: "학사" };
  const wb = XLSX.utils.book_new();
  const addSheet = (name, rows) => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, name);
    return rows.length - 1;
  };
  const inYear = (d) => (d || "").startsWith(year + "-");
  const counts = {};

  // 일정
  const evRows = [["날짜", "분류", "제목", "시간", "메모"]];
  loadLocal(LOCAL_EVENTS_KEY).filter((e) => inYear(e.date))
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach((e) => evRows.push([e.date, CAT[e.category] || e.category || "", e.title || "", e.allDay ? "종일" : (e.start || ""), e.desc || ""]));
  counts["일정"] = addSheet("일정", evRows);

  // 출결
  const atRows = [["날짜", "학급", "번호", "이름", "상태", "비고"]];
  Object.keys(attendance || {}).filter((d) => d.startsWith(year + "-")).sort()
    .forEach((d) => {
      const byCls = attendance[d];
      Object.keys(byCls).forEach((clsKey) => {
        const recs = byCls[clsKey];
        Object.keys(recs).forEach((sid) => {
          const r = recs[sid];
          const s = state.students.find((x) => x.id === sid);
          atRows.push([d, s ? (s.class || "") : clsKey, s ? (s.number || "") : "", s ? s.name : "(삭제)", (r.t || "") + r.s, r.n || ""]);
        });
      });
    });
  counts["출결"] = addSheet("출결", atRows);

  // 학생관찰
  const obRows = [["학생", "날짜", "관찰 내용"]];
  Object.keys(observations || {}).forEach((sid) => {
    observations[sid].filter((o) => inYear(o.date)).sort((a, b) => a.date.localeCompare(b.date))
      .forEach((o) => obRows.push([studentLabel(sid), o.date, o.text || ""]));
  });
  counts["학생관찰"] = addSheet("학생관찰", obRows);

  // 수업진도
  const prRows = [["학급", "날짜", "진도 내용"]];
  Object.keys(progress || {}).sort().forEach((cls) => {
    progress[cls].filter((p) => inYear(p.date)).sort((a, b) => a.date.localeCompare(b.date))
      .forEach((p) => prRows.push([cls, p.date, p.content || ""]));
  });
  counts["수업진도"] = addSheet("수업진도", prRows);

  // 메모
  const moRows = [["작성일", "항목", "내용"]];
  loadLocal(LOCAL_MEMOS_KEY).filter((m) => { const d = new Date(m.createdAt || 0); return !isNaN(d) && String(d.getFullYear()) === year; })
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .forEach((m) => { const d = new Date(m.createdAt || 0); moRows.push([`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, m.category || "", m.text || ""]); });
  counts["메모"] = addSheet("메모", moRows);

  // 할 일
  const tdRows = [["작성일", "완료", "내용"]];
  loadLocal(LOCAL_TODOS_KEY).filter((t) => { const d = new Date(t.createdAt || 0); return !isNaN(d) && String(d.getFullYear()) === year; })
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .forEach((t) => { const d = new Date(t.createdAt || 0); tdRows.push([`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, t.done ? "완료" : "", t.text || ""]); });
  counts["할일"] = addSheet("할 일", tdRows);

  // 요약 시트 (맨 앞)
  const sumRows = [[`${year}년 데이터 취합`, ""], ["항목", "건수"]];
  Object.keys(counts).forEach((k) => sumRows.push([k, counts[k]]));
  const sumWs = XLSX.utils.aoa_to_sheet(sumRows);
  XLSX.utils.book_append_sheet(wb, sumWs, "요약");
  wb.SheetNames.unshift(wb.SheetNames.pop());   // 요약을 맨 앞으로

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) { toast(`${year}년에 취합할 데이터가 없습니다`); return; }
  XLSX.writeFile(wb, `${(state.settings.school || "김수연샘핀")}_${year}년_전체데이터.xlsx`);
  renderAggSummary(year, counts);
  toast(`📊 ${year}년 데이터 ${total}건을 엑셀로 취합했습니다`);
}
function renderAggSummary(year, counts) {
  const box = $("agg-summary");
  if (!box) return;
  if (!counts) {
    const inYear = (d) => (d || "").startsWith(year + "-");
    counts = {
      "일정": loadLocal(LOCAL_EVENTS_KEY).filter((e) => inYear(e.date)).length,
      "출결": Object.keys(attendance || {}).filter((d) => d.startsWith(year + "-"))
        .reduce((n, d) => n + Object.values(attendance[d]).reduce((m, c) => m + Object.keys(c).length, 0), 0),
      "학생관찰": Object.values(observations || {}).reduce((n, arr) => n + arr.filter((o) => inYear(o.date)).length, 0),
      "수업진도": Object.values(progress || {}).reduce((n, arr) => n + arr.filter((p) => inYear(p.date)).length, 0),
    };
  }
  box.innerHTML = Object.keys(counts).map((k) => `<span class="agg-chip">${k} <b>${counts[k]}</b></span>`).join("");
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
// ============================================================
//  도구 — 발표자 뽑기 · 모둠 편성 (학년·학급 선택, 학생 명단 연동)
// ============================================================
const pickedByClass = {};        // 발표자 뽑기 '중복 제외'용 (학년-반별, 세션 한정)
let groupLeaderIds = new Set();  // 모둠 편성에서 선택한 모둠장들

function distinctGrades() {
  return [...new Set(state.students.map((s) => s.grade || ""))]
    .sort((a, b) => (Number(a) || 99) - (Number(b) || 99));
}
function classesOfGrade(grade) {
  return [...new Set(state.students.filter((s) => (s.grade || "") === grade).map((s) => s.class || ""))]
    .sort((a, b) => (Number(a) || 99) - (Number(b) || 99));
}
// 학년 select + 그 학년의 학급 select 채우기 (선택값 유지)
function fillGradeClassSelects(gradeId, classId) {
  const gSel = $(gradeId), cSel = $(classId);
  if (!gSel || !cSel) return;
  if (!state.students.length) {
    gSel.innerHTML = '<option value="">-</option>';
    cSel.innerHTML = '<option value="">학생 없음</option>';
    return;
  }
  const grades = distinctGrades();
  const prevG = gSel.value;
  gSel.innerHTML = grades.map((g) => `<option value="${g}">${g ? g + "학년" : "학년 미지정"}</option>`).join("");
  if (grades.includes(prevG)) gSel.value = prevG;

  const classes = classesOfGrade(gSel.value);
  const prevC = cSel.value;
  cSel.innerHTML = classes.map((c) => `<option value="${c}">${c ? c + "반" : "반 미지정"}</option>`).join("");
  if (classes.includes(prevC)) cSel.value = prevC;
}
// 선택된 학년·학급의 학생 (번호순)
function toolStudents(gradeId, classId) {
  const g = $(gradeId)?.value ?? "", c = $(classId)?.value ?? "";
  if (!state.students.length) return [];
  return state.students
    .filter((s) => (s.grade || "") === g && (s.class || "") === c)
    .sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
}
function renderToolClassSelects() {
  fillGradeClassSelects("picker-grade", "picker-class");
  fillGradeClassSelects("group-grade", "group-class");
  renderGroupRoster();
  renderPickerHistory();
}

// 발표자 뽑기
const LOCAL_PICKLOG_KEY = "myplanner.picklog";
let pickLog = {};   // { "학년-반": [{grade, class, number, name, at}, ...] }  뽑은 순서 기록

function loadPickLog() {
  const p = loadLocal(LOCAL_PICKLOG_KEY);
  pickLog = (p && !Array.isArray(p)) ? p : {};
}
function savePickLog() {
  saveLocal(LOCAL_PICKLOG_KEY, pickLog);
}
function pickerKey() {
  return `${$("picker-grade")?.value ?? ""}-${$("picker-class")?.value ?? ""}`;
}

function pickPresenter() {
  const pool = toolStudents("picker-grade", "picker-class");
  if (!pool.length) { toast("'학생' 메뉴에서 명렬표를 먼저 올려 주세요"); return; }
  const key = pickerKey();

  let candidates = pool;
  if ($("picker-norepeat")?.checked) {
    const picked = (pickedByClass[key] ||= new Set());
    candidates = pool.filter((s) => !picked.has(s.id));
    if (!candidates.length) {
      picked.clear();
      candidates = pool;
      toast("한 바퀴 다 돌았어요! 처음부터 다시 뽑습니다 🔄");
    }
  }
  const s = candidates[Math.floor(Math.random() * candidates.length)];
  if ($("picker-norepeat")?.checked) pickedByClass[key].add(s.id);

  // 기록 저장 (학급별, 시각 포함)
  (pickLog[key] ||= []).push({
    grade: s.grade || "", class: s.class || "", number: s.number || "", name: s.name,
    at: new Date().toISOString(),
  });
  savePickLog();

  const remain = $("picker-norepeat")?.checked ? ` <span class="picker-remain">(남은 인원 ${pool.length - pickedByClass[key].size}명)</span>` : "";
  $("picker-result").innerHTML =
    `<div class="picker-name">${s.number ? `<b>${escapeHtml(s.number)}번</b> ` : ""}${escapeHtml(s.name)}</div>${remain}`;
  renderPickerHistory();
}

// 뽑기 기록 (현재 학급) — 순서대로 한눈에 + 엑셀 저장/지우기
function renderPickerHistory() {
  const box = $("picker-history");
  if (!box) return;
  const log = pickLog[pickerKey()] || [];
  if (!log.length) { box.innerHTML = ""; return; }
  box.innerHTML =
    `<div class="picker-history-head">
       <b>뽑은 순서 (${log.length}회)</b>
       <span class="spacer"></span>
       <button id="picklog-export-btn" class="btn btn-ghost btn-sm">📥 엑셀 저장</button>
       <button id="picklog-clear-btn" class="btn btn-ghost btn-sm">기록 지우기</button>
     </div>
     <ol class="picker-history-list">` +
    log.map((p) =>
      `<li>${p.number ? `<b>${escapeHtml(p.number)}번</b> ` : ""}${escapeHtml(p.name)}</li>`
    ).join("") +
    "</ol>";
}

async function exportPickLog() {
  const key = pickerKey();
  const log = pickLog[key] || [];
  if (!log.length) { toast("내보낼 기록이 없습니다"); return; }
  try {
    await ensureXLSX();
  } catch (e) {
    toast(e.message);
    return;
  }
  const rows = [["순서", "학년", "반", "번호", "이름"]];
  log.forEach((p, i) => {
    rows.push([i + 1, p.grade, p.class, p.number, p.name]);
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, ws, "발표자 뽑기");
  const g = $("picker-grade")?.value, c = $("picker-class")?.value;
  const today = todayStr();
  XLSX.writeFile(wb, `발표자뽑기_${g ? g + "학년" : ""}${c ? c + "반" : ""}_${today}.xlsx`);
  toast("📥 엑셀 파일로 저장했습니다");
}
function clearPickLog() {
  const key = pickerKey();
  if (!(pickLog[key] || []).length) return;
  if (!confirm("이 학급의 뽑기 기록을 지울까요? ('중복 제외' 순환도 처음부터 다시 시작합니다)")) return;
  delete pickLog[key];
  pickedByClass[key]?.clear();
  savePickLog();
  renderPickerHistory();
}

// ============================================================
//  출결 관리 — 날짜별 학급 출결부 (학사일정 달력 연동)
// ============================================================
const LOCAL_ATTENDANCE_KEY = "myplanner.attendance";
const ATT_TYPES = ["질병", "인정", "미인정"];      // 사유 유형 (나이스 기준)
const ATT_RESULTS = ["지각", "조퇴", "결석"];      // 결과
// 저장 구조: { "YYYY-MM-DD": { "학년-반": { 학생id: {s: 결과, t: 유형, n: 비고} } } }
// 예: 질병+결석 → {s:"결석", t:"질병"} = 질병결석. 출석(기본값)이고 유형·비고 없으면 저장 안 함
let attendance = {};
let attDate = "";

function loadAttendance() {
  const a = loadLocal(LOCAL_ATTENDANCE_KEY);
  attendance = (a && !Array.isArray(a)) ? a : {};
  attDate = todayStr();
}
function saveAttendance() {
  saveLocal(LOCAL_ATTENDANCE_KEY, attendance);
  schedulePublishAttendance();
}

// ---- 학급 게시판 공유 ----------------------------------------
// 켜두면 출결 저장 시 Firestore(classboard/attendance)에 자동 발행되어
// 학급 게시판(https://woorimalsam-lab.github.io/classroom/)에 표시됩니다.
// 학생 개인정보 보호를 위해 비고(n)는 공유하지 않습니다.
const LOCAL_ATT_SHARE_KEY = "myplanner.attShare";
let attShare = false;
let attPublishTimer = null;

function loadAttShare() {
  attShare = localStorage.getItem(LOCAL_ATT_SHARE_KEY) === "1";
  renderAttShareBtn();
}
function renderAttShareBtn() {
  const btn = $("att-share-btn");
  if (!btn) return;
  btn.textContent = attShare ? "🌐 게시판 공유: 켜짐" : "🌐 게시판 공유: 꺼짐";
  btn.classList.toggle("btn-primary", attShare);
  btn.classList.toggle("btn-ghost", !attShare);
}
async function toggleAttShare() {
  if (!attShare && (!fb || !state.user)) {
    toast("게시판 공유는 구글 로그인 후 사용할 수 있습니다");
    return;
  }
  attShare = !attShare;
  localStorage.setItem(LOCAL_ATT_SHARE_KEY, attShare ? "1" : "0");
  renderAttShareBtn();
  if (attShare) {
    await publishAttendance();
    toast("이제 출결을 입력하면 학급 게시판에 자동 반영됩니다 🌐");
  } else {
    toast("게시판 공유를 껐습니다 (이미 공유된 내용은 남아 있습니다)");
  }
}
function schedulePublishAttendance() {
  if (!attShare || !fb || !state.user) return;
  clearTimeout(attPublishTimer);
  attPublishTimer = setTimeout(publishAttendance, 1500);
}
async function publishAttendance() {
  if (!fb || !state.user) return;
  try {
    const byId = Object.fromEntries(state.students.map((s) => [s.id, s]));
    const days = {};
    for (const [date, classes] of Object.entries(attendance)) {
      for (const [classKey, recs] of Object.entries(classes)) {
        const list = Object.entries(recs)
          .filter(([, r]) => r.s && r.s !== "출석")   // 지각·조퇴·결석만 공유 (비고만 있는 학생 제외)
          .map(([sid, r]) => ({
            no: Number(byId[sid]?.number) || 0,
            name: byId[sid]?.name || "(명단 외)",
            s: r.s,
            label: attLabel(r),
          }));
        if (list.length) (days[date] ||= {})[classKey] = list;
      }
    }
    const { doc, setDoc } = fb.fs;
    await setDoc(doc(fb.db, "classboard", "attendance"), {
      updatedAt: new Date().toISOString(),
      days,
    });
  } catch (e) {
    console.error("출결 게시판 공유 실패", e);
    toast("게시판 공유 실패 — Firestore 규칙 설정을 확인해 주세요", 6000);
  }
}
function attKey() {
  return `${$("att-grade")?.value ?? ""}-${$("att-class")?.value ?? ""}`;
}
function attRecords() {
  return (attendance[attDate] || {})[attKey()] || {};
}
function setAttRecord(sid, patch) {
  const day = (attendance[attDate] ||= {});
  const cls = (day[attKey()] ||= {});
  const rec = { s: "출석", t: "", n: "", ...(cls[sid] || {}), ...patch };
  if (rec.s === "출석" && !rec.t && !rec.n.trim()) delete cls[sid];   // 기본 상태는 저장 안 함
  else cls[sid] = rec;
  if (!Object.keys(cls).length) delete day[attKey()];
  if (!Object.keys(day).length) delete attendance[attDate];
  saveAttendance();
}
// 기록 표시용 라벨: 유형+결과 (예: 질병결석, 인정지각, 유형 없으면 결석)
function attLabel(rec) {
  return rec.s === "출석" ? "출석" : `${rec.t || ""}${rec.s}`;
}
function shiftAttDate(delta) {
  const [y, m, d] = attDate.split("-").map(Number);
  attDate = ymd(new Date(y, m - 1, d + delta));
  renderAttendance();
}
// 학사일정 기준 휴일/주말 여부
function isSchoolOff(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = new Date(y, m - 1, d).getDay();
  if (wd === 0 || wd === 6) return "주말";
  if (academicEvents.some((a) => a.date === dateStr && a.holiday)) return "휴일";
  return null;
}

function renderAttendance() {
  const list = $("att-list");
  if (!list) return;
  fillGradeClassSelects("att-grade", "att-class");
  $("att-date").value = attDate;

  // 날짜 정보: 학사일정·휴일 표시 (달력 데이터 연동)
  const [y, m, d] = attDate.split("-").map(Number);
  const wd = "일월화수목금토"[new Date(y, m - 1, d).getDay()];
  const evs = academicEvents.filter((a) => a.date === attDate);
  const off = isSchoolOff(attDate);
  let info = `${m}월 ${d}일 (${wd})`;
  if (evs.length) info += ` · 📌 ${evs.map((a) => a.title).join(" · ")}`;
  $("att-dayinfo").innerHTML = off
    ? `<span class="att-off">⚠️ ${info} — ${off}입니다</span>`
    : info;

  const pool = toolStudents("att-grade", "att-class");
  if (!pool.length) {
    $("att-summary").innerHTML = "";
    list.innerHTML = '<p class="muted" style="text-align:center; padding: 20px;">\'학생\' 메뉴에서 명렬표를 먼저 올려 주세요.</p>';
    return;
  }

  const recs = attRecords();
  const counts = { 출석: 0, 지각: 0, 조퇴: 0, 결석: 0 };
  const rows = pool.map((s) => {
    const r = { s: "출석", t: "", n: "", ...(recs[s.id] || {}) };
    counts[r.s] = (counts[r.s] || 0) + 1;
    return `
    <div class="att-row" data-sid="${s.id}">
      <span class="att-name">${s.number ? `<b>${escapeHtml(s.number)}</b> ` : ""}${escapeHtml(s.name)}</span>
      <div class="att-segwrap">
        <div class="att-seg">
          <button class="att-btn st-출석${r.s === "출석" && !r.t ? " active" : ""}" data-att-ok="1">출석</button>
        </div>
        <div class="att-seg">${ATT_TYPES.map((tp) =>
          `<button class="att-btn tp-${tp}${r.t === tp ? " active" : ""}" data-att-type="${tp}">${tp}</button>`).join("")}</div>
        <div class="att-seg">${ATT_RESULTS.map((st) =>
          `<button class="att-btn st-${st}${r.s === st ? " active" : ""}" data-att-res="${st}">${st}</button>`).join("")}</div>
      </div>
      <input class="att-note" placeholder="비고(사유)" value="${escapeHtml(r.n || "")}" />
    </div>`;
  });

  $("att-summary").innerHTML =
    ["출석", ...ATT_RESULTS].map((st) => `<span class="att-chip st-${st}${st !== "출석" && counts[st] ? " has" : ""}">${st} ${counts[st] || 0}</span>`).join("") +
    `<span class="muted" style="margin-left: 4px;">/ ${pool.length}명</span>`;
  list.innerHTML = rows.join("");
}

// 이번 달 출결부 엑셀 내보내기 — 선택한 상태 그대로(지각/조퇴/결석) + 사유 병기, -=휴일·주말
async function exportAttendanceMonth() {
  const pool = toolStudents("att-grade", "att-class");
  if (!pool.length) { toast("'학생' 메뉴에서 명렬표를 먼저 올려 주세요"); return; }
  try { await ensureXLSX(); } catch (e) { toast(e.message); return; }

  const [y, m] = attDate.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const key = attKey();

  const header = ["번호", "이름"];
  const dayMeta = [];
  for (let d = 1; d <= lastDay; d++) {
    const ds = `${y}-${pad(m)}-${pad(d)}`;
    dayMeta.push({ ds, off: !!isSchoolOff(ds) });
    header.push(`${d}(${"일월화수목금토"[new Date(y, m - 1, d).getDay()]})`);
  }
  header.push("지각", "조퇴", "결석", "비고 모음");

  const rows = [header];
  for (const s of pool) {
    const row = [s.number, s.name];
    let late = 0, early = 0, absent = 0;
    const noteList = [];
    for (const dm of dayMeta) {
      if (dm.off) { row.push("-"); continue; }
      const r = attendance[dm.ds]?.[key]?.[s.id];
      if (!r) { row.push(""); continue; }
      const note = (r.n || "").trim();
      if (r.s === "지각") late++;
      else if (r.s === "조퇴") early++;
      else if (r.s === "결석") absent++;
      // 유형+결과를 그대로 기록(질병결석·인정지각 등), 사유는 괄호 병기
      const label = attLabel(r);
      let cell = r.s === "출석" ? "" : label;
      if (note) cell = cell ? `${cell}(${note})` : `(${note})`;
      row.push(cell);
      if (r.s !== "출석" || note) {
        noteList.push(`${Number(dm.ds.slice(8))}일 ${label}${note ? `(${note})` : ""}`);
      }
    }
    row.push(late, early, absent, noteList.join(", "));
    rows.push(row);
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 5 }, { wch: 10 }, ...dayMeta.map(() => ({ wch: 9 })), { wch: 5 }, { wch: 5 }, { wch: 5 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ws, `${m}월 출결`);
  const g = $("att-grade")?.value, c = $("att-class")?.value;
  XLSX.writeFile(wb, `출결_${g ? g + "학년" : ""}${c ? c + "반" : ""}_${y}-${pad(m)}.xlsx`);
  toast("📥 이번 달 출결부를 엑셀로 저장했습니다 (상태·사유 포함)");
}

// ============================================================
//  학생관찰 기록 — 학생별·일자별 누가 기록
// ============================================================
const LOCAL_OBS_KEY = "myplanner.observations";
// 저장 구조: { 학생id: [ {id, date: "YYYY-MM-DD", text}, ... ] }
let observations = {};

function loadObservations() {
  const o = loadLocal(LOCAL_OBS_KEY);
  observations = (o && !Array.isArray(o)) ? o : {};
}
function saveObservations() {
  saveLocal(LOCAL_OBS_KEY, observations);
}

// 학생 선택 드롭다운 채우기 (선택 유지, 기록 건수 표시)
function fillObsStudentSelect() {
  const sel = $("obs-student");
  if (!sel) return;
  const pool = toolStudents("obs-grade", "obs-class");
  const prev = sel.value;
  sel.innerHTML = pool.length
    ? pool.map((s) => {
        const n = (observations[s.id] || []).length;
        return `<option value="${s.id}">${s.number ? s.number + "번 " : ""}${escapeHtml(s.name)}${n ? ` (${n})` : ""}</option>`;
      }).join("")
    : '<option value="">학생 없음</option>';
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function renderObservations() {
  const list = $("obs-list");
  if (!list) return;
  fillGradeClassSelects("obs-grade", "obs-class");
  fillObsStudentSelect();
  if (!$("obs-date").value) $("obs-date").value = todayStr();

  const sid = $("obs-student")?.value;
  if (!sid) {
    $("obs-count").textContent = "";
    list.innerHTML = '<p class="muted" style="text-align:center; padding: 20px;">\'학생\' 메뉴에서 명렬표를 먼저 올려 주세요.</p>';
    return;
  }

  const recs = [...(observations[sid] || [])].sort((a, b) => b.date.localeCompare(a.date));
  $("obs-count").textContent = recs.length ? `${recs.length}건` : "";
  if (!recs.length) {
    list.innerHTML = '<p class="muted" style="text-align:center; padding: 20px;">아직 기록이 없습니다. 위에 첫 관찰을 기록해 보세요.</p>';
    return;
  }

  list.innerHTML = recs.map((r) => {
    const [y, m, d] = r.date.split("-").map(Number);
    const wd = "일월화수목금토"[new Date(y, m - 1, d).getDay()];
    return `
    <div class="obs-item" data-oid="${r.id}">
      <div class="obs-item-head">
        <span class="obs-date-badge">${m}/${d} (${wd})</span>
        <span class="spacer"></span>
        <button class="obs-del" data-oid="${r.id}" title="삭제">✕</button>
      </div>
      <textarea class="obs-item-text" data-oid="${r.id}" rows="2">${escapeHtml(r.text)}</textarea>
    </div>`;
  }).join("");
}

function addObservation() {
  const sid = $("obs-student")?.value;
  if (!sid) { toast("학생을 먼저 선택해 주세요"); return; }
  const text = $("obs-text").value.trim();
  if (!text) { toast("관찰 내용을 입력해 주세요"); return; }
  const date = $("obs-date").value || todayStr();
  (observations[sid] ||= []).push({ id: uid(), date, text });
  saveObservations();
  $("obs-text").value = "";
  renderObservations();
  toast("👀 관찰 기록을 저장했습니다");
}
function removeObservation(sid, oid) {
  observations[sid] = (observations[sid] || []).filter((r) => r.id !== oid);
  if (!observations[sid].length) delete observations[sid];
  saveObservations();
  renderObservations();
}
function updateObservation(sid, oid, text) {
  const r = (observations[sid] || []).find((x) => x.id === oid);
  if (!r) return;
  if (!text.trim()) { removeObservation(sid, oid); return; }
  r.text = text;
  saveObservations();
}

// 선택한 학급의 관찰 기록 전체를 엑셀로 (번호순 → 날짜순)
async function exportObservations() {
  const pool = toolStudents("obs-grade", "obs-class");
  if (!pool.length) { toast("'학생' 메뉴에서 명렬표를 먼저 올려 주세요"); return; }

  const rows = [["학년", "반", "번호", "이름", "날짜", "관찰 내용"]];
  for (const s of pool) {
    const recs = [...(observations[s.id] || [])].sort((a, b) => a.date.localeCompare(b.date));
    for (const r of recs) {
      rows.push([s.grade || "", s.class || "", s.number || "", s.name, r.date, r.text]);
    }
  }
  if (rows.length === 1) { toast("내보낼 관찰 기록이 없습니다"); return; }

  try { await ensureXLSX(); } catch (e) { toast(e.message); return; }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 5 }, { wch: 5 }, { wch: 5 }, { wch: 10 }, { wch: 12 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, ws, "학생관찰");
  const g = $("obs-grade")?.value, c = $("obs-class")?.value;
  XLSX.writeFile(wb, `학생관찰_${g ? g + "학년" : ""}${c ? c + "반" : ""}_${todayStr()}.xlsx`);
  toast(`📥 관찰 기록 ${rows.length - 1}건을 엑셀로 저장했습니다`);
}

// 모둠 편성: 명렬표에서 모둠장을 클릭해 고르면, 나머지는 랜덤 배분
function renderGroupRoster() {
  const box = $("group-roster");
  if (!box) return;
  const pool = toolStudents("group-grade", "group-class");
  // 반이 바뀌어 명단에 없는 모둠장은 선택 해제
  groupLeaderIds = new Set([...groupLeaderIds].filter((id) => pool.some((s) => s.id === id)));

  if (!pool.length) {
    box.innerHTML = '<p class="muted" style="margin:6px 0;">학생이 없습니다. \'학생\' 메뉴에서 명렬표를 올려 주세요.</p>';
    const res = $("group-result"); if (res) res.innerHTML = "";
    return;
  }
  box.innerHTML =
    '<p class="group-roster-hint muted">👑 모둠장이 될 학생을 눌러 선택하세요 — 선택한 수만큼 모둠이 만들어집니다</p>' +
    '<div class="roster-chips">' +
    pool.map((s) =>
      `<button class="roster-chip${groupLeaderIds.has(s.id) ? " leader" : ""}" data-sid="${s.id}">` +
      `${s.number ? `<b>${escapeHtml(s.number)}</b> ` : ""}${escapeHtml(s.name)}</button>`
    ).join("") +
    "</div>";
}
function makeGroups() {
  const pool = toolStudents("group-grade", "group-class");
  if (!pool.length) { toast("'학생' 메뉴에서 명렬표를 먼저 올려 주세요"); return; }
  const leaders = pool.filter((s) => groupLeaderIds.has(s.id));
  if (!leaders.length) { toast("👑 모둠장이 될 학생을 먼저 눌러 선택해 주세요"); return; }

  const rest = pool.filter((s) => !groupLeaderIds.has(s.id));
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const groups = leaders.map((l) => [l]);
  rest.forEach((s, i) => groups[i % groups.length].push(s));

  $("group-result").innerHTML = groups.map((g, i) => `
    <div class="group-box">
      <div class="group-box-head">${i + 1}모둠 <span class="muted">${g.length}명</span></div>
      ${g.map((s, idx) => `<div class="group-member${idx === 0 ? " is-leader" : ""}">${idx === 0 ? "👑 " : ""}${s.number ? `<b>${escapeHtml(s.number)}</b> ` : ""}${escapeHtml(s.name)}</div>`).join("")}
    </div>`).join("");
}

// ============================================================
//  도구 — 국어과: 토론 타이머 · 초성 퀴즈 · 낱말 뽑기 · 글자 수
// ============================================================

// ---------- 토론 타이머 ----------
let debate = null;   // { stages: [{name, sec}], idx, endAt, remain, timer, paused }

function beep(times = 2) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.25, ctx.currentTime + i * 0.4);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + i * 0.4 + 0.3);
      osc.start(ctx.currentTime + i * 0.4);
      osc.stop(ctx.currentTime + i * 0.4 + 0.32);
    }
  } catch { /* 소리 재생 불가 환경은 무시 */ }
}

function parseDebateStages() {
  const stages = [];
  for (const line of $("debate-stages").value.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let m = /^(.*?)\s+(\d{1,2}):(\d{2})$/.exec(t);
    if (m) { stages.push({ name: m[1].trim(), sec: Number(m[2]) * 60 + Number(m[3]) }); continue; }
    m = /^(.*?)\s+(\d+)\s*분$/.exec(t);
    if (m) stages.push({ name: m[1].trim(), sec: Number(m[2]) * 60 });
  }
  return stages.filter((s) => s.name && s.sec > 0);
}
function fmtSec(sec) {
  return `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
}
function renderDebate() {
  if (!debate) return;
  const cur = debate.stages[debate.idx];
  $("debate-stage-label").textContent = `${debate.idx + 1}/${debate.stages.length} · ${cur.name}`;
  const remain = debate.paused ? debate.remain : Math.max(0, Math.round((debate.endAt - Date.now()) / 1000));
  const timerEl = $("debate-timer");
  timerEl.textContent = fmtSec(remain);
  timerEl.classList.toggle("urgent", remain <= 10);
  const next = debate.stages[debate.idx + 1];
  $("debate-next").textContent = next ? `다음: ${next.name} (${fmtSec(next.sec)})` : "마지막 단계입니다";
}
function debateTick() {
  if (!debate || debate.paused) return;
  const remain = Math.round((debate.endAt - Date.now()) / 1000);
  if (remain <= 0) {
    beep();
    if (debate.idx + 1 < debate.stages.length) {
      debate.idx++;
      debate.endAt = Date.now() + debate.stages[debate.idx].sec * 1000;
      toast(`⚖️ ${debate.stages[debate.idx].name} 시작!`);
    } else {
      stopDebate();
      $("debate-stage-label").textContent = "토론 종료 🎉";
      $("debate-timer").textContent = "0:00";
      $("debate-next").textContent = "수고하셨습니다";
      return;
    }
  }
  renderDebate();
}
function startDebate() {
  const stages = parseDebateStages();
  if (!stages.length) { toast("단계를 '이름 분:초' 형식으로 한 줄씩 입력해 주세요"); return; }
  debate = { stages, idx: 0, endAt: Date.now() + stages[0].sec * 1000, remain: 0, paused: false, timer: setInterval(debateTick, 300) };
  $("debate-setup").classList.add("hidden");
  $("debate-run").classList.remove("hidden");
  $("debate-pause-btn").textContent = "⏸ 일시정지";
  renderDebate();
}
function stopDebate() {
  if (debate?.timer) clearInterval(debate.timer);
  if (debate) debate.timer = null;
}
function pauseDebate() {
  if (!debate) return;
  if (debate.paused) {
    debate.endAt = Date.now() + debate.remain * 1000;
    debate.paused = false;
    $("debate-pause-btn").textContent = "⏸ 일시정지";
  } else {
    debate.remain = Math.max(0, Math.round((debate.endAt - Date.now()) / 1000));
    debate.paused = true;
    $("debate-pause-btn").textContent = "▶ 계속";
  }
  renderDebate();
}
function skipDebateStage() {
  if (!debate) return;
  if (debate.idx + 1 >= debate.stages.length) {
    stopDebate();
    $("debate-stage-label").textContent = "토론 종료 🎉";
    $("debate-timer").textContent = "0:00";
    $("debate-next").textContent = "수고하셨습니다";
    return;
  }
  debate.idx++;
  debate.endAt = Date.now() + debate.stages[debate.idx].sec * 1000;
  debate.paused = false;
  $("debate-pause-btn").textContent = "⏸ 일시정지";
  renderDebate();
}
function resetDebate() {
  stopDebate();
  debate = null;
  $("debate-run").classList.add("hidden");
  $("debate-setup").classList.remove("hidden");
}

// ---------- 초성 퀴즈 ----------
const CHOSUNG = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
function toChosung(word) {
  return [...word].map((ch) => {
    const c = ch.charCodeAt(0);
    return c >= 0xac00 && c <= 0xd7a3 ? CHOSUNG[Math.floor((c - 0xac00) / 588)] : ch;
  }).join("");
}
function parseWordList(id) {
  return [...new Set($(id).value.split(/[,\n]/).map((w) => w.trim()).filter(Boolean))];
}
let chosungPool = [], chosungSource = "", chosungCurrent = null;

// 퀴즈 목록 파싱: "문제 = 정답" 한 쌍 또는 단어만(→ 초성 문제로 자동 변환)
function parseQuizList() {
  const items = [];
  for (const line of $("chosung-words").value.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const sep = t.indexOf("=") !== -1 ? "=" : (t.indexOf("＝") !== -1 ? "＝" : null);
    if (sep) {
      const i = t.indexOf(sep);
      const q = t.slice(0, i).trim();
      const a = t.slice(i + 1).trim();
      if (q && a) items.push({ q, a, chosung: false });
    } else {
      // 쉼표로 여러 단어를 한 줄에 쓴 경우도 허용
      for (const w of t.split(",").map((x) => x.trim()).filter(Boolean)) {
        items.push({ q: toChosung(w), a: w, chosung: true });
      }
    }
  }
  return items;
}

function nextChosung() {
  const items = parseQuizList();
  if (!items.length) { toast("문제 목록을 먼저 입력해 주세요"); return; }
  const source = items.map((x) => x.q + "=" + x.a).join("|");
  if (source !== chosungSource || !chosungPool.length) {
    if (source === chosungSource) toast("한 바퀴 다 냈어요! 처음부터 다시 섞습니다 🔄");
    chosungSource = source;
    chosungPool = [...items];
    for (let i = chosungPool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [chosungPool[i], chosungPool[j]] = [chosungPool[j], chosungPool[i]];
    }
  }
  chosungCurrent = chosungPool.pop();
  const qClass = chosungCurrent.chosung ? "quiz-word" : "quiz-question";
  $("chosung-display").innerHTML = `<div class="${qClass}">${escapeHtml(chosungCurrent.q)}</div>`;
  $("chosung-remain").textContent = `남은 문제 ${chosungPool.length}개`;
}
function revealChosung() {
  if (!chosungCurrent) { toast("먼저 '문제 내기'를 눌러 주세요"); return; }
  const qClass = chosungCurrent.chosung ? "quiz-word chosung-dim" : "quiz-question chosung-dim";
  $("chosung-display").innerHTML =
    `<div class="${qClass}">${escapeHtml(chosungCurrent.q)}</div>` +
    `<div class="quiz-answer">${escapeHtml(chosungCurrent.a)}</div>`;
}

// ---------- 낱말 뽑기 ----------
let wordPool = [], wordSource = "";
function pickWord() {
  const words = parseWordList("word-list");
  if (!words.length) { toast("낱말 목록을 먼저 입력해 주세요"); return; }
  const source = words.join("|");
  if (source !== wordSource || !wordPool.length) {
    if (source === wordSource) toast("모두 뽑았어요! 처음부터 다시 섞습니다 🔄");
    wordSource = source;
    wordPool = [...words];
    for (let i = wordPool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [wordPool[i], wordPool[j]] = [wordPool[j], wordPool[i]];
    }
  }
  const w = wordPool.pop();
  $("word-display").innerHTML = `<div class="quiz-word">${escapeHtml(w)}</div>`;
  $("word-remain").textContent = `남은 낱말 ${wordPool.length}개`;
}

// ---------- 글자 수·원고지 ----------
function renderCharCount() {
  const text = $("count-text").value;
  const box = $("count-result");
  if (!text) { box.innerHTML = ""; return; }
  const withSpace = [...text.replace(/\r?\n/g, "")].length;
  const noSpace = [...text.replace(/\s/g, "")].length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const pages = Math.ceil(withSpace / 200) || 0;
  box.innerHTML = `
    <div class="count-row"><span>공백 포함</span><b>${withSpace.toLocaleString()}자</b></div>
    <div class="count-row"><span>공백 제외</span><b>${noSpace.toLocaleString()}자</b></div>
    <div class="count-row"><span>어절 수</span><b>${words.toLocaleString()}개</b></div>
    <div class="count-row"><span>원고지(200자)</span><b>약 ${pages}매</b></div>`;
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
    renderProgress();   // 새 학급이 진도표 목록에 반영되도록
    toast("시간표가 저장되었습니다");
  });

  // 수업진도표 (날짜 × 학급 매트릭스)
  $("progress-adddate-btn")?.addEventListener("click", addProgressDate);
  $("progress-export-btn")?.addEventListener("click", exportProgress);
  // 칸 편집 저장 (blur 시)
  $("progress-list")?.addEventListener("focusout", (e) => {
    const ta = e.target.closest(".progress-cell");
    if (!ta) return;
    const needReRender = saveProgressCell(ta.dataset.cls, ta.dataset.date, ta.dataset.pid, ta.value);
    if (needReRender) renderProgress();
  });
  // 입력 중 높이 자동 조절
  $("progress-list")?.addEventListener("input", (e) => {
    const ta = e.target.closest(".progress-cell");
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.max(34, ta.scrollHeight) + "px";
  });
  // Ctrl/Cmd+Enter로 저장(포커스 이탈)
  $("progress-list")?.addEventListener("keydown", (e) => {
    if (e.target.closest(".progress-cell") && (e.ctrlKey || e.metaKey) && e.key === "Enter") e.target.blur();
  });
  $("cancel-timetable-btn")?.addEventListener("click", () => {
    loadTimetable();   // 편집 중 변경 되돌리기
    $("timetable-editor").classList.add("hidden");
  });

  // 자리배치
  $("random-seating-btn")?.addEventListener("click", randomSeating);
  $("seating-grade")?.addEventListener("change", (e) => {
    state.seating.currentGrade = e.target.value;
    fillGradeClassSelects("seating-grade", "seating-class");   // 학년에 맞는 반 목록 갱신
    state.seating.currentClass = $("seating-class").value;
    seatPicked = null;
    saveSeating();
    renderSeating();
  });
  $("seating-class")?.addEventListener("change", (e) => {
    state.seating.currentClass = e.target.value;
    seatPicked = null;
    saveSeating();
    renderSeating();
  });
  $("seating-pair")?.addEventListener("change", (e) => {
    state.seating.pair = Number(e.target.value) === 2 ? 2 : 1;
    saveSeating();
    renderSeating();
  });
  $("seating-view")?.addEventListener("change", (e) => {
    state.seating.view = e.target.value === "student" ? "student" : "teacher";
    saveSeating();
    renderSeating();
  });
  $("print-seating-btn")?.addEventListener("click", printSeating);
  $("edit-seating-btn")?.addEventListener("click", () => {
    $("seating-rows").value = state.seating.rows;
    $("seating-cols").value = state.seating.cols;
    document.querySelector(".seating-config")?.classList.toggle("hidden");
  });
  $("create-seating-btn")?.addEventListener("click", () => {
    state.seating.rows = Math.min(Math.max(parseInt($("seating-rows").value) || 5, 1), 10);
    state.seating.cols = Math.min(Math.max(parseInt($("seating-cols").value) || 6, 1), 10);
    // 치수가 바뀌면 currentGrid()가 학급별로 새 격자를 만들므로 현재 학급만 비움
    delete state.seating.grids[seatKey()];
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

  // 학생 - 반 필터 칩
  $("student-class-filter")?.addEventListener("click", (e) => {
    const chip = e.target.closest(".class-chip");
    if (!chip) return;
    state.classFilter = chip.dataset.class;
    renderStudents();
  });

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
  // 테마 즉시 전환 + 저장
  $("setting-theme")?.addEventListener("change", (e) => {
    const t = e.target.value === "dark" ? "dark" : "light";
    localStorage.setItem(THEME_KEY, t);
    applyTheme(t);
  });
  // 연도별 취합
  $("agg-year")?.addEventListener("change", (e) => renderAggSummary(e.target.value));
  $("agg-export-btn")?.addEventListener("click", exportYearAggregate);
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

  // 도구 - 토론 타이머
  $("debate-start-btn")?.addEventListener("click", startDebate);
  $("debate-pause-btn")?.addEventListener("click", pauseDebate);
  $("debate-skip-btn")?.addEventListener("click", skipDebateStage);
  $("debate-reset-btn")?.addEventListener("click", resetDebate);

  // 도구 - 초성 퀴즈 / 낱말 뽑기 / 글자 수
  $("chosung-next-btn")?.addEventListener("click", nextChosung);
  $("chosung-reveal-btn")?.addEventListener("click", revealChosung);
  $("word-pick-btn")?.addEventListener("click", pickWord);
  $("count-text")?.addEventListener("input", renderCharCount);

  // 출결 관리
  $("att-grade")?.addEventListener("change", () => {
    fillGradeClassSelects("att-grade", "att-class");
    renderAttendance();
  });
  $("att-class")?.addEventListener("change", renderAttendance);
  $("att-date")?.addEventListener("change", (e) => {
    if (e.target.value) { attDate = e.target.value; renderAttendance(); }
  });
  $("att-prev")?.addEventListener("click", () => shiftAttDate(-1));
  $("att-next")?.addEventListener("click", () => shiftAttDate(1));
  $("att-today")?.addEventListener("click", () => { attDate = todayStr(); renderAttendance(); });
  // 상태 버튼 (이벤트 위임): 출석 / 유형(질병·인정·미인정) / 결과(지각·조퇴·결석)
  $("att-list")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".att-btn");
    if (!btn) return;
    const sid = btn.closest(".att-row")?.dataset.sid;
    if (!sid) return;
    const cur = { s: "출석", t: "", ...(attRecords()[sid] || {}) };

    if (btn.dataset.attOk) {
      setAttRecord(sid, { s: "출석", t: "" });               // 출석 = 유형·결과 모두 해제
    } else if (btn.dataset.attType) {
      const tp = btn.dataset.attType;
      setAttRecord(sid, { t: cur.t === tp ? "" : tp });      // 같은 유형 다시 누르면 해제
    } else if (btn.dataset.attRes) {
      const st = btn.dataset.attRes;
      setAttRecord(sid, { s: cur.s === st ? "출석" : st });  // 같은 결과 다시 누르면 출석으로
    }
    renderAttendance();
  });
  // 비고 입력 (렌더링하지 않고 저장만 — 입력 포커스 유지)
  $("att-list")?.addEventListener("change", (e) => {
    if (!e.target.classList.contains("att-note")) return;
    const sid = e.target.closest(".att-row")?.dataset.sid;
    if (sid) setAttRecord(sid, { n: e.target.value });
  });
  $("att-allpresent")?.addEventListener("click", () => {
    const key = attKey();
    if (!attendance[attDate]?.[key]) { toast("이미 전원 출석 상태입니다"); return; }
    if (!confirm("이 날짜의 기록(지각·조퇴·결석·비고)을 모두 지우고 전원 출석으로 되돌릴까요?")) return;
    delete attendance[attDate][key];
    if (!Object.keys(attendance[attDate]).length) delete attendance[attDate];
    saveAttendance();
    renderAttendance();
  });
  $("att-export-btn")?.addEventListener("click", exportAttendanceMonth);
  $("att-share-btn")?.addEventListener("click", toggleAttShare);

  // 학생관찰 기록
  $("obs-grade")?.addEventListener("change", () => {
    fillGradeClassSelects("obs-grade", "obs-class");
    renderObservations();
  });
  $("obs-class")?.addEventListener("change", renderObservations);
  $("obs-student")?.addEventListener("change", renderObservations);
  $("obs-add-btn")?.addEventListener("click", addObservation);
  $("obs-export-btn")?.addEventListener("click", exportObservations);
  $("obs-text")?.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") addObservation();
  });
  // 기록 삭제/수정 (이벤트 위임)
  $("obs-list")?.addEventListener("click", (e) => {
    const del = e.target.closest(".obs-del");
    if (!del) return;
    const sid = $("obs-student")?.value;
    if (sid && confirm("이 관찰 기록을 삭제할까요?")) removeObservation(sid, del.dataset.oid);
  });
  $("obs-list")?.addEventListener("change", (e) => {
    if (!e.target.classList.contains("obs-item-text")) return;
    const sid = $("obs-student")?.value;
    if (sid) updateObservation(sid, e.target.dataset.oid, e.target.value);
  });

  // 도구 - 발표자 뽑기 (학년 바꾸면 학급 목록도 갱신, 학급 바꾸면 기록 갱신)
  $("picker-btn")?.addEventListener("click", pickPresenter);
  $("picker-grade")?.addEventListener("change", () => {
    fillGradeClassSelects("picker-grade", "picker-class");
    renderPickerHistory();
  });
  $("picker-class")?.addEventListener("change", renderPickerHistory);
  $("picker-history")?.addEventListener("click", (e) => {
    if (e.target.closest("#picklog-export-btn")) exportPickLog();
    if (e.target.closest("#picklog-clear-btn")) clearPickLog();
  });

  // 도구 - 모둠 편성 (학년/학급 변경 시 명렬표 갱신, 모둠장 클릭 선택)
  $("group-grade")?.addEventListener("change", () => {
    fillGradeClassSelects("group-grade", "group-class");
    renderGroupRoster();
  });
  $("group-class")?.addEventListener("change", renderGroupRoster);
  $("group-roster")?.addEventListener("click", (e) => {
    const chip = e.target.closest(".roster-chip");
    if (!chip) return;
    const id = chip.dataset.sid;
    if (groupLeaderIds.has(id)) groupLeaderIds.delete(id);
    else groupLeaderIds.add(id);
    renderGroupRoster();
  });
  $("group-make-btn")?.addEventListener("click", makeGroups);
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
  loadPickLog();
  loadAttendance();
  loadAttShare();
  loadObservations();
  loadProgress();
  loadComci();   // 컴시간 시간표 데이터 백그라운드 로드 (대시보드 오늘 수업·진도표 학급)

  // 현재 교시 하이라이트를 1분마다 갱신
  setInterval(() => {
    if (state.activeView === "home") renderTodayTimetable();
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
  renderSeating();
  renderStudents();
  const startView = state.settings?.home || "home";   // 설정의 첫 화면
  setView(["home","timetable","seating","students","attendance","observe","calendar","memo","tools","settings"].includes(startView) ? startView : "home");
}

start();
