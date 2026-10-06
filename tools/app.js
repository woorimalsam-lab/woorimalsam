// ============================================================
//  수업 도구 모음 — 공개용 (서버 없음 / 모든 데이터는 이 브라우저에만 저장)
// ============================================================
"use strict";

const $ = (id) => document.getElementById(id);
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// 타이머·스톱워치가 쓰는 최소 상태
const state = {
  timerInterval: null,
  timerTime: 0,
  stopwatchInterval: null,
  stopwatchTime: 0,
};

// --- 로컬 저장 (localStorage 전용. 네트워크로 나가지 않는다) ---
function loadLocal(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveLocal(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); }
  catch { toast("저장 공간이 부족합니다"); }
}

let toastTimer = null;
function toast(msg, ms = 2200) {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const pad = (n) => String(n).padStart(2, "0");

const todayStr = () => ymd(new Date());

function uid() {
  return "id-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

let audioCtx = null;

function getAudioCtx() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();   // 클릭 시점에 잠금 해제
    return audioCtx;
  } catch { return null; }
}

function tone(ctx, at, freq, dur = 0.25, vol = 0.28) {
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.connect(gain); gain.connect(ctx.destination);
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, at);
  gain.gain.exponentialRampToValueAtTime(0.01, at + dur);
  osc.start(at); osc.stop(at + dur + 0.02);
}

let alarmInterval = null, alarmTimeout = null;

function playAlarm(bursts = 2) {
  const ctx = getAudioCtx();
  stopAlarm(true);
  if (ctx) {
    const burst = () => {
      const t = ctx.currentTime;
      tone(ctx, t, 880, 0.15);
      tone(ctx, t + 0.20, 1175, 0.15);
      tone(ctx, t + 0.40, 880, 0.22);
    };
    let n = 1;
    burst();
    alarmInterval = setInterval(() => {
      if (n >= bursts) { stopAlarm(); return; }   // 짧게 2번만 울리고 종료
      burst(); n++;
    }, 900);
    alarmTimeout = setTimeout(() => stopAlarm(), bursts * 900 + 400);
  }
  $("timer-alarm-stop")?.classList.remove("hidden");
  $("timer-display")?.classList.add("timer-ringing");
}

function stopAlarm(keepUI) {
  if (alarmInterval) { clearInterval(alarmInterval); alarmInterval = null; }
  if (alarmTimeout) { clearTimeout(alarmTimeout); alarmTimeout = null; }
  if (!keepUI) {
    $("timer-alarm-stop")?.classList.add("hidden");
    $("timer-display")?.classList.remove("timer-ringing");
  }
}

function beep(times = 2) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  for (let i = 0; i < times; i++) tone(ctx, ctx.currentTime + i * 0.4, 880, 0.3);
}

function startTimer() {
  if (state.timerInterval) return;
  stopAlarm();      // 이전 알람이 울리는 중이면 정리
  getAudioCtx();    // 클릭(사용자 제스처) 시점에 오디오 잠금 해제
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
      playAlarm();                       // 🔔 종료 알람
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
  stopAlarm();
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

let debate = null;   // { stages: [{name, sec}], idx, endAt, remain, timer, paused }

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

const CHOSUNG = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];

function toChosung(word) {
  return [...word].map((ch) => {
    const c = ch.charCodeAt(0);
    return c >= 0xac00 && c <= 0xd7a3 ? CHOSUNG[Math.floor((c - 0xac00) / 588)] : ch;
  }).join("");
}

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

let chosungPool = [], chosungSource = "", chosungCurrent = null;

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

function parseWordList(id) {
  return [...new Set($(id).value.split(/[,\n]/).map((w) => w.trim()).filter(Boolean))];
}

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

