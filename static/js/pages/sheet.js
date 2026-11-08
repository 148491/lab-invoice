/* Éditeur de feuille de temps : utilisé par « Mes temps » et par les chefs de projet pour saisir à la place de quelqu'un. */
import { $, $$, api, esc, fmt, icon, combobox, modal, toast, progressRing, confirmDialog, stepHalf } from "../core.js";

export async function sheetEditor(host, monthKey, collaborator, { onSaved } = {}) {
  host.innerHTML = `<div class="skel-wrap"><div class="skel" style="height:140px"></div><div class="skel"></div><div class="skel"></div></div>`;
  const [sheet, options] = await Promise.all([
    api(`/api/months/${monthKey}/sheets/${encodeURIComponent(collaborator)}`),
    api(`/api/lots/options?month=${monthKey}`),
  ]);
  const locked = sheet.locked;
  let rows = sheet.manual.map((r) => ({ label: r.epic || r.lot, hours: r.hours, comment: r.summary === "Saisie manuelle" || r.summary === "Feuille du timesheet" ? "" : r.summary, issue_key: r.issue_key }));
  if (!rows.length && !locked) rows = [{ label: "", hours: "", comment: "" }];
  let dirty = false;
  const optList = options.map((o) => ({ value: o.value, label: o.value, sub: o.kind === "epic" ? `→ ${o.lot}` : "projet", tag: o.category }));
  const jiraByLot = {};
  sheet.jira.forEach((j) => { const k = j.epic || j.lot || "Sans epic"; jiraByLot[k] = (jiraByLot[k] || 0) + j.hours; });

  const total = () => rows.reduce((a, r) => a + (fmt.parse(r.hours) || 0), 0) + sheet.jira_hours;

  host.innerHTML = `
  <div class="grid g-side">
    <div class="card">
      <div class="card-head"><div class="grow"><h2>Temps saisis dans l'application</h2><div class="desc">Une ligne par projet (epic Jira ou lot). Tapez pour chercher, ou collez depuis Excel.</div></div>
        ${locked ? `<span class="chip">${icon("lock")}Mois validé</span>` : `<button class="btn sm" id="pasteBtn">${icon("clipboard")}Coller depuis Excel</button>`}</div>
      <div class="card-body" style="padding-top:8px">
        <div class="sheet-row sheet-head hide-mobile"><div>Projet / epic</div><div>Heures</div><div>Commentaire</div><div></div></div>
        <div id="rows"></div>
        ${locked ? "" : `<button class="btn ghost sm" id="addRow" style="margin-top:10px">${icon("plus")}Ajouter une ligne</button>`}
      </div>
      ${locked ? "" : `<div class="sticky-bar"><div class="grow small muted" id="saveState">${sheet.submitted_at ? `${icon("check")} Déclarée le ${fmt.datetime(sheet.submitted_at)}` : "Brouillon non déclaré"}</div>
        <button class="btn" id="saveDraft">Enregistrer</button><button class="btn primary" id="submit">${icon("send")}Déclarer mes temps</button></div>`}
    </div>
    <div class="stack">
      <div class="card card-pad" style="display:flex;gap:18px;align-items:center">
        <div id="ring"></div>
        <div><div class="muted small">Total du mois</div><div style="font-size:13px;margin-top:4px">Attendu : <b>${fmt.h(sheet.expected)}</b><br><span class="faint">${sheet.working_days} jours ouvrés</span></div><div id="ringMsg" class="small" style="margin-top:6px"></div></div>
      </div>
      <div class="card"><div class="card-head"><div class="grow"><h2>Déjà dans Jira</h2><div class="desc">Importé avec le timesheet, en lecture seule.</div></div><span class="chip">${fmt.h(sheet.jira_hours)}</span></div>
        ${Object.keys(jiraByLot).length ? `<div class="list">${Object.entries(jiraByLot).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `<div class="list-item"><div class="grow small ellipsis" title="${esc(k)}">${esc(k)}</div><span class="num small">${fmt.h(v)}</span></div>`).join("")}</div>` : `<div class="card-body faint small">Aucune heure Jira ce mois-ci. Si vos temps ne sont pas dans Jira, saisissez-les ici.</div>`}
      </div>
    </div>
  </div>`;

  const updateTotals = () => {
    const t = total();
    $("#ring", host).innerHTML = progressRing(t, sheet.expected, 118);
    const ratio = sheet.expected ? t / sheet.expected : 0;
    $("#ringMsg", host).innerHTML = ratio > 1.2 ? `<span style="color:var(--danger)">${icon("alert")} Au-dessus de l'attendu</span>` : ratio >= 0.8 ? `<span style="color:var(--success)">${icon("check")} Cohérent</span>` : `<span style="color:var(--warning)">${fmt.h(sheet.expected - t)} manquantes</span>`;
  };

  const drawRows = () => {
    const box = $("#rows", host);
    if (!rows.length) { box.innerHTML = `<div class="faint small" style="padding:16px 0">Aucune ligne saisie.</div>`; updateTotals(); return; }
    box.innerHTML = rows.map((r, i) => `<div class="sheet-row ${r.err ? "err" : ""}" data-i="${i}">
      <div class="c-lot"><input class="lot" value="${esc(r.label)}" placeholder="Rechercher un projet…" ${locked ? "disabled" : ""} aria-label="Projet">${r.err ? `<div class="xs" style="color:var(--danger);margin-top:3px">${esc(r.err)}${r.sugg?.length ? ` — ${r.sugg.map((s) => `<a href="#" data-sugg="${esc(s)}">${esc(s)}</a>`).join(", ")}` : ""}</div>` : ""}</div>
      <div class="c-hours"><div class="stepper"><button type="button" data-step="-0.5" aria-label="Moins" ${locked ? "disabled" : ""}>${icon("minus")}</button><input class="hours" inputmode="decimal" value="${esc(r.hours)}" placeholder="0" ${locked ? "disabled" : ""} aria-label="Heures"><button type="button" data-step="0.5" aria-label="Plus" ${locked ? "disabled" : ""}>${icon("plus")}</button></div></div>
      <div class="c-comment"><input class="comment" value="${esc(r.comment || "")}" placeholder="Commentaire (facultatif)" ${locked ? "disabled" : ""} aria-label="Commentaire"></div>
      <div class="c-del">${locked ? "" : `<button class="icon-btn" data-del aria-label="Supprimer la ligne">${icon("trash")}</button>`}</div></div>`).join("");
    $$(".sheet-row", box).forEach((el) => {
      const i = +el.dataset.i;
      const lot = $(".lot", el), h = $(".hours", el), c = $(".comment", el);
      if (!locked) combobox(lot, () => optList, () => { rows[i].label = lot.value; rows[i].err = null; dirty = true; });
      lot.addEventListener("input", () => { rows[i].label = lot.value; dirty = true; });
      h.addEventListener("input", () => { rows[i].hours = h.value; dirty = true; updateTotals(); });
      c.addEventListener("input", () => { rows[i].comment = c.value; dirty = true; });
      $$("[data-step]", el).forEach((b) => (b.onclick = () => { const v = stepHalf(fmt.parse(h.value) || 0, +b.dataset.step); h.value = String(v).replace(".", ","); rows[i].hours = h.value; dirty = true; updateTotals(); }));
      $("[data-del]", el)?.addEventListener("click", () => { rows.splice(i, 1); dirty = true; drawRows(); });
      $$("[data-sugg]", el).forEach((a) => (a.onclick = (e) => { e.preventDefault(); rows[i].label = a.dataset.sugg; rows[i].err = null; dirty = true; drawRows(); }));
    });
    updateTotals();
  };
  drawRows();
  if (locked) return;

  $("#addRow", host).onclick = () => { rows.push({ label: "", hours: "", comment: "" }); drawRows(); $$(".lot", host).at(-1)?.focus(); };
  const save = async (submit) => {
    const payload = rows.map((r) => ({ label: r.label, hours: fmt.parse(r.hours) || 0, comment: r.comment, issue_key: r.issue_key }));
    try {
      const res = await api(`/api/months/${monthKey}/sheets/${encodeURIComponent(collaborator)}`, { method: "PUT", json: { rows: payload, submit }, quiet: true });
      dirty = false;
      rows = rows.filter((r) => r.label || fmt.parse(r.hours)); rows.forEach((r) => (r.err = null)); drawRows();
      $("#saveState", host).innerHTML = submit ? `${icon("check")} Déclarée à l'instant` : "Enregistré";
      toast(submit ? `Temps déclarés : ${fmt.h(res.hours)}` : `Brouillon enregistré (${fmt.h(res.hours)})`, "success");
      onSaved?.();
    } catch (e) {
      if (e.detail?.errors) {
        const nonEmpty = rows.filter((r) => r.label || fmt.parse(r.hours));
        rows = nonEmpty;
        e.detail.errors.forEach((er) => { if (rows[er.index]) { rows[er.index].err = er.error === "lot inconnu" ? "Projet introuvable" : er.error === "heures manquantes" ? "Indiquez les heures" : er.error; rows[er.index].sugg = er.suggestions; } });
        drawRows(); toast("Certaines lignes sont à corriger (en rouge).", "error");
      } else toast(e.message, "error");
    }
  };
  $("#saveDraft", host).onclick = (e) => withLoading(e.currentTarget, () => save(false));
  $("#submit", host).onclick = async (e) => {
    const t = total(), r = sheet.expected ? t / sheet.expected : 1;
    if ((r < 0.8 || r > 1.2) && !(await confirmDialog("Total inhabituel", `Vous déclarez <b>${fmt.h(t)}</b> pour un attendu de <b>${fmt.h(sheet.expected)}</b>. Confirmer ? (congés, temps partiel, miluim…)`, { ok: "Déclarer quand même" }))) return;
    withLoading(e.currentTarget, () => save(true));
  };
  $("#pasteBtn", host).onclick = () => pasteDialog(monthKey, collaborator, (parsed) => {
    rows = rows.filter((r) => r.label || fmt.parse(r.hours)).concat(parsed.map((p) => ({ label: p.label, hours: String(p.hours).replace(".", ","), comment: p.summary, issue_key: p.issue_key, err: p.ok ? null : p.error === "lot inconnu" ? "Projet introuvable" : p.error, sugg: p.suggestions })));
    dirty = true; drawRows();
  });
  window.onbeforeunload = () => (dirty ? true : undefined);
}

