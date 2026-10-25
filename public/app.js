// SQL Noir in the browser: talks to the game's JSON API and draws the case,
// the evidence, the coach's hints, H-MEM memory and the agent trace.
const $ = (id) => document.getElementById(id);
let traceSince = 0;

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

function setBusy(on, note = "") {
  for (const b of document.querySelectorAll("button")) b.disabled = on;
  $("run-note").textContent = note;
}

function drawState(s) {
  const g = s.game;
  $("case-empty").hidden = !!g.case;
  $("case").hidden = !g.case;
  if (g.case) {
    $("case-title").textContent = g.case.title;
    $("case-story").textContent = g.case.story;
    $("case-question").textContent = g.case.question;
    $("case-level").textContent = `Level ${g.case.level}`;
    $("case-skills").textContent = g.case.skills.join(" · ");
    $("case-origin").textContent = g.case.origin === "designer" ? "designed by Nemotron, checked on Zetaris" : "seed case";
    $("case-why").textContent = g.pickReason ? `Why this case: ${g.pickReason}.` : "";
    $("recalled").hidden = !g.recalled?.length;
    $("recalled-list").innerHTML = (g.recalled ?? []).map((n) => `<li>${esc(n.content)} <span class="muted">(${n.relevance})</span></li>`).join("");
    $("hints").innerHTML = (g.hints ?? []).map((h) => `<li>${esc(h.text)}<span class="src">level ${h.level} · ${h.source === "coach" ? "coach, approved by the critic" : "from the case file"}</span></li>`).join("");
    $("explain").hidden = g.phase !== "explaining";
    $("reveal").hidden = g.phase !== "closed";
    if (g.phase === "closed" && g.reveal) {
      $("judgement").innerHTML = g.judgement ? `Explanation: <b>${esc(g.judgement.rating)}</b>. ${esc(g.judgement.feedback)}` : "";
      $("answer-sql").textContent = g.reveal.answerSql;
      drawTable($("answer"), g.reveal.answer);
    }
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
      <dt>Columns</dt><dd>${e.columnMatches.map((c) => `${esc(c.expected)} → ${c.actual ? esc(c.actual) : '<span style="color:var(--bad)">no match</span>'}`).join("<br>")}</dd>
    </dl>${e.extra.length ? `<p class="small">Rows of yours that shouldn't be there:</p><div class="table-wrap"><table>${e.extra.map((row) => `<tr>${row.map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`).join("")}</table></div>` : ""}${(r.verdict.notes ?? []).map((n) => `<p class="small muted">${esc(n)}</p>`).join("")}`;
}

async function pollTrace() {
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
  } catch {}
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

async function act(path, body, note) {
  setBusy(true, note);
  try {
    const r = await api(path, body);
    drawState(r);
    return r;
  } catch (err) {
    drawVerdict({ error: err.message });
  } finally {
    setBusy(false);
    pollTrace();
  }
}

$("btn-next").onclick = async () => {
  $("verdict").hidden = true;
  $("result").innerHTML = "";
  $("evidence").innerHTML = '<span class="muted">Run a query to see how it compares with the answer.</span>';
  const r = await act("/api/next", {}, "Checking the case against the data…");
  if (r && !r.ok) drawVerdict({ refused: "No open cases left. Press Design a case for a new one." });
};
$("btn-design").onclick = () => act("/api/design", {}, "Nemotron is drafting a case; the validator will check it on Zetaris…");
$("btn-run").onclick = async () => {
  const r = await act("/api/query", { sql: $("sql").value }, "Running on Zetaris…");
  if (r) {
    drawVerdict(r);
    drawTable($("result"), r.result);
  }
};
$("btn-explain").onclick = () => act("/api/explain", { text: $("why").value }, "The coach is reading your explanation…");
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

api("/api/state").then(drawState).catch(() => {});
pollStatus();
pollTrace();
setInterval(pollTrace, 2000);
setInterval(pollStatus, 15000);