// 나이스(NEIS) 바이트 계산: 한글·한자 등 1자 3byte, 영문·숫자·기호·공백 1byte, 줄바꿈 2byte
function neisBytes(text) {
  let bytes = 0;
  for (const ch of String(text)) {
    if (ch === "\r") continue;
    if (ch === "\n") { bytes += 2; continue; }
    bytes += ch.charCodeAt(0) > 127 ? 3 : 1;
  }
  return bytes;
}
function countLimit() {
  const sel = $("count-limit")?.value ?? "1500";
  if (sel === "custom") return Math.max(0, Number($("count-limit-custom")?.value) || 0);
  return Math.max(0, Number(sel) || 0);
}
function renderCharCount() {
  const custom = $("count-limit-custom");
  if (custom) custom.classList.toggle("hidden", $("count-limit")?.value !== "custom");

  const text = $("count-text").value;
  const box = $("count-result");
  if (!text) { box.innerHTML = ""; return; }

  const withSpace = [...text.replace(/\r?\n/g, "")].length;
  const noSpace = [...text.replace(/\s/g, "")].length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const pages = Math.ceil(withSpace / 200) || 0;
  const bytes = neisBytes(text);
  const limit = countLimit();

  let head;
  if (limit) {
    const left = limit - bytes;
    const pct = Math.min(100, Math.round((bytes / limit) * 100));
    const over = left < 0;
    head = `
      <div class="count-row count-neis${over ? " is-over" : ""}">
        <span>나이스 바이트</span>
        <b>${bytes.toLocaleString()} / ${limit.toLocaleString()} byte</b>
      </div>
      <div class="count-bar"><span style="width:${pct}%" class="${over ? "is-over" : ""}"></span></div>
      <div class="count-row count-left${over ? " is-over" : ""}">
        <span>${over ? "초과" : "남은 분량"}</span>
        <b>${Math.abs(left).toLocaleString()} byte</b>
      </div>`;
  } else {
    head = `<div class="count-row count-neis"><span>나이스 바이트</span><b>${bytes.toLocaleString()} byte</b></div>`;
  }

  box.innerHTML = head + `
    <div class="count-row"><span>공백 포함</span><b>${withSpace.toLocaleString()}자</b></div>
    <div class="count-row"><span>공백 제외</span><b>${noSpace.toLocaleString()}자</b></div>
    <div class="count-row"><span>어절 수</span><b>${words.toLocaleString()}개</b></div>
    <div class="count-row"><span>원고지(200자)</span><b>약 ${pages}매</b></div>`;
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

const WHEEL_COLORS = ["#3b6ef5", "#1c9963", "#e08a1e", "#e5484d", "#8b5cf6", "#0d9488", "#d6409f", "#64748b"];

let wheelItems = [], wheelRotation = 0, wheelSpinning = false;

function polarXY(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
}

function drawWheel() {
  const svg = $("wheel-svg");
  if (!svg) return;
  wheelItems = parseWheelItems();
  const n = wheelItems.length;
  if (!n) { svg.innerHTML = '<text x="100" y="105" text-anchor="middle" fill="#9aa3b2" font-size="12">항목을 입력하세요</text>'; return; }
  const slice = 360 / n;
  let html = "";
  for (let i = 0; i < n; i++) {
    const a0 = i * slice, a1 = (i + 1) * slice;
    const [x0, y0] = polarXY(100, 100, 95, a0);
    const [x1, y1] = polarXY(100, 100, 95, a1);
    const large = slice > 180 ? 1 : 0;
    html += `<path d="M100 100 L${x0.toFixed(1)} ${y0.toFixed(1)} A95 95 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z" fill="${WHEEL_COLORS[i % WHEEL_COLORS.length]}"/>`;
    const [tx, ty] = polarXY(100, 100, 62, a0 + slice / 2);
    const label = wheelItems[i].length > 6 ? wheelItems[i].slice(0, 6) + "…" : wheelItems[i];
    html += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" fill="#fff" font-size="9" font-weight="700" transform="rotate(${(a0 + slice / 2).toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)})">${escapeHtml(label)}</text>`;
  }
  html += '<circle cx="100" cy="100" r="10" fill="#fff" stroke="#d9dde3"/>';
  svg.innerHTML = html;
  svg.style.transform = `rotate(${wheelRotation}deg)`;
}

function spinWheel() {
  if (wheelSpinning) return;
  const n = wheelItems.length;
  if (!n) { toast("항목을 입력하세요"); return; }
  const slice = 360 / n;
  const idx = Math.floor(Math.random() * n);
  const targetMod = (360 - (idx * slice + slice / 2)) % 360;
  const cur = ((wheelRotation % 360) + 360) % 360;
  wheelRotation += 360 * 6 + ((targetMod - cur + 360) % 360);
  const svg = $("wheel-svg");
  svg.style.transition = "transform 3.6s cubic-bezier(.17,.67,.2,1)";
  svg.style.transform = `rotate(${wheelRotation}deg)`;
  wheelSpinning = true;
  $("wheel-result").textContent = "";
  setTimeout(() => {
    wheelSpinning = false;
    $("wheel-result").innerHTML = `🎯 <b>${escapeHtml(wheelItems[idx])}</b>`;
    toast(`🎡 ${wheelItems[idx]}`);
  }, 3700);
}

let noiseCtx = null, noiseAnalyser = null, noiseStream = null, noiseRAF = null;

async function toggleNoise() {
  if (noiseStream) { stopNoise(); return; }
  try {
    noiseStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast("마이크 권한이 필요합니다"); return;
  }
  noiseCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = noiseCtx.createMediaStreamSource(noiseStream);
  noiseAnalyser = noiseCtx.createAnalyser();
  noiseAnalyser.fftSize = 512;
  src.connect(noiseAnalyser);
  $("noise-toggle").textContent = "측정 중지";
  const buf = new Uint8Array(noiseAnalyser.fftSize);
  const tick = () => {
    noiseAnalyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / buf.length);
    const level = Math.min(100, Math.round(rms * 300));
    const fill = $("noise-fill"), val = $("noise-val");
    if (fill) {
      fill.style.width = level + "%";
      fill.style.background = level < 33 ? "#1c9963" : level < 66 ? "#e08a1e" : "#e5484d";
    }
    if (val) val.textContent = level < 33 ? `조용해요 (${level})` : level < 66 ? `보통 (${level})` : `시끄러워요! (${level})`;
    noiseRAF = requestAnimationFrame(tick);
  };
  tick();
}

function stopNoise() {
  if (noiseRAF) cancelAnimationFrame(noiseRAF);
  if (noiseStream) noiseStream.getTracks().forEach((t) => t.stop());
  if (noiseCtx) noiseCtx.close();
  noiseStream = noiseCtx = noiseAnalyser = noiseRAF = null;
  const btn = $("noise-toggle"); if (btn) btn.textContent = "측정 시작";
  const fill = $("noise-fill"); if (fill) fill.style.width = "0%";
  const val = $("noise-val"); if (val) val.textContent = "–";
}

function tickClock() {
  const t = $("clock-time"), d = $("clock-date");
  if (!t) return;
  const now = new Date();
  t.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  if (d) {
    const wd = "일월화수목금토"[now.getDay()];
    d.textContent = `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 (${wd})`;
  }
}

function setSignal(color) {
  document.querySelectorAll(".signal-light").forEach((b) => b.classList.toggle("active", b.dataset.signal === color));
  const label = { green: "🟢 자유롭게 이야기해요", yellow: "🟡 속삭이며 이야기해요", red: "🔴 조용히 집중해요" }[color];
  const el = $("signal-label"); if (el) el.textContent = label;
}

let wbCtx = null, wbDrawing = false, wbErase = false;

function initWhiteboard() {
  const cv = $("wb-canvas");
  if (!cv || wbCtx) return;
  wbCtx = cv.getContext("2d");
  wbCtx.lineCap = "round"; wbCtx.lineJoin = "round";
  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: (p.clientX - r.left) * (cv.width / r.width), y: (p.clientY - r.top) * (cv.height / r.height) };
  };
  const start = (e) => { wbDrawing = true; const { x, y } = pos(e); wbCtx.beginPath(); wbCtx.moveTo(x, y); e.preventDefault(); };
  const move = (e) => {
    if (!wbDrawing) return;
    const { x, y } = pos(e);
    wbCtx.strokeStyle = wbErase ? "#ffffff" : $("wb-color").value;
    wbCtx.lineWidth = wbErase ? 24 : (parseInt($("wb-size").value) || 4);
    wbCtx.lineTo(x, y); wbCtx.stroke(); e.preventDefault();
  };
  const end = () => { wbDrawing = false; };
  cv.addEventListener("mousedown", start); cv.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);
  cv.addEventListener("touchstart", start, { passive: false });
  cv.addEventListener("touchmove", move, { passive: false });
  cv.addEventListener("touchend", end);
}

function clearWhiteboard() { const cv = $("wb-canvas"); if (wbCtx) wbCtx.clearRect(0, 0, cv.width, cv.height); }

function saveWhiteboard() {
  const cv = $("wb-canvas");
  // 흰 배경 깔아 저장
  const tmp = document.createElement("canvas"); tmp.width = cv.width; tmp.height = cv.height;
  const tc = tmp.getContext("2d"); tc.fillStyle = "#fff"; tc.fillRect(0, 0, tmp.width, tmp.height); tc.drawImage(cv, 0, 0);
  const a = document.createElement("a"); a.href = tmp.toDataURL("image/png"); a.download = `화이트보드_${todayStr()}.png`; a.click();
}

let recStream = null, recorder = null, recChunks = [], recBuffer = null;

function recSetStatus(msg) { const el = $("rec-status"); if (el) el.textContent = msg; }

function recSetInfo(msg) { const el = $("rec-info"); if (el) el.textContent = msg; }

function recUpdateButtons(ready) {
  const play = $("rec-play"), save = $("rec-save");
  if (play) play.disabled = !ready;
  if (save) save.disabled = !ready;
}

