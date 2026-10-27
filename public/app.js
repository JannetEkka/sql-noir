// SQL Noir in the browser: talks to the game's JSON API and draws the case,
// the evidence, Nemo's hints, the score, H-MEM memory and the agent trace.
const $ = (id) => document.getElementById(id);
let traceSince = 0;
let shownCaseId = null;
let lastTotal = 0;
let tracePolling = false;

const WAITING = {
  next: ["Pulling the case file…", "Checking the evidence holds up on Zetaris…", "Dusting the tables for prints…"],
  query: ["Running it on Zetaris…", "Searching the archives…", "Comparing it with the evidence…", "Nemo is reading your work…"],
  hint: ["Nemo leans in…"],
  explain: ["Nemo is reading your report…", "Filing the paperwork…"],
  design: ["Nemo is writing up a new case…", "The validator is checking it on Zetaris…", "Sending it back for a rewrite…", "Still working the case…"],
};

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function drawTable(el, set) {
  if (!set || !set.rows) return (el.innerHTML = "");
  const width = set.columns?.length ?? set.rows[0]?.length ?? 0;
  const head = set.columns ?? Array.from({ length: width }, (_, i) => `col ${i + 1}`);
  el.innerHTML = `<thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${set.rows
    .map((r) => `<tr>${r.map((v) => `<td>${v === null ? '<span class="muted">NULL</span>' : esc(v)}</td>`).join("")}</tr>`)
    .join("")}</tbody>`;
}

function toast(text) {
  const t = $("toast");
  t.hidden = true;
  void t.offsetWidth;
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3300);
}

// A spinner, a running clock and a line that changes while the agents work.
function startBusy(kind) {
  for (const b of document.querySelectorAll("button")) b.disabled = true;
  const lines = WAITING[kind] ?? ["Working…"];
  const started = Date.now();
  let i = 0;
  $("busy").hidden = false;
  $("busy-text").textContent = lines[0];
  $("busy-time").textContent = "";
  const timer = setInterval(() => {
    const secs = Math.round((Date.now() - started) / 1000);
    $("busy-time").textContent = `${secs}s`;
    if (secs > 0 && secs % 4 === 0) $("busy-text").textContent = lines[++i % lines.length];
  }, 1000);
  return () => {
    clearInterval(timer);
    $("busy").hidden = true;
    for (const b of document.querySelectorAll("button")) b.disabled = false;
  };
}

function typewrite(el, text) {
  clearInterval(el.typing);
  el.textContent = "";
  el.classList.add("typing");
  let i = 0;
  el.typing = setInterval(() => {
    el.textContent = text.slice(0, (i += 2));
    if (i >= text.length) {
      clearInterval(el.typing);
      el.classList.remove("typing");
    }
  }, 18);
}

// Puts a table or column name into the query where the cursor is.
function insertAtCursor(text) {
  const box = $("sql");
  const start = box.selectionStart ?? box.value.length;
  const end = box.selectionEnd ?? start;
  const before = box.value.slice(0, start);
  const pad = before && !/\s$/.test(before) ? " " : "";
  box.value = before + pad + text + box.value.slice(end);
  const at = start + pad.length + text.length;
  box.focus();
  box.setSelectionRange(at, at);
}

function drawFiles(files) {
  $("files").innerHTML = (files ?? [])
    .map(
      (f) => `<div class="file">
        <span class="chip table" data-insert="${esc(f.table)}">${esc(f.table)}</span>
        <div>${f.columns.map((c) => `<span class="chip" data-insert="${esc(c.name)}">${esc(c.name)}<small>${esc(c.type)}</small></span>`).join("") || '<span class="muted small">columns not available</span>'}</div>
        ${f.sample?.rows?.length ? `<details><summary>${f.sample.rows.length} sample row(s)</summary><div class="table-wrap"><table data-sample="${esc(f.table)}"></table></div></details>` : ""}
      </div>`,
    )
    .join("");
  for (const f of files ?? []) {
    const t = document.querySelector(`table[data-sample="${CSS.escape(f.table)}"]`);
    if (t) drawTable(t, f.sample);
  }
}