async function withLoading(btn, fn) { btn.classList.add("loading"); try { await fn(); } finally { btn.classList.remove("loading"); } }

function pasteDialog(monthKey, collaborator, onDone) {
  let parsed = [];
  return modal({
    title: "Coller des temps depuis Excel", size: "lg",
    body: `<p class="muted small">Copiez les cellules dans Excel ou Google Sheets puis collez-les ici. Formats reconnus : <b>Projet ⇥ Heures</b>, ou les colonnes de l'export Jira (<b>Ticket ⇥ Résumé ⇥ Epic ⇥ Heures</b>).</p>
      <textarea id="pt" rows="8" placeholder="EPICS-2: TRAVELSKI - MINOR EVOLUTIONS	16&#10;YOONLY - E-COMMERCE WEBSITE	32" autofocus></textarea>
      <div id="pp" style="margin-top:14px"></div>`,
    actions: [{ label: "Annuler" }, { label: "Ajouter les lignes", kind: "primary", onClick: () => { if (!parsed.length) return false; onDone(parsed); } }],
    onMount: (ctx) => {
      const ta = $("#pt", ctx.el);
      let t;
      ta.addEventListener("input", () => {
        clearTimeout(t);
        t = setTimeout(async () => {
          parsed = ta.value.trim() ? await api(`/api/months/${monthKey}/sheets/${encodeURIComponent(collaborator)}/parse`, { method: "POST", json: { text: ta.value } }) : [];
          const ok = parsed.filter((p) => p.ok).length;
          $("#pp", ctx.el).innerHTML = parsed.length ? `<div class="row between small" style="margin-bottom:8px"><b>${parsed.length} lignes détectées</b><span>${ok} reconnues · ${parsed.length - ok} à vérifier · ${fmt.h(parsed.reduce((a, p) => a + p.hours, 0))}</span></div>
            <div class="table-wrap" style="max-height:260px;border:1px solid var(--border);border-radius:10px"><table class="t"><thead><tr><th></th><th>Projet</th><th class="num">Heures</th></tr></thead><tbody>${parsed.map((p) => `<tr><td>${p.ok ? `<span style="color:var(--success)">${icon("check")}</span>` : `<span style="color:var(--warning)">${icon("alert")}</span>`}</td><td class="small">${esc(p.label)}${p.ok ? "" : `<div class="xs" style="color:var(--warning)">${p.error === "lot inconnu" ? "Projet non reconnu" : esc(p.error)}${p.suggestions?.length ? " — proche de : " + p.suggestions.map(esc).join(", ") : ""}</div>`}</td><td class="num">${fmt.h(p.hours)}</td></tr>`).join("")}</tbody></table></div>` : "";
        }, 250);
      });
    },
  });
}