async function toggleRecord() {
  if (recorder && recorder.state === "recording") { stopRecord(); return; }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast("마이크 권한이 필요합니다"); recSetStatus("마이크 권한이 거부되었습니다"); return;
  }
  recChunks = [];
  try {
    recorder = new MediaRecorder(recStream);
  } catch (e) {
    toast("이 브라우저는 녹음을 지원하지 않습니다"); stopRecordStream(); return;
  }
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = async () => {
    stopRecordStream();
    try {
      const blob = new Blob(recChunks, { type: recorder.mimeType || "audio/webm" });
      const buf = await blob.arrayBuffer();
      const ctx = getAudioCtx();
      recBuffer = await ctx.decodeAudioData(buf);
      recUpdateButtons(true);
      recSetInfo(`녹음 완료 · ${recBuffer.duration.toFixed(1)}초 — 변조를 골라 재생해 보세요.`);
    } catch (e) {
      console.error("녹음 처리 실패", e);
      recSetInfo("녹음을 처리하지 못했습니다. 다시 시도해 주세요.");
    }
  };
  recorder.start();
  recStartAt = Date.now();
  $("rec-toggle").textContent = "■ 녹음 정지";
  $("rec-toggle").classList.add("btn-danger");
  recSetStatus("● 녹음 중… 0.0초");
  recTimer = setInterval(() => {
    const sec = (Date.now() - recStartAt) / 1000;
    recSetStatus(`● 녹음 중… ${sec.toFixed(1)}초`);
    if (sec >= 60) stopRecord();   // 최대 60초
  }, 100);
}

function stopRecord() {
  const wasRecording = !!(recorder && recorder.state === "recording");
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  if (wasRecording) recorder.stop();
  const btn = $("rec-toggle");
  if (btn) { btn.textContent = "● 녹음 시작"; btn.classList.remove("btn-danger"); }
  if (wasRecording) recSetStatus("녹음을 마쳤습니다");   // 녹음 중이 아니었으면 안내 문구 유지
}

function stopRecordStream() {
  if (recStream) { recStream.getTracks().forEach((t) => t.stop()); recStream = null; }
}

function buildVoiceGraph(ctx, buffer, effect) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  let node = src;
  if (effect === "high") src.playbackRate.value = 1.5;      // 다람쥐
  if (effect === "low") src.playbackRate.value = 0.72;      // 괴물
  if (effect === "robot") {                                  // 링 모듈레이션
    const rm = ctx.createGain();
    rm.gain.value = 0;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 50;
    osc.connect(rm.gain);
    node.connect(rm);
    node = rm;
    osc.start();
  }
  if (effect === "echo") {                                   // 동굴 에코
    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = 0.18;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const mix = ctx.createGain();
    node.connect(mix);
    node.connect(delay);
    delay.connect(fb); fb.connect(delay);
    delay.connect(mix);
    node = mix;
  }
  node.connect(ctx.destination);
  return src;
}

function currentEffect() { return $("rec-effect")?.value || "none"; }

function effectDuration(effect) {
  if (!recBuffer) return 0;
  const rate = effect === "high" ? 1.5 : effect === "low" ? 0.72 : 1;
  return recBuffer.duration / rate + (effect === "echo" ? 1.2 : 0.1);
}

function playRecording() {
  if (!recBuffer) return;
  const ctx = getAudioCtx();
  if (!ctx) { toast("이 브라우저에서 재생할 수 없습니다"); return; }
  if (recSource) { try { recSource.stop(); } catch (e) {} recSource = null; }
  recSource = buildVoiceGraph(ctx, recBuffer, currentEffect());
  recSource.start();
  recSetInfo("▶ 재생 중…");
  recSource.onended = () => recSetInfo(`녹음 ${recBuffer.duration.toFixed(1)}초 · 변조를 바꿔 다시 들어보세요.`);
}

function bufferToWav(buffer) {
  const numCh = buffer.numberOfChannels, len = buffer.length;
  const out = new ArrayBuffer(44 + len * numCh * 2);
  const view = new DataView(out);
  const ws = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  ws(0, "RIFF"); view.setUint32(4, 36 + len * numCh * 2, true); ws(8, "WAVE");
  ws(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * numCh * 2, true); view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  ws(36, "data"); view.setUint32(40, len * numCh * 2, true);
  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([out], { type: "audio/wav" });
}

