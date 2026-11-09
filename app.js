"use strict";

// ============================================================
// 画面要素
// ============================================================

const $ = (id) => document.getElementById(id);

const roleScreen = $("roleScreen");
const connectionHeader = $("connectionHeader");
const setupScreen = $("setupScreen");
const counterScreen = $("counterScreen");

const roomKeyInput = $("roomKey");
const launchButton = $("launchButton");
const roleError = $("roleError");

const connectionInfo = $("connectionInfo");
const connectionStatus = $("connectionStatus");
const notice = $("notice");

const studentCountInput = $("studentCount");
const prepareButton = $("prepareButton");
const startButton = $("startButton");
const setupButton = $("setupButton");
const timer = $("timer");
const counterHelp = $("counterHelp");
const studentGrid = $("studentGrid");

const editDialog = $("editDialog");
const editForm = $("editForm");
const editName = $("editName");
const editTarget = $("editTarget");
const editReset = $("editReset");

const SESSION_KEY = "lapCounterWebSession";

const POLL_INTERVAL_MS = 500;
const CONNECTION_TIMEOUT_MS = 3000;

// ============================================================
// アプリの状態
// ============================================================

let session = null;
let state = null;

let connected = false;
let lastReceivedAt = 0;

let elapsedBase = 0;
let elapsedBaseAt = 0;

let renderedVersion = null;
let renderedScreen = null;

let polling = false;
let busy = false;

let editingStudentId = null;
let draftTimer = null;

const pendingStudents = new Set();


// ============================================================
// 共通
// ============================================================

function selectedRole() {
  return document.querySelector(
    'input[name="role"]:checked'
  ).value;
}

function updateRoleInputs() {
  const isB = selectedRole() === "B";

  roomKeyInput.disabled = !isB;

  if (isB) {
    roomKeyInput.focus();
  }
}

function showRoleScreen() {
  roleScreen.classList.remove("hidden");
  connectionHeader.classList.add("hidden");
  setupScreen.classList.add("hidden");
  counterScreen.classList.add("hidden");

  roleError.textContent = "";
  notice.textContent = "";
}

function showAppScreen(screen) {
  roleScreen.classList.add("hidden");
  connectionHeader.classList.remove("hidden");

  setupScreen.classList.toggle(
    "hidden",
    screen !== "setup"
  );

  counterScreen.classList.toggle(
    "hidden",
    screen !== "counter"
  );
}

function makeRequestId() {
  if (window.crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2) +
    "-" +
    Math.random().toString(36).slice(2)
  );
}

function formatTime(seconds) {
  const centiseconds = Math.max(
    0,
    Math.floor(seconds * 100)
  );

  const minutes = Math.floor(centiseconds / 6000);
  const secondsPart = Math.floor(
    (centiseconds % 6000) / 100
  );
  const fraction = centiseconds % 100;

  return (
    String(minutes).padStart(2, "0") +
    ":" +
    String(secondsPart).padStart(2, "0") +
    "." +
    String(fraction).padStart(2, "0")
  );
}

function currentElapsed() {
  if (!state) {
    return 0;
  }

  if (state.running && connected) {
    return (
      elapsedBase +
      Math.max(0, performance.now() - elapsedBaseAt) / 1000
    );
  }

  return elapsedBase;
}

function setOffline() {
  if (connected) {
    elapsedBase = currentElapsed();
    elapsedBaseAt = performance.now();
  }

  connected = false;
  updateConnectionDisplay();
  updateControls();
}


// ============================================================
// サーバー通信
// ============================================================