function drawScore(score) {
  if (!score) return;
  $("rank").textContent = score.rank.name;
  $("pts").textContent = score.total;
  $("bar").style.width = `${Math.round(score.rank.progress * 100)}%`;
  $("score").title = score.rank.next ? `${score.rank.toNext} pts to ${score.rank.next}` : "Top rank";
  $("streak").textContent = score.streak > 1 ? `streak ${score.streak}` : "";
  if (score.total !== lastTotal) {
    $("score").classList.remove("bump");
    void $("score").offsetWidth;
    $("score").classList.add("bump");
    lastTotal = score.total;
  }
}

function drawState(s) {
  const g = s.game;
  drawScore(g.score);
  $("case-empty").hidden = !!g.case;
  $("case").hidden = !g.case;
  $("stamp").hidden = !g.case || g.phase !== "closed";
  $("btn-next").textContent = !g.case ? "Take your first case" : g.phase === "closed" ? "Next case" : "Skip case";
  if (g.case) {
    if (g.case.id !== shownCaseId) {
      shownCaseId = g.case.id;
      typewrite($("case-story"), g.case.story);
      drawFiles(g.case.files);
    }
    $("case-title").textContent = g.case.title;
    $("case-question").textContent = g.case.question;
    $("case-level").textContent = `Level ${g.case.level} · worth ${100 * g.case.level}`;
    $("case-skills").textContent = g.case.skills.join(" · ");
    $("case-origin").textContent = g.case.origin === "designer" ? "written by Nemo, checked on Zetaris" : "seed case";
    $("case-why").textContent = g.pickReason ? `Why this case: ${g.pickReason}.` : "";
    $("recalled").hidden = !g.recalled?.length;
    $("recalled-list").innerHTML = (g.recalled ?? []).map((n) => `<li>${esc(n.content)} <span class="muted">(${n.relevance})</span></li>`).join("");
    $("hints").innerHTML = (g.hints ?? []).map((h) => `<li>${esc(h.text)}<span class="src">level ${h.level} · ${h.source === "coach" ? "Nemo, cleared by the critic" : "from the case file"}</span></li>`).join("");
    const investigating = g.phase === "investigating";
    $("btn-hint").hidden = !investigating;
    $("btn-hint").textContent = g.hintReady ? "Nemo has a lead. Ask for it (-15 pts)" : "Ask Nemo for a hint (-15 pts)";
    $("hint-note").textContent = investigating && g.hintReady ? "Nemo looked at your last attempt." : "";
    $("explain").hidden = g.phase !== "explaining";
    $("reveal").hidden = g.phase !== "closed";
    if (g.phase === "closed" && g.reveal) {
      $("award").textContent = g.award ? `+${g.award.points} pts` : "";
      $("breakdown").innerHTML = (g.award?.breakdown ?? []).map((b) => `<li>${esc(b)}</li>`).join("");
      $("judgement").innerHTML = g.judgement ? `Nemo on your report: <b>${esc(g.judgement.rating)}</b>. ${esc(g.judgement.feedback)}` : "";
      $("answer-sql").textContent = g.reveal.answerSql;
      drawTable($("answer"), g.reveal.answer);
    }
  } else {
    $("btn-hint").hidden = true;
  }
  $("memory").innerHTML = s.memory.length
    ? s.memory.map((m) => `<li data-id="${esc(m.id)}">${esc(m.content)}<span class="conf">${m.confidence}</span></li>`).join("")
    : '<li class="muted">Nothing yet.</li>';
}

function drawVerdict(r) {
  const v = $("verdict");
  v.hidden = false;
  if (r.refused) return (v.className = "verdict warn"), (v.textContent = r.refused);
  if (r.error) return (v.className = "verdict bad"), (v.textContent = r.error);
  v.className = `verdict ${r.verdict?.correct ? "good" : "bad"}`;
  v.textContent = r.message ?? "";
  const e = r.verdict?.evidence;
  if (!e) return;
  $("evidence").innerHTML = `<dl>
      <dt>Verdict</dt><dd>${esc(r.verdict.kind)}</dd>
      <dt>Rows</dt><dd>${e.actualRows} returned, ${e.expectedRows} expected</dd>
      <dt>Columns</dt><dd>${e.columnMatches.map((c) => `${esc(c.expected)} → ${c.actual === null ? '<span style="color:var(--bad)">no match</span>' : c.exact ? esc(c.actual) : `${esc(c.actual)} <span class="muted">(some values differ)</span>`}`).join("<br>")}</dd>
    </dl>${e.extra.length ? `<p class="small">Rows of yours that shouldn't be there:</p><div class="table-wrap"><table>${e.extra.map((row) => `<tr>${row.map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`).join("")}</table></div>` : ""}${(r.verdict.notes ?? []).map((n) => `<p class="small muted">${esc(n)}</p>`).join("")}`;
}