async function saveRecording() {
  if (!recBuffer) return;
  const effect = currentEffect();
  try {
    const dur = effectDuration(effect);
    const off = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
      recBuffer.numberOfChannels, Math.ceil(dur * recBuffer.sampleRate), recBuffer.sampleRate);
    const src = buildVoiceGraph(off, recBuffer, effect);
    src.start();
    const rendered = await off.startRendering();
    const blob = bufferToWav(rendered);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `녹음_${effect === "none" ? "원본" : effect}_${todayStr()}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast("📥 음성 파일을 저장했습니다");
  } catch (e) {
    console.error("저장 실패", e);
    toast("저장에 실패했습니다");
  }
}

function stopVoiceTool() {
  stopLiveVoice();
  stopRecord();
  stopRecordStream();
  if (recSource) { try { recSource.stop(); } catch (e) {} recSource = null; }
}

const PITCH_BUF = 0.100, PITCH_FADE = 0.050, PITCH_DELAY = 0.100;

function makeFadeBuffer(ctx) {
  const len1 = Math.floor(PITCH_BUF * ctx.sampleRate);
  const len2 = Math.floor((PITCH_BUF - 2 * PITCH_FADE) * ctx.sampleRate);
  const buf = ctx.createBuffer(1, len1 + len2, ctx.sampleRate);
  const p = buf.getChannelData(0);
  const fade = PITCH_FADE * ctx.sampleRate, upTo = len1 - fade;
  for (let i = 0; i < len1; i++) {
    p[i] = i < fade ? Math.sqrt(i / fade) : (i >= upTo ? Math.sqrt(1 - (i - upTo) / fade) : 1);
  }
  return buf;
}

function makeDelayBuffer(ctx, shiftUp) {
  const len1 = Math.floor(PITCH_BUF * ctx.sampleRate);
  const len2 = Math.floor((PITCH_BUF - 2 * PITCH_FADE) * ctx.sampleRate);
  const buf = ctx.createBuffer(1, len1 + len2, ctx.sampleRate);
  const p = buf.getChannelData(0);
  for (let i = 0; i < len1; i++) p[i] = shiftUp ? (len1 - i) / (len1 + len2) : i / len1;
  return buf;
}

function createPitchShifter(ctx, mult) {
  const input = ctx.createGain(), output = ctx.createGain();
  const delay1 = ctx.createDelay(), delay2 = ctx.createDelay();
  const mix1 = ctx.createGain(), mix2 = ctx.createGain();
  mix1.gain.value = 0; mix2.gain.value = 0;

  const up = mult > 0;
  const dBuf = makeDelayBuffer(ctx, up), fBuf = makeFadeBuffer(ctx);
  const mod1 = ctx.createBufferSource(), mod2 = ctx.createBufferSource();
  const fade1 = ctx.createBufferSource(), fade2 = ctx.createBufferSource();
  [mod1, mod2].forEach((m) => { m.buffer = dBuf; m.loop = true; });
  [fade1, fade2].forEach((f) => { f.buffer = fBuf; f.loop = true; });

  const modGain1 = ctx.createGain(), modGain2 = ctx.createGain();
  const amt = 0.5 * PITCH_DELAY * Math.min(1, Math.abs(mult));
  modGain1.gain.value = amt; modGain2.gain.value = amt;
  mod1.connect(modGain1); mod2.connect(modGain2);
  modGain1.connect(delay1.delayTime); modGain2.connect(delay2.delayTime);
  fade1.connect(mix1.gain); fade2.connect(mix2.gain);

  input.connect(delay1); input.connect(delay2);
  delay1.connect(mix1); delay2.connect(mix2);
  mix1.connect(output); mix2.connect(output);

  const t = ctx.currentTime + 0.05, t2 = t + PITCH_BUF - PITCH_FADE;
  mod1.start(t); fade1.start(t); mod2.start(t2); fade2.start(t2);
  return { input, output, _srcs: [mod1, mod2, fade1, fade2] };
}

let liveStream = null, liveSource = null, liveOut = null, liveChain = [];

function liveSetStatus(msg) { const el = $("live-status"); if (el) el.textContent = msg; }

function liveRunning() { return !!liveStream; }

function rebuildLiveChain() {
  if (!liveSource || !liveOut) return;
  const ctx = getAudioCtx();
  try { liveSource.disconnect(); } catch (e) {}
  liveChain.forEach((n) => { try { n.disconnect(); } catch (e) {} (n._srcs || []).forEach((s) => { try { s.stop(); } catch (e) {} }); });
  liveChain = [];

  const effect = $("live-effect")?.value || "none";
  let node = liveSource;
  if (effect === "high" || effect === "low") {
    const ps = createPitchShifter(ctx, effect === "high" ? 1.0 : -0.85);   // 다람쥐 / 괴물
    node.connect(ps.input); node = ps.output; liveChain.push(ps.input, ps.output, ps);
  } else if (effect === "robot") {
    const rm = ctx.createGain(); rm.gain.value = 0;
    const osc = ctx.createOscillator(); osc.type = "sine"; osc.frequency.value = 50;
    osc.connect(rm.gain); node.connect(rm); node = rm; osc.start();
    liveChain.push(rm, { disconnect() {}, _srcs: [osc] });
  } else if (effect === "echo") {
    const d = ctx.createDelay(1.0); d.delayTime.value = 0.18;
    const fb = ctx.createGain(); fb.gain.value = 0.35;
    const mix = ctx.createGain();
    node.connect(mix); node.connect(d); d.connect(fb); fb.connect(d); d.connect(mix);
    node = mix; liveChain.push(d, fb, mix);
  }
  node.connect(liveOut);
}

async function fillMicList() {
  const sel = $("live-mic");
  if (!sel || !navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const mics = devs.filter((d) => d.kind === "audioinput");
    const prev = sel.value;
    sel.innerHTML = '<option value="">기본 마이크</option>' +
      mics.map((m, i) => `<option value="${m.deviceId}">${escapeHtml(m.label || "마이크 " + (i + 1))}</option>`).join("");
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  } catch (e) { /* 목록 조회 실패는 무시 */ }
}

async function startLiveVoice() {
  const ctx = getAudioCtx();
  if (!ctx) { toast("이 브라우저에서는 사용할 수 없습니다"); return; }
  const deviceId = $("live-mic")?.value;
  const audio = {
    echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
  try {
    liveStream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch (e) {
    liveStream = null;
    toast("마이크 권한이 필요합니다");
    liveSetStatus("마이크를 사용할 수 없습니다 (권한 또는 장치 확인)");
    return;
  }
  await fillMicList();
  liveSource = ctx.createMediaStreamSource(liveStream);
  liveOut = ctx.createGain();
  liveOut.gain.value = (parseInt($("live-volume")?.value) || 70) / 100;
  liveOut.connect(ctx.destination);
  rebuildLiveChain();
  const btn = $("live-toggle");
  if (btn) { btn.textContent = "■ 정지"; btn.classList.add("btn-danger"); }
  const label = $("live-mic")?.selectedOptions?.[0]?.textContent || "기본 마이크";
  liveSetStatus(`🎤 변조 중 — ${label}`);
}

function stopLiveVoice() {
  if (!liveStream && !liveSource) return;   // 실행 중이 아니면 안내 문구 유지
  liveChain.forEach((n) => { try { n.disconnect(); } catch (e) {} (n._srcs || []).forEach((s) => { try { s.stop(); } catch (e) {} }); });
  liveChain = [];
  if (liveSource) { try { liveSource.disconnect(); } catch (e) {} liveSource = null; }
  if (liveOut) { try { liveOut.disconnect(); } catch (e) {} liveOut = null; }
  if (liveStream) { liveStream.getTracks().forEach((t) => t.stop()); liveStream = null; }
  const btn = $("live-toggle");
  if (btn) { btn.textContent = "🎤 시작"; btn.classList.remove("btn-danger"); }
  liveSetStatus("정지했습니다. 시작하면 마이크 소리가 변조되어 나옵니다.");
}

function toggleLiveVoice() { liveRunning() ? stopLiveVoice() : startLiveVoice(); }
// ============================================================
//  공용 명단 — 이름 뽑기 · 모둠 편성 · 자리 배치 · 돌림판이 함께 쓴다
//  저장 위치: 이 브라우저의 localStorage (서버 전송 없음)
// ============================================================
const LK_ROSTER    = "classtools.roster";
const LK_GROUPSETS = "classtools.groupsets";
const LK_SEATING   = "classtools.seating";
const LK_UPLOAD    = "classtools.roster.upload";

// ---- 명단 모델 -------------------------------------------------
// 업로드한 명렬표는 {id,name,grade,class,number} 배열로, 직접 입력은 텍스트로 보관한다.
// 둘 중 마지막에 쓴 쪽이 이긴다.
let uploaded = [];   // [{id, name, grade, class, number}]

function rosterNames() {
  const raw = $("roster")?.value || "";
  return [...new Set(raw.split(/[,\n\t]/).map((s) => s.trim()).filter(Boolean))];
}
// 명단 전체 (업로드 우선)
function allStudents() {
  if (uploaded.length) return uploaded;
  return rosterNames().map((entry, i) => {
    const m = /^(\d{1,3})\s*번?[.\s]\s*(.+)$/.exec(entry);   // "3 김하늘" / "3번 김하늘" / "3. 김하늘"
    return m
      ? { id: "r" + i, name: m[2].trim(), number: m[1], grade: "", class: "" }
      : { id: "r" + i, name: entry, number: "", grade: "", class: "" };
  });
}
function hasClasses() {
  return uploaded.some((s) => s.grade || s.class);
}
// 지금 선택된 학급의 학생 (학급 구분이 없으면 전체) — 모든 도구가 이걸 쓴다
function activeStudents() {
  const pool = allStudents();
  if (!hasClasses()) return pool;
  const g = $("roster-grade")?.value ?? "", c = $("roster-class")?.value ?? "";
  return pool
    .filter((s) => (s.grade || "") === g && (s.class || "") === c)
    .sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
}
// 이름만 (번호가 있으면 "3 김하늘" 꼴)
function activeNames() {
  return activeStudents().map((s) => (s.number ? `${s.number} ${s.name}` : s.name));
}

function fillClassSelects() {
  const wrap = $("roster-class-wrap"), gSel = $("roster-grade"), cSel = $("roster-class");
  if (!wrap || !gSel || !cSel) return;
  if (!hasClasses()) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");

  const pool = allStudents();
  const grades = [...new Set(pool.map((s) => s.grade || ""))]
    .sort((a, b) => (Number(a) || 99) - (Number(b) || 99));
  const prevG = gSel.value;
  gSel.innerHTML = grades.map((g) => `<option value="${g}">${g ? g + "학년" : "학년 미지정"}</option>`).join("");
  if (grades.includes(prevG)) gSel.value = prevG;

  const classes = [...new Set(pool.filter((s) => (s.grade || "") === gSel.value).map((s) => s.class || ""))]
    .sort((a, b) => (Number(a) || 99) - (Number(b) || 99));
  const prevC = cSel.value;
  cSel.innerHTML = classes.map((c) => `<option value="${c}">${c ? c + "반" : "반 미지정"}</option>`).join("");
  if (classes.includes(prevC)) cSel.value = prevC;
}

function renderRosterCount() {
  const el = $("roster-count");
  if (!el) return;
  const total = allStudents().length;
  if (!total) { el.textContent = ""; return; }
  if (!hasClasses()) { el.textContent = `${total}명`; return; }
  el.textContent = `${activeStudents().length}명 / 전체 ${total}명`;
}
// 명단이 바뀌면 이걸 부른다
function refreshRoster() {
  fillClassSelects();
  renderRosterCount();
  renderGroupResultReset();
  drawWheel();
  pickPool = []; pickSource = "";
}
function renderGroupResultReset() {
  const el = $("group-result");
  if (el && !lastGroups) el.innerHTML = "";
}

function uploadSummary() {
  const byClass = new Map();
  for (const s of uploaded) {
    const key = `${s.grade || ""}|${s.class || ""}`;
    byClass.set(key, (byClass.get(key) || 0) + 1);
  }
  return [...byClass.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "ko", { numeric: true }))
    .map(([key, n]) => {
      const [g, c] = key.split("|");
      const label = `${g ? g + "학년 " : ""}${c ? c + "반" : ""}`.trim();
      return `${label || "반 미지정"} ${n}명`;
    })
    .join(" · ");
}

function loadRoster() {
  const saved = loadLocal(LK_ROSTER);
  if (typeof saved === "string" && $("roster")) $("roster").value = saved;
  const u = loadLocal(LK_UPLOAD);
  uploaded = Array.isArray(u) ? u.filter((s) => s && s.name) : [];
  if (uploaded.length) rosterStatus(`📋 올린 명단: ${uploadSummary()}`);
  refreshRoster();
}
function saveRosterText() {
  saveLocal(LK_ROSTER, $("roster")?.value || "");
}
let rosterTimer = null;
function onRosterInput() {
  // 직접 입력을 시작하면 업로드한 명단은 물러난다
  if (uploaded.length && ($("roster")?.value || "").trim()) {
    uploaded = [];
    saveLocal(LK_UPLOAD, []);
    rosterStatus("직접 입력한 명단을 사용합니다");
  }
  renderRosterCount();
  clearTimeout(rosterTimer);
  rosterTimer = setTimeout(() => { saveRosterText(); refreshRoster(); }, 600);
}
function clearRoster() {
  if (!confirm("명단을 지울까요?")) return;
  $("roster").value = "";
  saveLocal(LK_ROSTER, "");
  uploaded = [];
  saveLocal(LK_UPLOAD, []);
  rosterStatus("");
  refreshRoster();
}
function fillNumbers() {
  const n = Number(prompt("몇 번까지 채울까요?", "30"));
  if (!n || n < 1 || n > 60) return;
  uploaded = [];
  saveLocal(LK_UPLOAD, []);
  $("roster").value = Array.from({ length: n }, (_, i) => `${i + 1}번`).join(", ");
  saveRosterText();
  rosterStatus("");
  refreshRoster();
}
function rosterStatus(msg, bad) {
  const el = $("roster-status");
  if (!el) { if (msg) toast(msg); return; }
  el.textContent = msg;
  el.classList.toggle("is-error", !!bad);
}

// ---- 명렬표 파일 읽기 -------------------------------------------
// SheetJS는 .xlsx를 올릴 때만 내려받는다 (안 올리면 외부 요청이 아예 없다)
const XLSX_SOURCES = [
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.min.js",
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
];
function ensureXLSX() {
  if (typeof XLSX !== "undefined") return Promise.resolve();
  const tryOne = (i) => new Promise((resolve, reject) => {
    if (i >= XLSX_SOURCES.length) { reject(new Error("엑셀 라이브러리를 불러오지 못했습니다. .csv로 저장해 올려 주세요.")); return; }
    const sc = document.createElement("script");
    sc.src = XLSX_SOURCES[i];
    sc.onload = () => resolve();
    sc.onerror = () => { sc.remove(); tryOne(i + 1).then(resolve, reject); };
    document.head.appendChild(sc);
  });
  return tryOne(0);
}
function cellStr(v) {
  if (v == null) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v).replace(/\.0+$/, "");
  return String(v).trim();
}
// 명렬표 행들을 훑어 학생 목록을 뽑는다 (본앱 parseNEISData와 같은 규칙)
function scanRosterRows(data) {
  if (!Array.isArray(data) || !data.length) return { ok: false, list: [], msg: "파일이 비어있습니다" };

  let headerRow = -1, classIdx = -1, numberIdx = -1, nameIdx = -1, gradeIdx = -1;
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
    if (nmI !== -1) { headerRow = r; classIdx = cI; numberIdx = nI; nameIdx = nmI; gradeIdx = gI; break; }
  }

  let fallbackClass = "", fallbackGrade = "";
  const titleScan = headerRow > 0 ? headerRow : Math.min(data.length, 10);
  for (let r = 0; r < titleScan; r++) {
    const joined = (data[r] || []).map((v) => String(v ?? "")).join(" ");
    const m = /(\d{1,2})\s*학년\s*(\d{1,2})\s*반/.exec(joined) || /(\d{1,2})\s*-\s*(\d{1,2})/.exec(joined);
    if (m) { fallbackGrade = m[1]; fallbackClass = m[2]; break; }
  }

  const list = [];
  const add = (name, klass, number, grade) => {
    name = (name || "").trim();
    if (!name || /^\d+$/.test(name)) return;
    list.push({
      name,
      class: (klass || "").replace(/반$/, ""),
      number: (number || "").replace(/번$/, ""),
      grade: (grade || "").replace(/학년$/, ""),
    });
  };

  // 사진명렬표 형식: "1번 강건" 같은 셀이 흩어져 있음
  if (headerRow === -1) {
    const found = [];
    for (const row of data) {
      for (const cell of row || []) {
        const m = /^(\d{1,3})\s*번\s*(.+)$/.exec(String(cell ?? "").trim());
        if (m && m[2].trim() && !/^\d+$/.test(m[2].trim())) found.push({ number: m[1], name: m[2].trim() });
      }
    }
    if (found.length >= 3) {
      for (const f of found) add(f.name, fallbackClass, f.number, fallbackGrade);
      return { ok: true, list, msg: "" };
    }
  }

  for (let i = headerRow + 1; i < data.length; i++) {
    const row = (data[i] || []).map(cellStr);
    if (!row.some(Boolean)) continue;
    let name, klass, number, grade;
    if (nameIdx !== -1) {
      name = row[nameIdx] || "";
      klass = (classIdx !== -1 ? row[classIdx] : "") || fallbackClass;
      number = numberIdx !== -1 ? row[numberIdx] : "";
      grade = (gradeIdx !== -1 ? row[gradeIdx] : "") || fallbackGrade;
    } else {
      const vals = row.filter(Boolean);
      if (vals.length >= 3) [klass, number, name] = vals;
      else if (vals.length === 2) { [number, name] = vals; klass = fallbackClass; }
      else { name = vals[0] || ""; klass = fallbackClass; number = ""; }
      grade = fallbackGrade;
    }
    add(name, klass, number, grade);
  }

  return list.length
    ? { ok: true, list, msg: "" }
    : { ok: false, list, msg: "학생 데이터를 찾지 못했습니다. 파일 형식을 확인해 주세요." };
}

async function readRosterFile(file) {
  const lower = file.name.toLowerCase();
  const isExcel = lower.endsWith(".xlsx") || lower.endsWith(".xls");
  if (isExcel) await ensureXLSX();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("파일을 읽지 못했습니다"));
    reader.onload = (e) => {
      try {
        if (isExcel) {
          const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          resolve(XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }));
        } else {
          const lines = String(e.target.result).split(/\r?\n/).filter((l) => l.trim());
          resolve(lines.map((l) => l.split(",")));
        }
      } catch (err) { reject(err); }
    };
    if (isExcel) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  });
}

async function uploadRoster(file) {
  if (!file) return;
  rosterStatus("파일을 읽는 중…");
  try {
    const rows = await readRosterFile(file);
    const scan = scanRosterRows(rows);
    if (!scan.ok) { rosterStatus(scan.msg, true); return; }

    const seen = new Set();
    const list = [];
    for (const s of scan.list) {
      const key = `${s.grade}|${s.class}|${s.number}|${s.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ id: "u" + list.length, name: s.name, grade: s.grade || "", class: s.class || "", number: s.number || "" });
    }

    const had = allStudents().length;
    if (had && !confirm(`현재 명단 ${had}명을 새로 읽은 ${list.length}명으로 바꿀까요?`)) {
      rosterStatus("취소했습니다 — 명단은 그대로입니다");
      return;
    }
    uploaded = list;
    saveLocal(LK_UPLOAD, uploaded);
    $("roster").value = "";
    saveLocal(LK_ROSTER, "");
    lastGroups = null;
    refreshRoster();
    rosterStatus(`✅ ${list.length}명을 불러왔습니다 — ${uploadSummary()} · 이 기기에만 저장됩니다`);
  } catch (e) {
    console.error(e);
    rosterStatus(e?.message || "파일을 읽지 못했습니다. .xlsx 또는 .csv인지 확인해 주세요.", true);
  } finally {
    const input = $("roster-file");
    if (input) input.value = "";
  }
}