async function api(path, payload = null, currentSession = session) {
  const headers = {};

  if (currentSession) {
    headers["X-Room-Key"] = currentSession.key;
    headers["X-Role"] = currentSession.role;

    if (currentSession.role === "A") {
      headers["X-Admin-Token"] = currentSession.adminToken;
    }
  }

  const options = {
    method: payload === null ? "GET" : "POST",
    headers,
    cache: "no-store",
  };

  if (payload !== null) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(payload);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    options.signal = controller.signal;

    const response = await fetch(path, options);
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(
        result.error || "通信に失敗しました。"
      );
    }

    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function performAction(path, payload = {}) {
  if (!session || !connected || busy) {
    return;
  }

  busy = true;
  updateControls();

  try {
    const activeSession = session;
    const result = await api(path, payload, activeSession);

    // 通信中に役割選択へ戻った場合は反映しない。
    if (session !== activeSession) {
      return;
    }

    notice.textContent = "";
    applyState(result.state);
  } catch (error) {
    notice.textContent = error.message;

    // 記録の成否が不明な場合もあるので、最新状態を再取得。
    await pollState();
  } finally {
    busy = false;
    updateControls();
  }
}

async function pollState() {
  if (!session || polling) {
    return;
  }

  polling = true;
  const activeSession = session;

  try {
    const result = await api(
      "/api/state",
      null,
      activeSession
    );

    if (session !== activeSession) {
      return;
    }

    applyState(result.state);
  } catch (error) {
    if (session === activeSession) {
      setOffline();
    }
  } finally {
    polling = false;
  }
}


// ============================================================
// 起動・退出
// ============================================================

document.querySelectorAll('input[name="role"]').forEach(
  (input) => {
    input.addEventListener("change", updateRoleInputs);
  }
);

launchButton.addEventListener("click", async () => {
  const role = selectedRole();

  roleError.textContent = "";
  launchButton.disabled = true;

  try {
    if (role === "A") {
      const result = await api("/api/create", {});

      session = {
        role: "A",
        key: result.key,
        adminToken: result.admin_token,
      };

      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify(session)
      );

      state = null;
      renderedVersion = null;
      renderedScreen = null;

      applyState(result.state);
    } else {
      const key = roomKeyInput.value.trim().toUpperCase();

      if (!key) {
        throw new Error("接続キーを入力してください。");
      }

      const candidate = {
        role: "B",
        key,
      };

      const result = await api(
        "/api/state",
        null,
        candidate
      );

      session = candidate;

      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify(session)
      );

      state = null;
      renderedVersion = null;
      renderedScreen = null;

      applyState(result.state);
    }
  } catch (error) {
    roleError.textContent = error.message;
  } finally {
    launchButton.disabled = false;
  }
});

$("leaveButton").addEventListener("click", () => {
  const message = session?.role === "A"
    ? (
        "役割選択に戻ります。\n" +
        "この画面からAの管理操作はできなくなります。\n" +
        "よろしいですか？"
      )
    : "役割選択に戻りますか？";

  if (!confirm(message)) {
    return;
  }

  sessionStorage.removeItem(SESSION_KEY);

  session = null;
  state = null;
  connected = false;
  renderedVersion = null;
  renderedScreen = null;

  pendingStudents.clear();

  if (editDialog.open) {
    editDialog.close();
  }

  showRoleScreen();
});

async function restoreSession() {
  const saved = sessionStorage.getItem(SESSION_KEY);

  if (!saved) {
    showRoleScreen();
    return;
  }

  try {
    const candidate = JSON.parse(saved);

    if (
      !candidate ||
      !["A", "B"].includes(candidate.role) ||
      typeof candidate.key !== "string"
    ) {
      throw new Error("保存された接続情報が不正です。");
    }

    if (
      candidate.role === "A" &&
      typeof candidate.adminToken !== "string"
    ) {
      throw new Error("Aの接続情報が不正です。");
    }

    session = candidate;

    const result = await api(
      "/api/state",
      null,
      candidate
    );

    if (session === candidate) {
      applyState(result.state);
    }
  } catch (error) {
    sessionStorage.removeItem(SESSION_KEY);
    session = null;
    showRoleScreen();

    roleError.textContent =
      "前回の接続を復元できませんでした。もう一度起動してください。";
  }
}


// ============================================================
// 状態の反映
// ============================================================