async function pollTrace() {
  // One poll at a time, or two in flight would both add the same lines.
  if (tracePolling) return;
  tracePolling = true;
  try {
    const { events } = await api(`/api/trace?since=${traceSince}`);
    traceSince += events.length;
    const list = $("trace");
    for (const e of events) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="muted">${esc(e.at.slice(11, 19))}</span><span class="who">${esc(e.agent)}</span><span class="what">${esc(e.action)} <span>${esc(e.detail)}</span></span>`;
      list.appendChild(li);
    }
    if (events.length) list.scrollTop = list.scrollHeight;
  } catch {
  } finally {
    tracePolling = false;
  }
}

async function pollStatus() {
  try {
    const s = await api("/api/status");
    $("st-zetaris").className = `pill ${s.zetaris ? "ok" : "down"}`;
    $("st-zetaris").textContent = s.zetaris ? "Zetaris connected" : "Zetaris offline";
    $("st-meterless").className = `pill ${s.meterless === "online" ? "ok" : "down"}`;
    $("st-meterless").textContent = `Nightshift ${s.meterless} · ${s.model}`;
  } catch {}
}

async function act(kind, path, body) {
  const stop = startBusy(kind);
  const tick = setInterval(pollTrace, 1000);
  try {
    const r = await api(path, body);
    drawState(r);
    return r;
  } catch (err) {
    drawVerdict({ error: err.message });
  } finally {
    clearInterval(tick);
    stop();
    pollTrace();
  }
}

$("btn-start").onclick = () => $("btn-next").click();
$("btn-next").onclick = async () => {
  $("verdict").hidden = true;
  $("result").innerHTML = "";
  $("sql").value = "";
  $("why").value = "";
  $("evidence").innerHTML = '<span class="muted">Run a query to see how it compares with the answer.</span>';
  const r = await act("next", "/api/next", {});
  if (r && !r.ok) drawVerdict({ refused: "No open cases left. Press Design a case and Nemo will write you a new one." });
};
$("btn-design").onclick = async () => {
  const r = await act("design", "/api/design", {});
  if (r && !r.ok) drawVerdict({ refused: `Nemo couldn't come up with a fair case this time: ${r.problem ?? "try again"}.` });
};
$("btn-run").onclick = async () => {
  const r = await act("query", "/api/query", { sql: $("sql").value });
  if (r) {
    drawVerdict(r);
    drawTable($("result"), r.result);
    if (r.verdict?.correct) toast("You've got it. Now explain it.");
  }
};
$("btn-hint").onclick = () => act("hint", "/api/hint", {});
$("btn-explain").onclick = async () => {
  const before = $("rank").textContent;
  const r = await act("explain", "/api/explain", { text: $("why").value });
  const award = r?.game?.award;
  if (award) toast(award.rankAfter !== before && award.rankAfter !== award.rankBefore ? `Promoted to ${award.rankAfter}! +${award.points} pts` : `Case closed. +${award.points} pts`);
};
$("files").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-insert]");
  if (chip) insertAtCursor(chip.dataset.insert);
});
$("sql").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("btn-run").click();
});
$("memory").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  const { history } = await api(`/api/memory/${li.dataset.id}/history`);
  const box = $("ledger");
  box.hidden = false;
  box.innerHTML = `<b>Trust ledger for ${esc(li.dataset.id)}</b><br>${history
    .map((h) => `${esc(new Date(h.timestamp).toLocaleTimeString())} ${esc(h.action)} by ${esc(h.actor)}${h.newState?.confidence !== undefined ? ` → confidence ${Number(h.newState.confidence).toFixed(2)}` : ""}`)
    .join("<br>")}`;
});

api("/api/state").then((s) => {
  lastTotal = s.game.score?.total ?? 0;
  drawState(s);
}).catch(() => {});
pollStatus();
pollTrace();
setInterval(pollTrace, 3000);
setInterval(pollStatus, 15000);