// ============================================================
//  이름 뽑기
// ============================================================
let pickPool = [], pickSource = "", pickHistory = [];

function pickName() {
  const names = activeNames();
  if (!names.length) { toast("먼저 위쪽 명단을 올리거나 입력해 주세요"); return; }
  const noRepeat = $("picker-norepeat")?.checked;
  let name;
  if (noRepeat) {
    const source = names.join("|");
    if (source !== pickSource || !pickPool.length) {
      if (source === pickSource) toast("모두 뽑았어요! 처음부터 다시 섞습니다 🔄");
      pickSource = source;
      pickPool = shuffled(names);
    }
    name = pickPool.pop();
  } else {
    name = names[Math.floor(Math.random() * names.length)];
  }
  $("picker-result").innerHTML = `<div class="picker-name">${escapeHtml(name)}</div>`;
  pickHistory.unshift(name);
  if (pickHistory.length > 30) pickHistory.pop();
  renderPickHistory();
  beep(1);
}
function renderPickHistory() {
  const el = $("picker-history");
  if (!el) return;
  if (!pickHistory.length) { el.innerHTML = ""; return; }
  const tail = $("picker-norepeat")?.checked ? ` · 남은 사람 ${pickPool.length}명` : "";
  el.innerHTML =
    `<div class="picker-history-head muted">뽑은 순서${tail}</div>` +
    `<ol class="picker-history-list" reversed>${
      pickHistory.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ol>`;
}
function resetPicker() {
  pickPool = []; pickSource = ""; pickHistory = [];
  $("picker-result").textContent = "위 명단에서 무작위로 뽑아요";
  renderPickHistory();
  toast("기록을 지웠습니다");
}