function applyState(newState) {
  if (!session || !newState) {
    return;
  }

  if (
    state &&
    newState.version < state.version
  ) {
    return;
  }

  const oldRunId = state?.run_id;

  state = newState;

  if (oldRunId && oldRunId !== newState.run_id) {
    pendingStudents.clear();
  }

  connected = true;
  lastReceivedAt = performance.now();

  elapsedBase = Number(newState.elapsed) || 0;
  elapsedBaseAt = performance.now();

  showAppScreen(newState.screen);
  updateConnectionDisplay();

  const needsRender =
    renderedVersion !== newState.version ||
    renderedScreen !== newState.screen;

  if (needsRender) {
    if (newState.screen === "setup") {
      renderSetup();
    } else {
      renderCounter();
    }

    renderedVersion = newState.version;
    renderedScreen = newState.screen;
  }

  updateControls();
}

function updateConnectionDisplay() {
  if (!session) {
    return;
  }

  if (session.role === "A") {
    connectionInfo.textContent =
      `A：親機　接続キー：${session.key}`;

    if (!connected) {
      connectionStatus.textContent =
        "サーバーに接続できません。再接続を試みています。";

      connectionStatus.className =
        "connection-status status-offline";
    } else if (state?.b_connected) {
      connectionStatus.textContent =
        "B接続中 — Aは最後の−1以外を操作できます。";

      connectionStatus.className =
        "connection-status status-online";
    } else {
      connectionStatus.textContent =
        "B未接続 — ゴール記録前にBを接続してください。";

      connectionStatus.className =
        "connection-status status-offline";
    }
  } else {
    connectionInfo.textContent =
      `B：ゴール専用　接続キー：${session.key}`;

    if (connected) {
      connectionStatus.textContent =
        "Aと同期中 — 残り1周の最後の−1だけ操作できます。";

      connectionStatus.className =
        "connection-status status-online";
    } else {
      connectionStatus.textContent =
        "接続できません。サーバーとネットワークを確認してください。";

      connectionStatus.className =
        "connection-status status-offline";
    }
  }
}

function updateControls() {
  if (!session || !state) {
    return;
  }

  const isA = session.role === "A";

  studentCountInput.disabled =
    !isA || !connected || busy;

  prepareButton.disabled =
    !isA || !connected || busy;

  startButton.disabled =
    !isA || !connected || busy || state.running;

  setupButton.disabled =
    !isA || !connected || busy;

  if (state.running) {
    startButton.textContent = "計測中";
    startButton.classList.add("running");
  } else {
    startButton.textContent = "▶ スタート";
    startButton.classList.remove("running");
  }

  if (state.screen === "counter") {
    updateCardPermissions();
  }
}


// ============================================================
// 人数選択
// ============================================================

function renderSetup() {
  if (
    session.role === "B" ||
    document.activeElement !== studentCountInput
  ) {
    studentCountInput.value = state.draft_count;
  }
}

function readStudentCount() {
  const value = Number(studentCountInput.value);

  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > 40
  ) {
    throw new Error("人数は1〜40名の整数で入力してください。");
  }

  return value;
}

studentCountInput.addEventListener("input", () => {
  if (session?.role !== "A") {
    return;
  }

  clearTimeout(draftTimer);

  draftTimer = setTimeout(async () => {
    try {
      const count = readStudentCount();

      if (!connected) {
        return;
      }

      const activeSession = session;

      const result = await api(
        "/api/draft",
        { count },
        activeSession
      );

      if (session === activeSession) {
        applyState(result.state);
      }
    } catch (error) {
      // 入力途中の空欄などはここでは通知しない。
    }
  }, 250);
});

prepareButton.addEventListener("click", () => {
  try {
    const count = readStudentCount();

    clearTimeout(draftTimer);

    performAction("/api/prepare", { count });
  } catch (error) {
    notice.textContent = error.message;
  }
});


// ============================================================
// 記録画面
// ============================================================

function cardFontSizes(count) {
  const rows = Math.ceil(count / 2);

  const gridHeight = Math.max(
    1,
    studentGrid.clientHeight
  );

  const rowHeight = gridHeight / rows;

  return {
    name: Math.max(8, Math.min(22, rowHeight * 0.32)),
    count: Math.max(9, Math.min(30, rowHeight * 0.46)),
    finish: Math.max(8, Math.min(22, rowHeight * 0.32)),
    button: Math.max(9, Math.min(27, rowHeight * 0.42)),
    completed: Math.max(7, Math.min(15, rowHeight * 0.23)),
  };
}

function applyGridSizing() {
  if (!state || state.screen !== "counter") {
    return;
  }

  const count = state.student_count;
  const rows = Math.ceil(count / 2);
  const sizes = cardFontSizes(count);

  studentGrid.style.gridTemplateRows =
    `repeat(${rows}, minmax(0, 1fr))`;

  studentGrid.style.setProperty(
    "--name-size",
    `${sizes.name}px`
  );

  studentGrid.style.setProperty(
    "--count-size",
    `${sizes.count}px`
  );

  studentGrid.style.setProperty(
    "--finish-size",
    `${sizes.finish}px`
  );

  studentGrid.style.setProperty(
    "--button-size",
    `${sizes.button}px`
  );

  studentGrid.style.setProperty(
    "--completed-size",
    `${sizes.completed}px`
  );
}

function makeButton(className, text) {
  const button = document.createElement("button");

  button.type = "button";
  button.className = className;
  button.textContent = text;

  return button;
}

function renderCounter() {
  counterHelp.textContent =
    session.role === "A"
      ? "A：最後の−1以外を操作できます。ゴール記録はBが行います。"
      : "B：残り1周の赤い−1だけ操作できます。";

  studentGrid.replaceChildren();

  for (const student of state.students) {
    const card = document.createElement("div");

    card.className = "student-card";
    card.dataset.studentId = student.id;

    const nameButton = makeButton(
      "name-cell",
      student.name
    );

    nameButton.title = student.name;
    nameButton.addEventListener("click", () => {
      openEditDialog(student.id);
    });

    const countCell = document.createElement("div");
    countCell.className = "count-cell";

    const finished =
      student.remaining === 0 &&
      student.finish_time !== null;

    if (finished) {
      countCell.classList.add("finished");
      countCell.textContent = formatTime(student.finish_time);
    } else {
      if (student.remaining === 1) {
        countCell.classList.add("last");
      }

      const caption = document.createElement("span");
      caption.className = "count-caption";
      caption.textContent = "のこり";

      const number = document.createElement("span");
      number.textContent = `${student.remaining} 周`;

      countCell.append(caption, number);
    }

    let minusOrCompleted;

    if (finished) {
      minusOrCompleted = document.createElement("div");
      minusOrCompleted.className = "completed-cell";

      const text = document.createElement("span");
      text.append("走った周数");
      text.append(document.createElement("br"));
      text.append(`${student.completed_laps} 周`);

      minusOrCompleted.append(text);
    } else {
      minusOrCompleted = makeButton("minus-cell", "−1");

      if (
        session.role === "B" &&
        student.remaining === 1
      ) {
        minusOrCompleted.classList.add("finish-ready");
      }

      minusOrCompleted.addEventListener("click", () => {
        changeRemaining(student.id, -1);
      });
    }

    const plusButton = makeButton("plus-cell", "＋1");

    plusButton.addEventListener("click", () => {
      changeRemaining(student.id, 1);
    });

    card.append(
      nameButton,
      countCell,
      minusOrCompleted,
      plusButton
    );

    studentGrid.append(card);
  }

  requestAnimationFrame(() => {
    applyGridSizing();
    updateCardPermissions();
  });
}

function canChange(student, delta) {
  if (
    !session ||
    !state ||
    !connected ||
    busy ||
    state.screen !== "counter" ||
    !state.running
  ) {
    return false;
  }

  if (session.role === "A") {
    if (delta === -1) {
      return student.remaining >= 2;
    }

    if (delta === 1) {
      return student.remaining < student.target;
    }

    return false;
  }

  return (
    delta === -1 &&
    student.remaining === 1 &&
    student.finish_time === null &&
    !pendingStudents.has(student.id)
  );
}