// ============================================================
//  모둠 편성
// ============================================================
let groupSets = [], lastGroups = null;

function makeGroups() {
  const names = activeNames();
  if (names.length < 2) { toast("이 학급에 2명 이상 있어야 모둠을 짤 수 있습니다"); return; }
  const count = Math.max(2, Math.min(12, Number($("group-count")?.value) || 4));
  if (count > names.length) { toast(`모둠 수(${count})가 인원(${names.length}명)보다 많습니다`); return; }
  const pool = shuffled(names);
  const groups = Array.from({ length: count }, () => []);
  pool.forEach((n, i) => groups[i % count].push(n));
  lastGroups = groups;
  $("group-save-btn").disabled = false;
  renderGroupResult(groups, `🔀 ${names.length}명 → ${count}모둠`);
}
function renderGroupResult(groups, caption) {
  const el = $("group-result");
  if (!el) return;
  el.innerHTML =
    `<div class="group-caption muted">${escapeHtml(caption)}</div>` +
    groups.map((g, i) =>
      `<div class="group-box"><div class="group-box-head">${i + 1}모둠 (${g.length}명)</div>` +
      g.map((n) => `<div class="group-member">${escapeHtml(n)}</div>`).join("") +
      "</div>"
    ).join("");
}
function loadGroupSets() {
  const s = loadLocal(LK_GROUPSETS);
  groupSets = Array.isArray(s) ? s : [];
  renderGroupSetSelect();
}
function saveGroupSets() { saveLocal(LK_GROUPSETS, groupSets); renderGroupSetSelect(); }
function renderGroupSetSelect() {
  const sel = $("group-saved");
  if (!sel) return;
  if (!groupSets.length) { sel.innerHTML = '<option value="">저장된 모둠 없음</option>'; return; }
  sel.innerHTML = groupSets
    .map((s) => `<option value="${s.id}">${escapeHtml(s.name)} (${s.date})</option>`)
    .join("");
}
function saveCurrentGroups() {
  if (!lastGroups) { toast("먼저 모둠을 짜 주세요"); return; }
  const name = (prompt("저장할 이름", `모둠 ${groupSets.length + 1}`) || "").trim();
  if (!name) return;
  groupSets.unshift({ id: uid(), name, date: todayStr(), groups: lastGroups });
  if (groupSets.length > 40) groupSets.pop();
  saveGroupSets();
  toast(`💾 '${name}' 저장 (이 기기에만)`);
}
function loadGroupSet() {
  const id = $("group-saved")?.value;
  const set = groupSets.find((s) => s.id === id);
  if (!set) { toast("저장된 모둠이 없습니다"); return; }
  lastGroups = set.groups;
  $("group-save-btn").disabled = false;
  renderGroupResult(set.groups, `📂 ${set.name} · ${set.date}`);
}
function deleteGroupSet() {
  const id = $("group-saved")?.value;
  const set = groupSets.find((s) => s.id === id);
  if (!set) { toast("저장된 모둠이 없습니다"); return; }
  if (!confirm(`'${set.name}'을 삭제할까요?`)) return;
  groupSets = groupSets.filter((s) => s.id !== id);
  saveGroupSets();
  toast("삭제했습니다");
}

// ============================================================
//  자리 배치
//  저장 구조: { rows, cols, pair, view, grid: [[이름|null, ...], ...] }
// ============================================================
let seating = { rows: 5, cols: 6, pair: 2, view: "teacher", grid: null };
let seatPicked = null;

function emptyGrid(rows, cols) {
  return Array(rows).fill(null).map(() => Array(cols).fill(null));
}
function loadSeating() {
  const s = loadLocal(LK_SEATING);
  if (s && s.rows && s.cols) {
    seating = {
      rows: s.rows, cols: s.cols,
      pair: s.pair === 1 ? 1 : 2,
      view: s.view === "student" ? "student" : "teacher",
      grid: Array.isArray(s.grid) ? s.grid : null,
    };
  }
  if ($("seating-rows")) $("seating-rows").value = seating.rows;
  if ($("seating-cols")) $("seating-cols").value = seating.cols;
  if ($("seating-pair")) $("seating-pair").value = String(seating.pair);
  if ($("seating-view")) $("seating-view").value = seating.view;
}
function saveSeating() { saveLocal(LK_SEATING, seating); }
function currentGrid() {
  const { rows, cols } = seating;
  let g = seating.grid;
  if (!Array.isArray(g) || g.length !== rows || (g[0] || []).length !== cols) {
    g = emptyGrid(rows, cols);
    seating.grid = g;
  }
  return g;
}
function readSeatingOpts() {
  seating.rows = Math.max(1, Math.min(12, Number($("seating-rows")?.value) || 5));
  seating.cols = Math.max(1, Math.min(12, Number($("seating-cols")?.value) || 6));
  seating.pair = $("seating-pair")?.value === "1" ? 1 : 2;
  seating.view = $("seating-view")?.value === "student" ? "student" : "teacher";
}
function renderSeating() {
  const display = $("seating-display");
  if (!display) return;
  const { rows, cols, pair, view } = seating;
  const grid = currentGrid();
  const teacher = view === "teacher";

  // 교탁에서 본 배치 = 좌우·상하 반전 (교탁이 그림 아래쪽에 오도록)
  const colOrder = [], rowOrder = [];
  for (let c = 0; c < cols; c++) colOrder.push(teacher ? cols - 1 - c : c);
  for (let r = 0; r < rows; r++) rowOrder.push(teacher ? rows - 1 - r : r);

  const template = [];
  colOrder.forEach((_, i) => {
    template.push("1fr");
    if ((i + 1) % pair === 0 && i !== cols - 1) template.push("18px");
  });

  const seated = grid.flat().filter(Boolean).length;
  const cnt = $("seating-count");
  if (cnt) cnt.textContent = seated ? `${seated}명 배치됨` : "";

  let html = '<div class="seating-print-title">좌석표</div>';
  if (!teacher) html += '<div class="seating-board">칠판 · 교탁</div>';
  html += `<div class="seating-grid" style="grid-template-columns: ${template.join(" ")}">`;
  for (const r of rowOrder) {
    colOrder.forEach((c, i) => {
      const seat = grid[r]?.[c];
      const sel = seatPicked && seatPicked.r === r && seatPicked.c === c;
      html += `<div class="seating-seat${seat ? "" : " empty"}${sel ? " selected" : ""}" data-row="${r}" data-col="${c}">${seat ? escapeHtml(seat) : "－"}</div>`;
      if ((i + 1) % pair === 0 && i !== cols - 1) html += '<div class="seat-spacer"></div>';
    });
  }
  html += "</div>";
  if (teacher) html += '<div class="seating-board bottom">교탁 (칠판)</div>';
  html += '<p class="seating-hint muted">좌석을 하나 누른 뒤 다른 좌석을 누르면 서로 자리가 바뀝니다.</p>';
  display.innerHTML = html;
}
function randomSeating() {
  readSeatingOpts();
  const pool = activeNames();
  if (!pool.length) { toast("먼저 위쪽 명단을 올리거나 입력해 주세요"); return; }
  const seats = seating.rows * seating.cols;
  if (pool.length > seats) {
    toast(`좌석(${seats}석)보다 인원(${pool.length}명)이 많습니다. 행·열을 늘려 주세요.`, 5000);
    return;
  }
  const list = shuffled(pool);
  const g = emptyGrid(seating.rows, seating.cols);
  let idx = 0;
  for (let r = 0; r < seating.rows && idx < list.length; r++) {
    for (let c = 0; c < seating.cols && idx < list.length; c++) g[r][c] = list[idx++];
  }
  seating.grid = g;
  seatPicked = null;
  saveSeating();
  renderSeating();
  toast(`🔀 ${list.length}명 자리배치 완료`);
}
function onSeatClick(r, c) {
  if (!seatPicked) {
    seatPicked = { r, c };
  } else if (seatPicked.r === r && seatPicked.c === c) {
    seatPicked = null;
  } else {
    const g = currentGrid();
    [g[seatPicked.r][seatPicked.c], g[r][c]] = [g[r][c], g[seatPicked.r][seatPicked.c]];
    seatPicked = null;
    saveSeating();
  }
  renderSeating();
}
function printSeating() {
  if (!currentGrid().flat().some(Boolean)) { toast("먼저 자리배치를 만들어 주세요"); return; }
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

// ============================================================
//  돌림판 항목 — 직접 입력이 비어 있으면 공용 명단을 쓴다
// ============================================================
function parseWheelItems() {
  const raw = ($("wheel-items")?.value || "").trim();
  if (raw) return [...new Set(raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))].slice(0, 24);
  return activeNames().slice(0, 24);
}