function updateCardPermissions() {
  if (!state || state.screen !== "counter") {
    return;
  }

  for (const student of state.students) {
    const card = studentGrid.querySelector(
      `[data-student-id="${student.id}"]`
    );

    if (!card) {
      continue;
    }

    const nameButton = card.querySelector(".name-cell");
    const minusButton = card.querySelector(".minus-cell");
    const plusButton = card.querySelector(".plus-cell");

    nameButton.disabled =
      session.role !== "A" || !connected || busy;

    if (minusButton) {
      minusButton.disabled = !canChange(student, -1);
    }

    if (plusButton) {
      plusButton.disabled = !canChange(student, 1);
    }
  }
}

startButton.addEventListener("click", () => {
  performAction("/api/start");
});

setupButton.addEventListener("click", () => {
  if (
    !confirm(
      "人数選択画面に戻ります。\n" +
      "次の走行では残り周数と完走記録がリセットされます。\n\n" +
      "よろしいですか？"
    )
  ) {
    return;
  }

  performAction("/api/setup");
});

async function changeRemaining(studentId, delta) {
  if (!state || !session) {
    return;
  }

  const student = state.students.find(
    (item) => item.id === studentId
  );

  if (!student || !canChange(student, delta)) {
    return;
  }

  if (session.role === "A") {
    await performAction("/api/change", {
      student_id: studentId,
      delta,
    });

    return;
  }

  const activeSession = session;

  pendingStudents.add(studentId);
  updateCardPermissions();

  try {
    const result = await api(
      "/api/finish",
      {
        request_id: makeRequestId(),
        run_id: state.run_id,
        student_id: studentId,
        revision: student.revision,
      },
      activeSession
    );

    if (session !== activeSession) {
      return;
    }

    notice.textContent = "";
    applyState(result.state);
  } catch (error) {
    if (session === activeSession) {
      notice.textContent =
        "ゴール操作の結果を確認できませんでした。 " +
        "記録済みの場合もあるため、最新の完走表示を確認してください。";

      setOffline();
      await pollState();
    }
  } finally {
    pendingStudents.delete(studentId);
    updateCardPermissions();
  }
}


// ============================================================
// ランナー設定
// ============================================================

function openEditDialog(studentId) {
  if (
    session?.role !== "A" ||
    !connected ||
    busy ||
    !state
  ) {
    return;
  }

  const student = state.students.find(
    (item) => item.id === studentId
  );

  if (!student) {
    return;
  }

  editingStudentId = studentId;

  editName.value = student.name;
  editTarget.value = student.target;
  editReset.checked = false;

  editDialog.showModal();
  editName.focus();
  editName.select();
}

$("cancelEditButton").addEventListener("click", () => {
  editDialog.close();
});

editForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!state || editingStudentId === null) {
    return;
  }

  const student = state.students.find(
    (item) => item.id === editingStudentId
  );

  if (!student) {
    editDialog.close();
    return;
  }

  const name = editName.value.trim();
  const target = Number(editTarget.value);

  if (!name || name.length > 100) {
    alert("名前は1〜100文字で入力してください。");
    return;
  }

  if (
    !Number.isInteger(target) ||
    target < 1 ||
    target > 9999
  ) {
    alert("目標周数は1〜9999の整数で入力してください。");
    return;
  }

  const willReset =
    editReset.checked ||
    target !== student.target;

  if (
    willReset &&
    !confirm(
      "残り周数を目標周数に戻し、完走記録をリセットします。\n" +
      "共通タイマーはリセットされません。\n\n" +
      "よろしいですか？"
    )
  ) {
    return;
  }

  const payload = {
    student_id: editingStudentId,
    name,
    target,
    reset: editReset.checked,
  };

  editDialog.close();

  await performAction("/api/edit", payload);
});


// ============================================================
// 定期更新
// ============================================================

window.addEventListener("resize", () => {
  applyGridSizing();
});

setInterval(() => {
  pollState();
}, POLL_INTERVAL_MS);

setInterval(() => {
  if (!session || !state) {
    return;
  }

  if (
    connected &&
    performance.now() - lastReceivedAt > CONNECTION_TIMEOUT_MS
  ) {
    setOffline();
  }

  timer.textContent = formatTime(currentElapsed());
}, 50);

updateRoleInputs();
restoreSession();