// ============================================================
//  다크 모드
// ============================================================
const LK_THEME = "classtools.theme";
function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  const btn = $("theme-btn");
  if (btn) btn.textContent = mode === "dark" ? "☀️" : "🌙";
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.setItem(LK_THEME, next); } catch {}
  applyTheme(next);
}

// ============================================================
//  이벤트 연결
// ============================================================
function on(id, ev, fn) { const el = $(id); if (el) el.addEventListener(ev, fn); }

function bindAll() {
  // 명단
  on("roster", "input", onRosterInput);
  on("roster-upload", "click", () => $("roster-file")?.click());
  on("roster-file", "change", (e) => uploadRoster(e.target.files?.[0]));
  on("roster-clear", "click", clearRoster);
  on("roster-numbers", "click", fillNumbers);
  on("roster-grade", "change", () => { fillClassSelects(); lastGroups = null; refreshRoster(); });
  on("roster-class", "change", () => { lastGroups = null; refreshRoster(); });

  // 타이머 · 스톱워치
  on("timer-start-btn", "click", startTimer);
  on("timer-stop-btn", "click", stopTimer);
  on("timer-reset-btn", "click", resetTimer);
  on("timer-alarm-stop", "click", () => stopAlarm());
  document.querySelectorAll("[data-timer]").forEach((b) =>
    b.addEventListener("click", () => { $("timer-input").value = b.dataset.timer; startTimer(); }));
  on("stopwatch-start-btn", "click", startStopwatch);
  on("stopwatch-stop-btn", "click", stopStopwatch);
  on("stopwatch-reset-btn", "click", resetStopwatch);

  // 이름 뽑기
  on("picker-btn", "click", pickName);
  on("picker-reset", "click", resetPicker);

  // 모둠
  on("group-make-btn", "click", makeGroups);
  on("group-save-btn", "click", saveCurrentGroups);
  on("group-load-btn", "click", loadGroupSet);
  on("group-del-btn", "click", deleteGroupSet);

  // 자리 배치
  on("seating-random", "click", randomSeating);
  on("seating-print", "click", printSeating);
  ["seating-rows", "seating-cols", "seating-pair", "seating-view"].forEach((id) =>
    on(id, "change", () => { readSeatingOpts(); seatPicked = null; saveSeating(); renderSeating(); }));
  on("seating-display", "click", (e) => {
    const seat = e.target.closest(".seating-seat");
    if (seat) onSeatClick(Number(seat.dataset.row), Number(seat.dataset.col));
  });

  // 토론 타이머
  on("debate-start-btn", "click", startDebate);
  on("debate-pause-btn", "click", pauseDebate);
  on("debate-skip-btn", "click", skipDebateStage);
  on("debate-reset-btn", "click", resetDebate);

  // 퀴즈 · 낱말
  on("chosung-next-btn", "click", nextChosung);
  on("chosung-reveal-btn", "click", revealChosung);
  on("word-pick-btn", "click", pickWord);

  // 돌림판
  on("wheel-items", "input", drawWheel);
  on("wheel-spin", "click", spinWheel);
  on("wheel-svg", "click", spinWheel);
  on("wheel-from-roster", "click", () => {
    const names = activeNames();
    if (!names.length) { toast("먼저 위쪽 명단을 올리거나 입력해 주세요"); return; }
    $("wheel-items").value = names.join(", ");
    drawWheel();
  });

  // 번호뽑기 · 투표 · 글자 수
  on("numberpick-btn", "click", pickNumber);
  on("vote-create-btn", "click", createVote);
  on("vote-option", "keydown", (e) => { if (e.key === "Enter") createVote(); });
  on("vote-display", "click", (e) => {
    const b = e.target.closest("[data-vote]");
    if (b) castVote(Number(b.dataset.vote));
  });
  on("count-text", "input", renderCharCount);
  on("count-limit", "change", renderCharCount);
  on("count-limit-custom", "input", renderCharCount);

  // 소음 · 녹음 · 실시간 변조
  on("noise-toggle", "click", toggleNoise);
  on("rec-toggle", "click", toggleRecord);
  on("rec-play", "click", playRecording);
  on("rec-save", "click", saveRecording);
  on("live-toggle", "click", toggleLiveVoice);
  on("live-effect", "change", rebuildLiveChain);
  on("live-volume", "input", rebuildLiveChain);
  on("live-mic", "change", () => { if (liveRunning()) { stopLiveVoice(); startLiveVoice(); } });

  // 신호등 · 화이트보드
  document.querySelectorAll("[data-signal]").forEach((b) =>
    b.addEventListener("click", () => setSignal(b.dataset.signal)));
  on("wb-clear", "click", clearWhiteboard);
  on("wb-save", "click", saveWhiteboard);
  on("wb-eraser", "click", () => {
    wbErase = !wbErase;
    $("wb-eraser").classList.toggle("btn-primary", wbErase);
    $("wb-eraser").textContent = wbErase ? "지우개 ✓" : "지우개";
  });

  on("theme-btn", "click", toggleTheme);
}

// ============================================================
//  시작
// ============================================================
function init() {
  let saved = null;
  try { saved = localStorage.getItem(LK_THEME); } catch {}
  applyTheme(saved === "dark" ? "dark" : "light");
  bindAll();
  loadRoster();
  loadGroupSets();
  loadSeating();
  renderSeating();
  renderCharCount();
  drawWheel();
  tickClock();
  setInterval(tickClock, 1000);
  initWhiteboard();
  fillMicList();
  // 마이크 권한을 받은 뒤 기기 이름이 보이도록
  navigator.mediaDevices?.addEventListener?.("devicechange", fillMicList);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
