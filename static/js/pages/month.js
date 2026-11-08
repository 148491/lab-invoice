/* Facture du mois : temps → charges → répartitions → CAPEX & FG → contrôles → facture. */
import { $, $$, S, api, can, esc, fmt, icon, month, chip, statusChip, empty, modal, toast, dropzone, confirmDialog, formDialog, avatar, hoursBar, download, combobox } from "../core.js";
import { go, rerender, updateNavBadge } from "../app.js";

const TABS = [
  { k: "temps", label: "Temps", icon: "clock", perm: "time.all" },
  { k: "charges", label: "Charges", icon: "coins", perm: "costs" },
  { k: "repartitions", label: "Répartitions", icon: "pie", perm: "time.all" },
  { k: "frais", label: "CAPEX & frais", icon: "layers", perm: "invoice" },
  { k: "controles", label: "Contrôles", icon: "shield", perm: "view" },
  { k: "facture", label: "Facture", icon: "invoice", perm: "view" },
];

export async function render(view, { params }) {
  if (!S.months.length) S.months = await api("/api/months");
  const m = month.valid(params[0] || "") ? params[0] : (S.months.find((x) => x.status === "draft") || S.months[0] || { month: month.current() }).month;
  const tabs = TABS.filter((t) => can(t.perm));
  const tab = tabs.find((t) => t.k === params[1]) ? params[1] : tabs[0].k;
  view.innerHTML = `<div class="skel-wrap"><div class="skel" style="height:60px"></div><div class="skel" style="height:90px"></div><div class="skel" style="height:300px"></div></div>`;
  const d = await api(`/api/months/${m}`);
  const locked = d.status === "validated";
  const errs = d.issues.filter((i) => i.level === "error").length;
  const st = (k) => {
    const has = (codes) => d.issues.some((i) => i.level === "error" && codes.includes(i.code));
    return { temps: d.stats.entries ? (has(["no_epic", "unknown_epic", "closed_project", "no_timesheet"]) ? "bad" : "done") : "",
      charges: d.stats.cost_total ? (has(["cost_not_allocated"]) ? "bad" : "done") : "",
      repartitions: d.prorata.length && d.stats.entries ? "done" : "",
      frais: d.invoice.overhead ? "done" : "",
      controles: d.blocking ? "bad" : "done",
      facture: locked ? "done" : "" }[k];
  };
  view.innerHTML = `
  <div class="page-head"><div class="grow"><div class="crumbs">${icon("invoice")}Facture du mois</div>
      <div class="row" style="gap:8px"><button class="icon-btn" id="pm" aria-label="Mois précédent">${icon("chevL")}</button><div class="month-pick"><button class="month-btn" id="mpick" aria-haspopup="listbox" aria-expanded="false"><h1>${month.label(m)}</h1>${icon("chevD")}</button><div class="month-menu" id="mmenu" role="listbox" hidden></div></div><button class="icon-btn" id="nm" aria-label="Mois suivant">${icon("chevR")}</button>${statusChip(d.status)}</div></div>
    <div class="toolbar">${locked && can("invoice") ? `<button class="btn" id="reopen">${icon("unlock")}Réouvrir</button>` : ""}
      <button class="btn" id="xlsx">${icon("download")}<span class="hide-mobile">Exporter</span> Excel</button></div></div>
  <div class="grid g4" style="margin-bottom:16px">
    ${kpi("clock", "Heures", fmt.num(d.stats.hours), `${d.stats.entries} lignes · ${d.working_days} j. ouvrés`)}
    ${kpi("coins", "Coût salarial réparti", fmt.money0(d.stats.salary_allocated), `sur ${fmt.money0(d.stats.cost_total)} chargés`)}
    ${kpi("layers", "DAP + frais généraux", fmt.money0(d.invoice.overhead), `CAPEX ${fmt.money0(d.invoice.dap)} · FG ${fmt.money0(d.invoice.frais_generaux)}`)}
    ${kpi("invoice", "Total facture", fmt.money0(d.invoice.total.price), `${d.invoice.lines.length} lots · cost + ${Math.round(d.invoice.cost_plus_rate * 100)} %`)}
  </div>
  <nav class="steps" aria-label="Étapes">${tabs.map((t, i) => `<button class="step ${st(t.k)} ${t.k === tab ? "on" : ""}" data-t="${t.k}"><span class="step-n">${st(t.k) === "done" ? icon("check") : st(t.k) === "bad" ? "!" : i + 1}</span>${t.label}${t.k === "controles" && errs ? ` <span class="badge">${errs}</span>` : ""}</button>`).join("")}</nav>
  ${locked ? `<div class="alert alert-success" style="margin-bottom:16px">${icon("lock")}<div class="grow"><div class="alert-title">Facture validée</div>Les données de ce mois sont figées. ${can("invoice") ? "Réouvrez le mois pour les modifier." : ""}</div></div>` : ""}
  <div id="tab"></div>`;
  $("#pm", view).onclick = () => go(`mois/${month.prev(m)}/${tab}`);
  $("#nm", view).onclick = () => go(`mois/${month.next(m)}/${tab}`);
  $$(".step", view).forEach((b) => (b.onclick = () => go(`mois/${m}/${b.dataset.t}`)));
  const menu = $("#mmenu", view), btn = $("#mpick", view);
  const closeMenu = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); document.removeEventListener("mousedown", outside); };
  const outside = (e) => { if (!e.target.closest(".month-pick")) closeMenu(); };
  btn.onclick = () => {
    if (!menu.hidden) return closeMenu();
    const list = [...new Set([...S.months.map((x) => x.month), m])].sort().reverse();
    const byM = Object.fromEntries(S.months.map((x) => [x.month, x]));
    menu.innerHTML = list.map((k) => { const x = byM[k] || { status: "draft" }; return `<button class="month-item ${k === m ? "on" : ""}" role="option" data-m="${k}">
        <span class="grow">${month.label(k)}</span>${x.total ? `<span class="xs faint num">${fmt.money0(x.total)}</span>` : ""}${x.status === "validated" ? `<span style="color:var(--success)">${icon("lock")}</span>` : chip("Brouillon", "warning")}</button>`; }).join("")
      + `<div class="month-new"><input type="month" id="mnew" value="${month.next(list[0])}" aria-label="Autre mois"><button class="btn sm" id="mgo">${icon("arrowR")}Ouvrir</button></div>`;
    menu.hidden = false; btn.setAttribute("aria-expanded", "true");
    menu.querySelector(".month-item.on")?.scrollIntoView({ block: "nearest" });
    menu.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => { closeMenu(); go(`mois/${b.dataset.m}/${tab}`); }));
    $("#mgo", menu).onclick = () => { const v = $("#mnew", menu).value; if (month.valid(v)) { closeMenu(); go(`mois/${v}/${tab}`); } };
    setTimeout(() => document.addEventListener("mousedown", outside));
  };
  btn.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  $("#xlsx", view).onclick = () => download(`/api/months/${m}/invoice.xlsx`);
  $("#reopen", view)?.addEventListener("click", async () => {
    if (!(await confirmDialog("Réouvrir le mois ?", "La facture figée sera recalculée à partir des données actuelles. Les temps et charges redeviennent modifiables.", { ok: "Réouvrir" }))) return;
    await api(`/api/months/${m}/reopen`, { method: "POST" }); toast("Mois réouvert", "success"); S.months = await api("/api/months"); updateNavBadge(); rerender();
  });
  const fn = { temps: tabTemps, charges: tabCharges, repartitions: tabProrata, frais: tabFrais, controles: tabControles, facture: tabFacture }[tab];
  await fn($("#tab", view), d, m, locked);
}

const kpi = (ic, label, value, sub) => `<div class="kpi"><div class="kpi-label">${icon(ic)}${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;

// =================================================================== rapprochement des noms (commun temps / charges)
function nameResolution(people, collabNames) {
  const unknown = people.filter((p) => p.status === "unknown");
  if (!unknown.length) return "";
  return `<div class="card" style="margin-bottom:16px;border-color:color-mix(in srgb, var(--warning) 45%, var(--border))">
    <div class="card-head"><span class="issue-ic" style="background:var(--warning-soft);color:var(--warning)">${icon("userPlus")}</span><div class="grow"><h2>${unknown.length} nom${unknown.length > 1 ? "s" : ""} inconnu${unknown.length > 1 ? "s" : ""} du référentiel</h2>
      <div class="desc">Rattachez chaque nom à un collaborateur existant (il sera mémorisé comme alias) ou créez un nouveau collaborateur. ${S.ai ? `${icon("sparkles")} Suggestions assistées par IA.` : ""}</div></div></div>
    <div class="list">${unknown.map((p) => {
      const best = p.suggestions[0];
      const act = p.proposal?.action || "create";
      return `<div class="list-item" data-raw="${esc(p.raw)}" style="flex-wrap:wrap">
        <div style="min-width:200px;flex:1"><div style="font-weight:650">${esc(p.raw)}</div>
          <div class="xs faint">${p.hours != null ? fmt.h(p.hours) : fmt.money(p.amount)}${best ? ` · proche de <b>${esc(best.name)}</b> (${Math.round(best.score * 100)} % — ${esc(best.reason)})` : " · aucune correspondance"}</div></div>
        <div class="row" style="flex:1.4;min-width:280px">
          <select class="act" style="width:150px"><option value="alias" ${act === "alias" ? "selected" : ""}>Rattacher à</option><option value="create" ${act === "create" ? "selected" : ""}>Créer</option><option value="ignore">Ignorer</option></select>
          <select class="target" style="flex:1;min-width:160px;${act === "alias" ? "" : "display:none"}">${p.suggestions.map((s) => `<option value="${esc(s.name)}">${esc(s.name)} · ${Math.round(s.score * 100)} %</option>`).join("")}<option disabled>──────────</option>${collabNames.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("")}</select>
          <input class="newname" style="flex:1;min-width:160px;${act === "create" ? "" : "display:none"}" value="${esc(p.proposal?.name || p.raw)}" placeholder="Nom officiel">
        </div></div>`;
    }).join("")}</div></div>`;
}
function bindResolution(el) {
  $$("[data-raw]", el).forEach((row) => {
    const a = $(".act", row);
    a.onchange = () => { $(".target", row).style.display = a.value === "alias" ? "" : "none"; $(".newname", row).style.display = a.value === "create" ? "" : "none"; };
  });
}
function collectDecisions(el) {
  const out = {};
  $$("[data-raw]", el).forEach((row) => {
    const act = $(".act", row).value;
    out[row.dataset.raw] = act === "alias" ? { action: "alias", target: $(".target", row).value } : act === "create" ? { action: "create", name: $(".newname", row).value.trim() || row.dataset.raw } : { action: "ignore" };
  });
  return out;
}

// =================================================================== TEMPS
async function tabTemps(el, d, m, locked) {
  const [overview, entries] = await Promise.all([api(`/api/months/${m}/sheets`), api(`/api/months/${m}/entries`)]);
  const issueIds = new Set(d.issues.filter((i) => ["no_epic", "unknown_epic", "closed_project"].includes(i.code)).flatMap((i) => i.details.map((x) => x.id)));
  const tol = +(S.settings.expected_tolerance || 0.2);
  const people = overview.filter((p) => p.total > 0 || p.mode === "jira" || p.mode === "manual");
  const declared = overview.filter((p) => p.submitted_at).length;
  el.innerHTML = `
  ${locked ? "" : `<div class="grid g2" style="margin-bottom:16px">
    <div class="card"><div class="card-head"><div class="grow"><h2>Importer le timesheet</h2><div class="desc">Fichier « Timesheet - All Teams » ou export Jira brut. Vous vérifiez avant d'importer.</div></div></div>
      <div class="card-body"><div class="drop" id="tsDrop"><div class="drop-ic">${icon("upload")}</div><div class="drop-title">Déposez le fichier Excel ici</div><div class="drop-sub">ou cliquez pour le choisir · .xlsx</div></div>
      <button class="btn ghost sm" id="tsPaste" style="margin-top:10px">${icon("clipboard")}Coller des lignes Jira à la place</button></div></div>
    <div class="card"><div class="card-head"><div class="grow"><h2>Saisies dans l'application</h2><div class="desc">Pour ceux dont les temps ne sont pas dans Jira : chacun déclare depuis « Mes temps ».</div></div><span class="chip ${declared ? "chip-success" : ""}">${declared} déclarée${declared > 1 ? "s" : ""}</span></div>
      <div class="card-body"><div class="row"><select id="sayFor" style="flex:1"><option value="">Saisir pour un collaborateur…</option>${overview.map((p) => `<option>${esc(p.name)}</option>`).join("")}</select><button class="btn" id="goSay">${icon("edit")}Ouvrir</button></div>
      <p class="small muted" style="margin-top:12px;margin-bottom:0">Lien à partager à l'équipe : <a href="#/mes-temps/${m}">${esc(location.origin)}/#/mes-temps/${m}</a> <button class="icon-btn" id="copyLink" aria-label="Copier le lien" style="width:26px;height:26px">${icon("copy")}</button></p></div></div>
  </div>`}
  <div class="card" style="margin-bottom:16px"><div class="card-head"><div class="grow"><h2>Heures par collaborateur</h2><div class="desc">Comparées à l'attendu du mois (${fmt.h(overview[0]?.expected)} = ${d.working_days} j × ${d.hours_per_day} h). Écart toléré ± ${Math.round(tol * 100)} %.</div></div></div>
    <div class="table-wrap"><table class="t responsive"><thead><tr><th>Collaborateur</th><th>Mode</th><th class="num">Jira</th><th class="num">Saisies</th><th class="num">Total</th><th style="width:22%">Vs attendu</th><th>Statut</th><th></th></tr></thead><tbody>
    ${people.map((p) => {
      const r = p.expected ? p.total / p.expected : 0;
      const stc = p.mode === "prorata" || p.mode === "mirror" ? chip("Prorata", "brand") : !p.total ? chip("Aucune heure", "danger") : r < 1 - tol ? chip("Faible", "warning") : r > 1 + tol ? chip("Élevé", "danger") : chip("OK", "success");
      return `<tr><td class="primary-cell" data-l=""><div class="person">${avatar(p.name)}<div><div style="font-weight:600">${esc(p.name)}</div><div class="xs faint">${esc(p.role || "")}</div></div></div></td>
        <td data-l="Mode">${chip({ jira: "Jira", manual: "Saisie", prorata: "Prorata", mirror: "Miroir" }[p.mode] || p.mode)}</td>
        <td class="num" data-l="Jira">${p.jira ? fmt.h(p.jira) : "—"}</td><td class="num" data-l="Saisies">${p.manual ? fmt.h(p.manual) : "—"}${p.submitted_at ? ` <span title="Déclarée le ${fmt.datetime(p.submitted_at)}" style="color:var(--success)">${icon("check")}</span>` : ""}</td>
        <td class="num" data-l="Total"><b>${fmt.h(p.total)}</b></td><td data-l="Vs attendu">${p.mode === "prorata" || p.mode === "mirror" ? '<span class="faint xs">réparti automatiquement</span>' : hoursBar(p.total, p.expected, tol)}</td>
        <td data-l="Statut">${stc}</td><td class="actions">${locked ? "" : `<a class="btn sm ghost" href="#/mes-temps/${m}/${encodeURIComponent(p.name)}">${icon("edit")}<span class="hide-mobile">Saisir</span></a>`}</td></tr>`;
    }).join("") || `<tr><td colspan="8">${empty("Aucun temps", "Importez le timesheet ou faites saisir les temps.", "clock")}</td></tr>`}
    </tbody></table></div></div>
  <div class="card"><div class="card-head"><div class="grow"><h2>Lignes de temps <span class="faint small">${entries.length}</span></h2></div>
      <div class="input-icon" style="min-width:220px;flex:1;max-width:340px">${icon("search")}<input id="fQ" placeholder="Ticket, epic, lot, personne…"></div>
      <label class="check small"><input type="checkbox" id="fIss"> Anomalies (${issueIds.size})</label></div>
    <div class="table-wrap"><table class="t"><thead><tr><th>Collaborateur</th><th>Ticket</th><th>Résumé</th><th>Epic</th><th>Lot forcé</th><th class="num">Heures</th><th>Source</th><th></th></tr></thead><tbody id="eBody"></tbody></table></div></div>`;

  // lignes
  let q = "", only = false, limit = 100;
  const drawEntries = () => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = entries.filter((e) => (!only || issueIds.has(e.id)) && words.every((w) => `${e.collaborator} ${e.issue_key} ${e.summary} ${e.epic} ${e.lot}`.toLowerCase().includes(w)));
    $("#eBody", el).innerHTML = rows.slice(0, limit).map((e) => `<tr data-id="${e.id}" class="${issueIds.has(e.id) ? "row-danger" : ""}"><td class="nowrap">${esc(e.collaborator)}</td><td class="mono nowrap">${esc(e.issue_key)}</td><td class="small" style="max-width:280px"><div class="ellipsis" title="${esc(e.summary)}">${esc(e.summary)}</div></td>
      <td class="small" style="max-width:240px">${e.epic ? `<div class="ellipsis" title="${esc(e.epic)}">${esc(e.epic)}</div>` : chip("sans epic", "danger")}</td>
      <td style="min-width:180px"><input class="in-cell lotf" data-f="lot" value="${esc(e.lot)}" placeholder="auto" ${locked ? "disabled" : ""}></td>
      <td class="num"><input class="in-cell amount" style="width:76px" data-f="hours" value="${e.hours}" ${locked ? "disabled" : ""}></td><td>${chip(e.source)}</td>
      <td class="actions">${locked ? "" : `<button class="icon-btn" data-del aria-label="Supprimer">${icon("trash")}</button>`}</td></tr>`).join("")
      + (rows.length > limit ? `<tr><td colspan="8" style="text-align:center"><button class="btn sm" id="moreE">Afficher ${Math.min(200, rows.length - limit)} lignes de plus (${rows.length - limit} restantes)</button></td></tr>` : "")
      + (!rows.length ? `<tr><td colspan="8">${empty("Aucune ligne")}</td></tr>` : "");
    $("#moreE", el)?.addEventListener("click", () => { limit += 200; drawEntries(); });
    $$("#eBody input", el).forEach((inp) => inp.addEventListener("change", async () => {
      const id = inp.closest("tr").dataset.id, f = inp.dataset.f;
      await api(`/api/entries/${id}`, { method: "PATCH", json: { [f]: f === "hours" ? fmt.parse(inp.value) || 0 : inp.value.trim() } });
      toast("Ligne mise à jour", "success");
    }));
    $$("#eBody [data-del]", el).forEach((b) => (b.onclick = async () => {
      const tr = b.closest("tr"); await api(`/api/entries/${tr.dataset.id}`, { method: "DELETE" });
      entries.splice(entries.findIndex((x) => x.id == tr.dataset.id), 1); tr.remove(); toast("Ligne supprimée", "success");
    }));
  };
  drawEntries();
  $("#fQ", el).oninput = (e) => { q = e.target.value; limit = 100; drawEntries(); };
  $("#fIss", el).onchange = (e) => { only = e.target.checked; limit = 100; drawEntries(); };
  if (locked) return;

  dropzone($("#tsDrop", el), async (f) => {
    const t = toastLoading(`Analyse de ${f.name}…`);
    try { const pv = await api(`/api/months/${m}/timesheet/preview`, { method: "POST", form: { file: f } }); t(); await reviewTimesheet(pv, m); }
    catch (_) { t(); }
  });
  $("#tsPaste", el).onclick = async () => {
    const r = await formDialog("Coller des lignes Jira", [{ name: "text", label: "Colonnes : User ⇥ Issue key ⇥ Issue summary ⇥ Epic ⇥ Time spent (hours)", type: "textarea", rows: 10, full: true, required: true }], { ok: "Analyser" });
    if (!r) return;
    const pv = await api(`/api/months/${m}/timesheet/preview`, { method: "POST", form: { text: r.text } });
    await reviewTimesheet(pv, m);
  };
  $("#goSay", el).onclick = () => { const v = $("#sayFor", el).value; if (v) go(`mes-temps/${m}/${encodeURIComponent(v)}`); };
  $("#copyLink", el).onclick = () => { navigator.clipboard?.writeText(`${location.origin}/#/mes-temps/${m}`); toast("Lien copié", "success"); };
}

function toastLoading(msg) {
  const el = document.createElement("div");
  el.className = "modal-backdrop in"; el.style.background = "transparent"; el.style.pointerEvents = "none";
  el.innerHTML = `<div class="toast in" style="position:fixed;bottom:24px;right:24px"><span class="btn loading ghost" style="width:20px;height:20px;padding:0"></span><div class="toast-msg">${esc(msg)}</div></div>`;
  document.body.appendChild(el);
  return () => el.remove();
}

async function reviewTimesheet(pv, m) {
  const collabs = (await api("/api/ref/collaborators")).filter((c) => c.active).map((c) => c.name);
  const tol = pv.tolerance;
  const flagged = pv.people.filter((p) => ["low", "high"].includes(p.hours_status)).length;
  const body = `
    ${pv.month_mismatch ? `<div class="alert alert-warning" style="margin-bottom:14px">${icon("calendar")}<div class="grow"><div class="alert-title">Mois différent</div>Le fichier semble concerner <b>${month.label(pv.file_month)}</b> alors que vous importez dans <b>${month.label(m)}</b>.</div></div>` : ""}
    <div class="grid g4" style="margin-bottom:16px">
      ${kpi("list", "Lignes", pv.totals.lines, `${fmt.h(pv.totals.hours)}`)}
      ${kpi("users", "Collaborateurs", pv.totals.people, pv.unknown_people ? `<span style="color:var(--warning)">${pv.unknown_people} inconnu(s)</span>` : "tous reconnus")}
      ${kpi("alert", "Heures à vérifier", flagged, `écart > ${Math.round(tol * 100)} % de l'attendu`)}
      ${kpi("tag", "Epics", pv.totals.epics || "—", pv.unknown_epics.length ? `<span style="color:var(--warning)">${pv.unknown_epics.length} inconnue(s)</span>` : pv.no_epic_hours ? `${fmt.h(pv.no_epic_hours)} sans epic` : "référentiel à jour")}
    </div>
    ${nameResolution(pv.people, collabs)}
    ${pv.missing.length ? `<div class="alert alert-info" style="margin-bottom:16px">${icon("users")}<div class="grow"><div class="alert-title">${pv.missing.length} collaborateur(s) déclaré(s) absent(s) du fichier</div>
      <div class="small" style="margin:6px 0 4px">Congés, miluim, temps hors Jira ? Ils peuvent saisir leurs temps dans l'application.</div>
      <div class="row" style="gap:6px">${pv.missing.map((x) => chip(`${x.name}${x.self_hours ? ` · ${fmt.num(x.self_hours)} h saisies` : ""}`, x.self_hours ? "success" : "")).join("")}</div></div></div>` : ""}
    <h3>Heures par collaborateur dans le fichier</h3>
    <div class="table-wrap" style="max-height:340px;border:1px solid var(--border);border-radius:10px"><table class="t responsive"><thead><tr><th>Nom dans le fichier</th><th>Référentiel</th><th class="num">Lignes</th><th class="num">Heures</th><th style="width:24%">Vs attendu (${fmt.h(pv.expected_hours)})</th><th>Statut</th></tr></thead><tbody>
    ${pv.people.map((p) => `<tr class="${p.hours_status === "high" ? "row-danger" : p.hours_status === "low" ? "row-warning" : ""}"><td class="primary-cell" data-l="">${esc(p.raw)}</td>
      <td data-l="Référentiel">${p.status === "known" ? (p.canonical !== p.raw ? `${icon("link")} ${esc(p.canonical)}` : chip("connu", "success")) : chip("inconnu", "warning")}</td>
      <td class="num" data-l="Lignes">${p.lines}</td><td class="num" data-l="Heures"><b>${fmt.h(p.hours)}</b>${p.no_epic_hours ? `<div class="xs" style="color:var(--danger)">${fmt.h(p.no_epic_hours)} sans epic</div>` : ""}</td>
      <td data-l="Vs attendu">${p.hours_status === "prorata" ? '<span class="xs faint">ignoré : réparti au prorata</span>' : hoursBar(p.hours, p.expected, tol)}</td>
      <td data-l="Statut">${{ ok: chip("OK", "success"), low: chip(`Faible · ${fmt.pct(p.ratio, 0)}`, "warning"), high: chip(`Élevé · ${fmt.pct(p.ratio, 0)}`, "danger"), prorata: chip("Prorata", "brand") }[p.hours_status]}</td></tr>`).join("")}
    </tbody></table></div>
    ${pv.summaries.length ? `<p class="small muted" style="margin-top:12px">${icon("info")} Feuilles individuelles lues : ${pv.summaries.map((s) => `<b>${esc(s.collaborator)}</b> (${s.hours ? fmt.h(s.hours) + " saisies" : ""}${s.holidays ? ` ${fmt.num(s.holidays)} j d'absence` : ""})`).join(", ")}.</p>` : ""}
    ${pv.unknown_epics.length ? `<div class="alert alert-warning" style="margin-top:12px">${icon("tag")}<div class="grow"><div class="alert-title">Epics absentes du référentiel</div><div class="small">${pv.unknown_epics.slice(0, 8).map((e) => `${esc(e.epic)} (${fmt.h(e.hours)})`).join(" · ")}${pv.unknown_epics.length > 8 ? " …" : ""}</div><div class="xs muted">Elles seront signalées dans les contrôles, où vous pourrez les ajouter en un clic.</div></div></div>` : ""}`;
  const res = await modal({
    title: `Vérifier l'import — ${esc(pv.totals.lines)} lignes`, size: "xl", body,
    actions: [{ label: "Annuler" }, {
      label: `Importer ${fmt.h(pv.totals.hours)}`, kind: "primary", icon: "check",
      onClick: async (ctx) => api(`/api/months/${m}/timesheet/commit`, { method: "POST", json: { token: pv.token, decisions: collectDecisions(ctx.el) } }),
    }],
    onMount: (ctx) => bindResolution(ctx.el),
  });
  if (res) { toast(`${res.details} lignes importées${res.epics ? ` · ${res.epics} epics à jour` : ""}${res.ignored ? ` · ${res.ignored} ignorées` : ""}`, "success"); rerender(); }
}

// =================================================================== CHARGES
async function tabCharges(el, d, m, locked) {
  const [costs, collabs] = await Promise.all([api(`/api/months/${m}/costs`), api("/api/ref/collaborators")]);
  const byWho = {};
  costs.forEach((c) => (byWho[c.collaborator.toLowerCase()] ||= []).push(c));
  const hoursOf = Object.fromEntries(d.people.map((p) => [p.collaborator, p.hours]));
  const costOf = Object.fromEntries(d.people.map((p) => [p.collaborator, p.cost]));
  const names = [...new Set([...collabs.filter((c) => c.active && (c.mode !== "jira" || hoursOf[c.name] || costOf[c.name])).map((c) => c.name), ...d.people.map((p) => p.collaborator)])].sort();
  el.innerHTML = `
  ${locked ? "" : `<div class="grid g3" style="margin-bottom:16px">
    <div class="card"><div class="card-head"><h2>Fichier Excel</h2></div><div class="card-body"><div class="drop" id="cpDrop"><div class="drop-ic">${icon("upload")}</div><div class="drop-title">Charge Patronale - BDD</div><div class="drop-sub">Onglet DATAS · Mois / nom / catégorie / coût</div></div></div></div>
    <div class="card"><div class="card-head"><h2>Coller depuis Excel</h2></div><div class="card-body"><textarea id="cpPaste" rows="4" placeholder="Nom	Montant&#10;Marie Dupont	12500,00"></textarea><button class="btn sm" id="cpPasteBtn" style="margin-top:8px">${icon("eye")}Vérifier et importer</button></div></div>
    <div class="card"><div class="card-head"><h2>Raccourci</h2></div><div class="card-body"><p class="small muted">Charges définitives pas encore disponibles ? Reprenez celles du mois précédent, puis remplacez-les.</p><button class="btn" id="cpPrev">${icon("copy")}Copier le mois précédent</button></div></div>
  </div>`}
  <div class="card"><div class="card-head"><div class="grow"><h2>Coût employeur par collaborateur</h2><div class="desc">${locked ? "" : "Saisissez ou corrigez un montant directement dans le tableau (Entrée pour valider)."}</div></div><span class="chip chip-brand">${fmt.money(d.stats.cost_total)}</span></div>
    <div class="table-wrap tall"><table class="t responsive"><thead><tr><th>Collaborateur</th><th>Détail</th><th class="num">Heures</th><th class="num" style="width:170px">Coût du mois</th><th class="num">Coût / h</th><th></th></tr></thead><tbody>
    ${names.map((n) => {
      const lines = byWho[n.toLowerCase()] || [];
      const total = costOf[n] ?? lines.reduce((a, l) => a + l.amount, 0);
      const h = hoursOf[n] || 0;
      const flag = !h && Math.abs(total) > 0.005 ? chip("Aucune heure", "danger") : h && !lines.length && !total ? chip("Pas de coût", "warning") : total < 0 ? chip("Négatif", "warning") : "";
      return `<tr data-who="${esc(n)}"><td class="primary-cell" data-l=""><div class="person">${avatar(n)}<b>${esc(n)}</b></div></td>
        <td data-l="Détail" class="xs faint" style="max-width:320px">${lines.map((l) => `${esc(l.category)} ${fmt.money0(l.amount)}`).join(" · ")}</td>
        <td class="num" data-l="Heures">${fmt.h(h)}</td>
        <td class="num" data-l="Coût"><input class="in-cell amount" value="${lines.length || total ? fmt.money(total) : ""}" placeholder="—" ${locked ? "disabled" : ""} inputmode="decimal"></td>
        <td class="num" data-l="Coût / h">${h && total ? fmt.money(total / h) : "—"}</td><td data-l="">${flag}</td></tr>`;
    }).join("")}</tbody>
    <tfoot><tr><td>Total</td><td></td><td class="num">${fmt.h(d.people.reduce((a, p) => a + p.hours, 0))}</td><td class="num">${fmt.money(d.stats.cost_total)}</td><td></td><td></td></tr></tfoot></table></div></div>`;
  if (locked) return;
  dropzone($("#cpDrop", el), async (f) => reviewCosts(await api(`/api/months/${m}/costs/preview`, { method: "POST", form: { file: f } }), m));
  $("#cpPasteBtn", el).onclick = async () => reviewCosts(await api(`/api/months/${m}/costs/preview`, { method: "POST", form: { text: $("#cpPaste", el).value } }), m);
  $("#cpPrev", el).onclick = async () => { const r = await api(`/api/months/${m}/costs/copy-previous`, { method: "POST" }); toast(`${r.lines} lignes reprises de ${month.label(r.from)}`, "success"); rerender(); };
  $$("tr[data-who] input", el).forEach((inp) => {
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
    inp.addEventListener("change", async () => {
      const v = fmt.parse(inp.value);
      await api(`/api/months/${m}/costs/${encodeURIComponent(inp.closest("tr").dataset.who)}`, { method: "PUT", json: { amount: v } });
      toast("Coût enregistré", "success"); rerender();
    });
  });
}

async function reviewCosts(pv, m) {
  const collabs = (await api("/api/ref/collaborators")).filter((c) => c.active).map((c) => c.name);
  const others = Object.keys(pv.other_months);
  const body = `${nameResolution(pv.people, collabs)}
    ${pv.with_hours_no_cost.length ? `<div class="alert alert-warning" style="margin-bottom:14px">${icon("alert")}<div class="grow"><div class="alert-title">Avec des heures mais sans coût</div><div class="small">${pv.with_hours_no_cost.map((x) => `${esc(x.name)} (${fmt.h(x.hours)})`).join(" · ")}</div><div class="xs muted">Normal pour les freelances ou l'équipe CX facturés à part ; sinon, leurs heures seront valorisées à 0.</div></div></div>` : ""}
    <div class="table-wrap" style="max-height:380px;border:1px solid var(--border);border-radius:10px"><table class="t responsive"><thead><tr><th>Nom</th><th class="num">Montant</th><th class="num">Mois précédent</th><th class="num">Variation</th><th class="num">Heures</th></tr></thead><tbody>
    ${pv.people.map((p) => { const big = p.variation != null && Math.abs(p.variation) > 0.25; return `<tr class="${p.amount < 0 ? "row-warning" : ""}"><td class="primary-cell" data-l="">${esc(p.raw)} ${p.status === "unknown" ? chip("inconnu", "warning") : p.canonical !== p.raw ? `<span class="xs faint">${icon("link")} ${esc(p.canonical)}</span>` : ""}<div class="xs faint">${p.categories.length} catégorie(s)</div></td>
      <td class="num" data-l="Montant"><b>${fmt.money(p.amount)}</b></td><td class="num" data-l="Précédent">${fmt.money(p.previous)}</td>
      <td class="num" data-l="Variation">${p.variation == null ? "—" : `<span style="color:${big ? "var(--danger)" : "var(--text-2)"}">${p.variation > 0 ? "+" : ""}${fmt.pct(p.variation, 0)}</span>`}</td><td class="num" data-l="Heures">${fmt.h(p.hours)}</td></tr>`; }).join("")}
    </tbody><tfoot><tr><td>Total ${month.label(m)}</td><td class="num">${fmt.money(pv.total)}</td><td></td><td></td><td></td></tr></tfoot></table></div>
    ${others.length ? `<label class="check" style="margin-top:14px"><input type="checkbox" id="allm"> Importer aussi les ${others.length} autres mois du fichier (hors mois validés)</label>` : ""}`;
  const res = await modal({
    title: "Vérifier les charges", size: "lg", body,
    actions: [{ label: "Annuler" }, { label: `Importer ${fmt.money0(pv.total)}`, kind: "primary", icon: "check",
      onClick: (ctx) => api(`/api/months/${m}/costs/commit`, { method: "POST", json: { token: pv.token, decisions: collectDecisions(ctx.el), all_months: !!$("#allm", ctx.el)?.checked } }) }],
    onMount: (ctx) => bindResolution(ctx.el),
  });
  if (res) { toast(`Charges importées : ${Object.entries(res).map(([k, v]) => `${month.short(k)} ${fmt.money0(v.total)}`).join(", ")}`, "success"); rerender(); }
}

// =================================================================== RÉPARTITIONS
async function tabProrata(el, d, m, locked) {
  const p = d.params.prorata || {};
  const save = async (np, msg = "Enregistré") => { await api(`/api/months/${m}`, { method: "PUT", json: { prorata: np } }); toast(msg, "success"); rerender(); };
  const card = (x) => {
    const who = x.collaborator, rows = x.lots || [];
    const baseLbl = x.mode === "mirror" ? `Identique à ${esc(x.mirror_of)}`
      : x.base === "jira" ? "Base : heures Jira de l'équipe"
      : `Base : salariés ayant un coût${x.costed_source && x.costed_source !== m ? ` (liste de ${month.label(x.costed_source)}, charges du mois pas encore chargées)` : ""}`;
    return `<div class="card" data-who="${esc(who)}"><div class="card-head">${avatar(who)}<div class="grow"><h2>${esc(who)}</h2><div class="desc">${baseLbl}</div></div>
      ${x.manual ? chip("Ajustée à la main", "warning", "edit") : chip(x.mode === "mirror" ? "Miroir" : "Prorata", "brand")}</div>
      <div class="card-body">
      ${x.mode === "mirror" || x.manual ? "" : `<div class="row" style="margin-bottom:12px"><div class="field" style="flex:1"><label>Jours d'absence</label><input data-k="holidays" type="number" step="0.5" value="${p[who]?.holidays ?? ""}" placeholder="0" ${locked ? "disabled" : ""}></div>
        <div class="field" style="flex:1"><label>ou total forcé (h)</label><input data-k="hours" type="number" step="0.5" value="${p[who]?.hours ?? ""}" placeholder="${fmt.num(x.hours)}" ${locked ? "disabled" : ""}></div></div>`}
      <div class="row between" style="margin-bottom:8px"><span class="muted small">Total réparti · ${rows.length} lots</span><b>${fmt.h(x.hours)}</b></div>
      <div class="list" style="max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:10px">
        ${rows.map((r) => `<div class="list-item" style="padding:7px 12px"><div class="grow xs ellipsis" title="${esc(r.lot)}">${esc(r.lot)}</div><span class="xs num">${fmt.num(r.hours)} h</span><span class="xs num faint" style="width:70px">${fmt.money0(r.cost)}</span></div>`).join("")
          || `<div class="faint small" style="padding:14px">Aucune heure d'équipe à répartir pour l'instant.</div>`}
      </div></div>
      ${locked || x.mode === "mirror" ? "" : `<div class="card-foot">
        ${x.manual ? `<button class="btn sm ghost" data-reset>${icon("history")}Calcul automatique</button>` : ""}
        <button class="btn sm primary" data-edit ${(x.auto_lots || []).length || rows.length ? "" : "disabled"}>${icon("edit")}${x.manual ? "Modifier l'ajustement" : "Ajuster à la main"}</button></div>`}
    </div>`;
  };
  el.innerHTML = `
  <div class="card card-pad" style="margin-bottom:16px"><div class="row" style="align-items:flex-end">
    <div class="field" style="max-width:200px"><label>Jours ouvrés du mois</label><input id="wd" type="number" step="0.5" value="${d.params.working_days ?? ""}" placeholder="${d.working_days_default}" ${locked ? "disabled" : ""}></div>
    <p class="small muted grow" style="margin:0">Par défaut ${d.working_days_default} jours (dimanche → jeudi). Total d'un collaborateur au prorata = (jours ouvrés − absences) × ${d.hours_per_day} h.</p></div></div>
  <div class="alert alert-info" style="margin-bottom:16px">${icon("info")}<div>Ces personnes ne saisissent pas leurs temps : leur coût est réparti sur les lots <b>au prorata des heures de l'équipe</b>. Vous pouvez ensuite <b>ajuster la répartition à la main</b>, lot par lot, selon ce que vous savez. Seule la proportion compte pour le coût.</div></div>
  <div class="grid g3">${d.prorata.map(card).join("") || `<div class="card">${empty("Aucune répartition", "Aucun collaborateur en mode prorata ou miroir (Référentiels › Collaborateurs).", "pie")}</div>`}</div>`;
  if (locked) return;
  $("#wd", el).onchange = async (e) => { await api(`/api/months/${m}`, { method: "PUT", json: { working_days: e.target.value === "" ? null : +e.target.value } }); toast("Enregistré", "success"); rerender(); };
  $$("[data-who]", el).forEach((c) => {
    const who = c.dataset.who, x = d.prorata.find((y) => y.collaborator === who);
    c.querySelectorAll("input[data-k]").forEach((inp) => inp.addEventListener("change", () => {
      const np = { ...p }; np[who] = { ...(np[who] || {}), [inp.dataset.k]: inp.value === "" ? null : +inp.value }; save(np);
    }));
    c.querySelector("[data-reset]")?.addEventListener("click", async () => {
      if (!(await confirmDialog("Revenir au calcul automatique ?", `La répartition ajustée de <b>${esc(who)}</b> sera remplacée par le calcul au prorata des heures de l'équipe.`, { ok: "Revenir" }))) return;
      const np = { ...p }; np[who] = { ...(np[who] || {}) }; delete np[who].lots; save(np, "Répartition automatique rétablie");
    });
    c.querySelector("[data-edit]")?.addEventListener("click", async () => {
      const lots = await adjustDialog(x, d);
      if (!lots) return;
      const np = { ...p }; np[who] = { ...(np[who] || {}), lots }; save(np, `Répartition de ${who} enregistrée`);
    });
  });
}

/* Fenêtre de travail : ajuster lot par lot la répartition d'un collaborateur au prorata. */
function adjustDialog(x, d) {
  const who = x.collaborator;
  const cost = d.people.find((pp) => pp.collaborator === who)?.cost || 0;
  const auto = Object.fromEntries((x.auto_lots || []).map((r) => [r.lot, r]));
  const start = x.manual ? (x.lots || []).map((r) => ({ lot: r.lot, hours: r.hours })) : (x.auto_lots || []).map((r) => ({ lot: r.lot, hours: r.hours }));
  let rows = start.map((r) => ({ ...r, hours: Math.round(r.hours * 100) / 100 })).sort((a, b) => b.hours - a.hours);
  let q = "";
  let rules = {};
  try { rules = JSON.parse(S.settings.monthly_keywords || "{}"); } catch (_) { /* */ }
  const kind = (lot) => { const u = lot.toUpperCase(); for (const [k, ws] of Object.entries(rules)) if (ws.some((w) => w && u.includes(w.toUpperCase()))) return k; return "Projet"; };
  const KIND_CHIP = { Agile: "info", Support: "warning", Run: "brand", Projet: "" };
  const allLots = [...new Set([...Object.keys(auto), ...d.invoice.lines.map((l) => l.lot), ...d.prorata.flatMap((y) => (y.lots || []).map((r) => r.lot))])].sort();
  const total = () => rows.reduce((a, r) => a + (+r.hours || 0), 0);

  const body = `<div class="adj">
    <div class="adj-kpis">
      <div class="kpi"><div class="kpi-label">${icon("clock")}Total ajusté</div><div class="kpi-value" id="kTot"></div><div class="kpi-sub" id="kLots"></div></div>
      <div class="kpi"><div class="kpi-label">${icon("pie")}Calcul automatique</div><div class="kpi-value">${fmt.h(x.auto_total)}</div><div class="kpi-sub">${(x.auto_lots || []).length} lots · ${x.base === "jira" ? "heures Jira de l'équipe" : "salariés ayant un coût"}</div></div>
      <div class="kpi"><div class="kpi-label">${icon("arrowR")}Écart</div><div class="kpi-value" id="kGap"></div><div class="kpi-sub">vs calcul automatique</div></div>
      <div class="kpi"><div class="kpi-label">${icon("coins")}Coût à répartir</div><div class="kpi-value">${cost ? fmt.money0(cost) : "—"}</div><div class="kpi-sub">${cost ? "coût employeur du mois" : "charges du mois pas encore chargées"}</div></div>
    </div>
    <div class="row adj-tools">
      <div class="input-icon" style="flex:1;min-width:200px;max-width:340px">${icon("search")}<input id="aq" placeholder="Filtrer les lots…"></div>
      <div style="flex:1;min-width:220px;max-width:380px"><input id="aadd" placeholder="+ Ajouter un lot…"></div>
      <div style="flex:1"></div>
      <button class="btn sm" id="aauto" type="button">${icon("history")}Repartir du calcul automatique</button>
      <button class="btn sm" id="ascale" type="button" title="Garde les proportions, ramène le total au calcul automatique">${icon("layers")}Ramener au total auto</button>
    </div>
    <div class="table-wrap adj-table"><table class="t"><thead><tr>
      <th>Lot</th><th>Type</th><th class="num">Heures équipe</th><th class="num">Auto</th><th class="num" style="width:150px">Ajusté (h)</th><th class="num">Écart</th><th class="num">Part</th><th class="num">Coût estimé</th><th></th></tr></thead>
      <tbody id="abody"></tbody></table></div>
    <p class="xs faint" style="margin:10px 0 0">Seules les proportions comptent : le coût de ${esc(who)} est réparti selon la part de chaque lot. Entrée = lot suivant.</p></div>`;

  return modal({
    title: `Ajuster la répartition — ${esc(who)}`, size: "wide", body,
    actions: [{ label: "Annuler" }, { label: "Enregistrer et fermer", kind: "primary", icon: "check", onClick: () => {
      const lots = {};
      rows.forEach((r) => { const h = +r.hours || 0; if (h > 0) lots[r.lot] = Math.round(((lots[r.lot] || 0) + h) * 100) / 100; });
      if (!Object.keys(lots).length) { toast("Indiquez des heures sur au moins un lot.", "error"); return false; }
      return lots;
    } }],
    onMount: (ctx) => {
      const el = ctx.el;
      const sums = () => {
        const t = total(), a = x.auto_total || 0, g = t - a;
        $("#kTot", el).textContent = fmt.h(t);
        $("#kLots", el).textContent = `${rows.filter((r) => +r.hours > 0).length} lots`;
        $("#kGap", el).innerHTML = `<span style="color:${Math.abs(g) < 0.05 ? "var(--success)" : "var(--warning)"}">${g > 0 ? "+" : ""}${fmt.num(g)} h</span>`;
        $$("#abody tr[data-i]", el).forEach((tr) => {
          const r = rows[+tr.dataset.i], h = +r.hours || 0, au = auto[r.lot]?.hours || 0, share = t ? h / t : 0;
          tr.querySelector(".c-gap").innerHTML = Math.abs(h - au) < 0.005 ? '<span class="faint">—</span>' : `<span style="color:${h > au ? "var(--success)" : "var(--danger)"}">${h > au ? "+" : ""}${fmt.num(h - au)}</span>`;
          tr.querySelector(".c-share").innerHTML = `<div class="share"><div style="width:${Math.min(share * 100 * 3, 100)}%"></div><span>${fmt.pct(share, 1)}</span></div>`;
          tr.querySelector(".c-cost").textContent = cost ? fmt.money0(cost * share) : "—";
        });
      };
      const draw = () => {
        const w = q.toLowerCase();
        $("#abody", el).innerHTML = rows.map((r, i) => ({ r, i })).filter(({ r }) => !w || r.lot.toLowerCase().includes(w)).map(({ r, i }) => {
          const k = kind(r.lot), a = auto[r.lot];
          return `<tr data-i="${i}"><td style="max-width:420px"><div class="ellipsis" title="${esc(r.lot)}" style="font-weight:550">${esc(r.lot)}</div></td>
            <td>${chip(k, KIND_CHIP[k])}</td><td class="num faint">${a ? fmt.num(a.base_hours) : "—"}</td><td class="num">${a ? fmt.num(a.hours) : '<span class="faint">—</span>'}</td>
            <td class="num"><div class="stepper" style="justify-content:flex-end"><button type="button" data-st="-0.5" aria-label="Moins">${icon("minus")}</button><input class="a-h" inputmode="decimal" value="${String(r.hours).replace(".", ",")}" aria-label="Heures ajustées"><button type="button" data-st="0.5" aria-label="Plus">${icon("plus")}</button></div></td>
            <td class="num c-gap"></td><td class="c-share" style="min-width:120px"></td><td class="num c-cost"></td>
            <td class="actions"><button class="icon-btn" data-rm aria-label="Retirer le lot">${icon("x")}</button></td></tr>`;
        }).join("") || `<tr><td colspan="9">${empty("Aucun lot", "Ajoutez un lot ou repartez du calcul automatique.", "layers")}</td></tr>`;
        $$("#abody tr[data-i]", el).forEach((tr) => {
          const i = +tr.dataset.i, inp = tr.querySelector(".a-h");
          inp.addEventListener("input", () => { rows[i].hours = fmt.parse(inp.value) || 0; sums(); });
          inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const all = $$(".a-h", el); all[all.indexOf(inp) + 1]?.focus(); all[all.indexOf(inp) + 1]?.select(); } });
          inp.addEventListener("focus", () => inp.select());
          tr.querySelectorAll("[data-st]").forEach((b) => (b.onclick = () => { rows[i].hours = Math.max(0, Math.round(((+rows[i].hours || 0) + +b.dataset.st) * 100) / 100); inp.value = String(rows[i].hours).replace(".", ","); sums(); }));
          tr.querySelector("[data-rm]").onclick = () => { rows.splice(i, 1); draw(); };
        });
        sums();
      };
      $("#aq", el).oninput = (e) => { q = e.target.value; draw(); };
      combobox($("#aadd", el), () => allLots.filter((l) => !rows.some((r) => r.lot === l)).map((l) => ({ value: l, label: l, tag: kind(l) })), (o) => {
        rows.unshift({ lot: o.value, hours: 0 }); $("#aadd", el).value = ""; draw(); $(".a-h", el)?.focus();
      });
      $("#aauto", el).onclick = () => { rows = (x.auto_lots || []).map((r) => ({ lot: r.lot, hours: Math.round(r.hours * 100) / 100 })); draw(); toast("Calcul automatique rechargé", "info"); };
      $("#ascale", el).onclick = () => {
        const t = total(); if (!t) return;
        const f = (x.auto_total || t) / t; rows.forEach((r) => (r.hours = Math.round((+r.hours || 0) * f * 100) / 100)); draw();
      };
      draw();
    },
  });
}

// =================================================================== CAPEX & FRAIS GÉNÉRAUX
async function tabFrais(el, d, m, locked) {
  const hist = S.months.filter((x) => x.month < m && (x.dap || x.frais_generaux)).slice(0, 8);
  const v = d.params;
  el.innerHTML = `<div class="grid g2">
    <div class="card"><div class="card-head"><div class="grow"><h2>Dépenses du mois</h2><div class="desc">Réparties sur chaque lot au prorata de son coût salarial.</div></div></div>
      <div class="card-body stack">
        <div class="field"><label>CAPEX — DAP (dotation aux amortissements)</label><input class="xl" data-k="dap" inputmode="decimal" value="${fmt.money(v.dap || 0)}" ${locked ? "disabled" : ""}></div>
        <div class="field"><label>Frais généraux (OPEX)</label><input class="xl" data-k="frais_generaux" inputmode="decimal" value="${fmt.money(v.frais_generaux || 0)}" ${locked ? "disabled" : ""}></div>
        <div class="alert alert-info">${icon("layers")}<div class="grow row between"><span>Total réparti sur les projets</span><b>${fmt.money(d.invoice.overhead)}</b></div></div></div></div>
    <div class="card"><div class="card-head"><h2>Facture</h2></div><div class="card-body">
      <div class="form-grid"><div class="field"><label>Date de facture</label><input type="date" data-k="invoice_date" value="${v.invoice_date || d.invoice.date}" ${locked ? "disabled" : ""}></div>
      <div class="field"><label>N° de facture</label><input data-k="invoice_number" value="${esc(v.invoice_number || "")}" placeholder="${esc(d.invoice.number)} (auto)" ${locked ? "disabled" : ""}></div>
      <div class="field"><label>Cost + (%)</label><input data-k="cost_plus" inputmode="decimal" value="${(v.cost_plus * 100).toFixed(2).replace(".", ",")}" ${locked ? "disabled" : ""}></div></div>
      <p class="xs faint" style="margin-top:8px">N° par défaut : numéro de série Excel de la date, comme dans le classeur d'origine.</p>
      <h3 style="margin-top:18px">Mois précédents</h3>
      <table class="t"><thead><tr><th>Mois</th><th class="num">DAP</th><th class="num">Frais généraux</th></tr></thead><tbody>${hist.map((x) => `<tr><td>${month.label(x.month)}</td><td class="num">${fmt.money(x.dap)}</td><td class="num">${fmt.money(x.frais_generaux)}</td></tr>`).join("") || `<tr><td colspan="3" class="faint">—</td></tr>`}</tbody></table></div></div></div>`;
  if (locked) return;
  $$("input[data-k]", el).forEach((inp) => inp.addEventListener("change", async () => {
    const k = inp.dataset.k; let val = inp.value.trim();
    if (["dap", "frais_generaux", "cost_plus"].includes(k)) { val = fmt.parse(val) || 0; if (k === "cost_plus") val /= 100; }
    await api(`/api/months/${m}`, { method: "PUT", json: { [k]: val } }); toast("Enregistré", "success"); S.months = await api("/api/months"); rerender();
  }));
}

// =================================================================== CONTRÔLES
async function tabControles(el, d, m, locked) {
  const grp = { error: [], warning: [], info: [] };
  d.issues.forEach((i) => grp[i.level].push(i));
  const LBL = { error: "Bloquants", warning: "À vérifier", info: "Informations" };
  const ICN = { error: "error", warning: "alert", info: "info" };
  el.innerHTML = `${d.blocking ? `<div class="alert alert-danger" style="margin-bottom:16px">${icon("error")}<div class="grow"><div class="alert-title">${grp.error.length} point(s) bloquant(s)</div>La facture ne peut pas être validée tant qu'ils ne sont pas corrigés.</div></div>` : `<div class="alert alert-success" style="margin-bottom:16px">${icon("check")}<div class="grow"><div class="alert-title">Aucun point bloquant</div>La facture peut être validée.</div>${can("invoice") && !locked ? `<button class="btn success sm" id="goInv">Voir la facture</button>` : ""}</div>`}
  ${["error", "warning", "info"].filter((l) => grp[l].length).map((l) => `<div class="card" style="margin-bottom:16px"><div class="card-head"><h2>${LBL[l]} <span class="faint">${grp[l].length}</span></h2></div>
    ${grp[l].map((i) => `<div class="issue issue-${l}" data-idx="${d.issues.indexOf(i)}"><div class="issue-ic">${icon(ICN[l])}</div><div class="grow" style="min-width:0;flex:1">
      <div class="row between" style="align-items:flex-start"><div class="issue-msg" style="flex:1;min-width:220px">${esc(i.message)}</div><div class="toolbar">${actionsFor(i, locked)}</div></div>
      ${i.details.length ? `<details><summary>${i.details.length} ligne(s) concernée(s)</summary><div class="table-wrap" style="max-height:240px;margin-top:8px"><table class="t"><thead><tr><th>Collaborateur</th><th>Ticket</th><th>Résumé</th><th class="num">Heures</th></tr></thead><tbody>
        ${i.details.map((x) => `<tr><td>${esc(x.collaborator)}</td><td class="mono">${esc(x.issue_key)}</td><td class="small">${esc(x.summary)}</td><td class="num">${fmt.num(x.hours)}</td></tr>`).join("")}</tbody></table></div>
        ${i.code === "no_epic" ? `<div class="row small" style="margin-top:8px">Tickets à transmettre au chef de projet : <code class="mono">${esc(i.details.map((x) => x.issue_key).filter(Boolean).join(", "))}</code><button class="btn sm ghost" data-copy="${esc(i.details.map((x) => x.issue_key).filter(Boolean).join(", "))}">${icon("copy")}Copier</button></div>` : ""}</details>` : ""}
    </div></div>`).join("")}</div>`).join("")}
  <div class="card card-pad"><h3>Règles appliquées</h3><ul class="small muted" style="margin:0;padding-left:18px;line-height:1.8">
    <li>Chaque ligne de temps doit avoir une epic connue (ou un lot affecté à la main).</li>
    <li>Un projet en ligne (ou abandonné) à une date ne peut plus recevoir d'heures sur un mois postérieur.</li>
    <li>Le coût de chaque collaborateur doit être entièrement réparti : un coût sans heures est bloquant.</li>
    <li>Coûts négatifs, collaborateurs inconnus et heures hors norme sont signalés.</li></ul></div>`;
  $("#goInv", el)?.addEventListener("click", () => go(`mois/${m}/facture`));
  $$("[data-copy]", el).forEach((b) => (b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copy); toast("Copié", "success"); }));
  $$("[data-act]", el).forEach((b) => (b.onclick = () => doAction(b.dataset.act, d.issues[+b.closest("[data-idx]").dataset.idx], m)));
}

function actionsFor(i, locked) {
  if (locked) return "";
  const b = (act, label, kind = "", ic = "") => `<button class="btn sm ${kind}" data-act="${act}">${ic ? icon(ic) : ""}${label}</button>`;
  return {
    no_epic: can("time.all") ? b("assign", "Affecter un lot", "", "link") : "",
    unknown_epic: can("ref") ? b("addEpic", "Ajouter l'epic", "primary", "plus") + (can("time.all") ? b("assign", "Affecter un lot") : "") : "",
    closed_project: (can("time.all") ? b("assign", "Réaffecter") : "") + (can("ref") ? b("reopenProject", "Repasser en cours") : ""),
    cost_not_allocated: b("goTemps", "Voir les temps"),
    no_costs: can("costs") ? b("goCharges", "Charger les coûts", "primary", "upload") : "",
    no_timesheet: can("time.all") ? b("goTemps", "Importer le timesheet", "primary", "upload") : "",
    unknown_collaborator: can("ref") ? b("goCollabs", "Référentiel") : "",
  }[i.code] || "";
}

async function lotPicker(title, initial = "", m = month.current()) {
  // uniquement les projets encore ouverts ce mois-ci
  const opts = (await api(`/api/lots/options?month=${m}`)).map((o) => ({ value: o.lot, label: o.lot, sub: o.kind === "epic" ? o.value : "projet", tag: o.category }));
  return modal({
    title, size: "md", body: `<div class="field"><label>Lot facturé</label><input id="lp" value="${esc(initial)}" placeholder="Rechercher…" autofocus></div><p class="xs faint" style="margin-top:8px">Pour un lot mensuel (support, évolutions mineures), le suffixe « - MM/AA » est ajouté automatiquement s'il manque.</p>`,
    onMount: (ctx) => combobox($("#lp", ctx.el), () => opts),
    actions: [{ label: "Annuler" }, { label: "Affecter", kind: "primary", onClick: (ctx) => $("#lp", ctx.el).value.trim() || false }],
  });
}

async function doAction(act, i, m) {
  if (act === "goTemps") return go(`mois/${m}/temps`);
  if (act === "goCharges") return go(`mois/${m}/charges`);
  if (act === "goCollabs") return go("collaborateurs");
  if (act === "assign") {
    let lot = await lotPicker(`Affecter ${i.details.length} ligne(s) à un lot`, i.lot || "", m);
    if (!lot) return;
    let rules = {};
    try { rules = JSON.parse(S.settings.monthly_keywords || "{}"); } catch (_) { /* */ }
    const isMonthly = Object.values(rules).flat().some((w) => w && lot.toUpperCase().includes(w.toUpperCase()));
    const sfx = `${m.slice(5)}/${m.slice(2, 4)}`;
    if (isMonthly && !/ - \d{2}\/\d{2}$/.test(lot)) lot = `${lot} - ${sfx}`;
    await api("/api/entries/bulk-lot", { method: "POST", json: { ids: i.details.map((x) => x.id), lot } });
    toast(`Lignes affectées à « ${lot} »`, "success"); return rerender();
  }
  if (act === "addEpic") {
    const r = await formDialog("Ajouter l'epic au référentiel", [
      { name: "label", label: "Epic", value: i.epic, required: true, full: true },
      { name: "lot_name", label: "Lot facturé (JIRA NAME)", value: i.epic.replace(/^[A-Z0-9]+-\d+:\s*/, ""), required: true, full: true },
      { name: "category", label: "Catégorie", type: "select", options: ["Project", "Agile", "Support", "CX", "Innovation Forum", "CRO", "BI"], value: "Project", help: "Le caractère mensuel du lot dépend de son nom (Paramètres › Lots facturés au mois)." },
      { name: "status", label: "Statut", type: "select", options: [["IN PROGRESS", "En cours"], ["PRODUCTION", "En ligne"]], value: "IN PROGRESS" },
    ], { ok: "Ajouter" });
    if (!r) return;
    await api("/api/ref/epics", { method: "POST", json: r }); toast("Epic ajoutée", "success"); return rerender();
  }
  if (act === "reopenProject") {
    if (!(await confirmDialog("Repasser le projet en cours ?", `« ${esc(i.lot)} » sera marqué <b>En cours</b>, sans date de mise en ligne.`))) return;
    const [ps, es] = await Promise.all([api("/api/ref/projects"), api("/api/ref/epics")]);
    const p = ps.find((x) => x.lot.toLowerCase() === i.lot.toLowerCase());
    if (p) await api("/api/ref/projects", { method: "POST", json: { ...p, _original: p.lot, status: "IN PROGRESS", mel_date: null } });
    const ep = es.find((x) => x.lot_name.toLowerCase() === i.lot.toLowerCase() && x.status !== "IN PROGRESS");
    if (ep) await api("/api/ref/epics", { method: "POST", json: { ...ep, _original: ep.epic_key, status: "IN PROGRESS", mel_date: null } });
    toast("Projet réouvert", "success"); return rerender();
  }
}

// =================================================================== FACTURE
const open = new Set();
let showInternal = true;
async function tabFacture(el, d, m, locked) {
  const inv = d.invoice, st = S.settings;
  const secs = [["projet", "Projets & évolutions"], ["support", "Support & bug fixes"]];
  const line = (l) => `<tr class="clickable" data-lot="${esc(l.lot)}"><td><span class="faint">${open.has(l.lot) ? "▾" : "▸"}</span> ${esc(l.lot)}</td><td class="hide-mobile">${statusChip(l.status)}</td><td class="hide-mobile nowrap">${esc(l.date_label)}</td>
      <td class="num"><b>${fmt.money(l.price)}</b></td><td class="num internal">${fmt.money(l.salary)}</td><td class="num internal">${fmt.pct(l.pct, 2)}</td><td class="num internal">${fmt.money(l.overhead)}</td></tr>`
    + (open.has(l.lot) ? l.detail.map((x) => `<tr class="det"><td colspan="3" style="padding-left:30px">${esc(x.collaborator)} · ${fmt.num(x.hours)} h</td><td></td><td class="num internal">${fmt.money(x.cost)}</td><td class="internal"></td><td class="internal"></td></tr>`).join("") : "");
  el.innerHTML = `<div class="row no-print" style="margin-bottom:14px">
      <div class="seg"><button class="${showInternal ? "on" : ""}" data-int="1">Vue détaillée</button><button class="${showInternal ? "" : "on"}" data-int="0">Vue client</button></div>
      <div style="flex:1"></div>
      <button class="btn" onclick="window.print()">${icon("printer")}<span class="hide-mobile">Imprimer / </span>PDF</button>
      ${locked ? "" : can("invoice") ? `${d.blocking ? `<button class="btn" id="force">Valider malgré les alertes</button>` : ""}<button class="btn success" id="val" ${d.blocking ? "disabled" : ""}>${icon("lock")}Valider la facture</button>` : ""}</div>
    ${d.blocking && !locked ? `<div class="alert alert-warning no-print" style="margin-bottom:14px">${icon("alert")}<div class="grow">Aperçu provisoire : il reste des contrôles bloquants. <a href="#/mois/${m}/controles">Voir les contrôles</a></div></div>` : ""}
    <div class="invoice ${showInternal ? "" : "hide-internal"}">
      <div class="inv-top"><div><div class="inv-title">INVOICE</div><div style="font-weight:700;margin-top:6px">${esc(st.issuer_name)}</div></div>
        <dl class="inv-meta"><dt>Date</dt><dd>${fmt.date(inv.date)}</dd><dt>Invoice n°</dt><dd>${esc(inv.number)}</dd><dt>Réf. client</dt><dd>${esc(st.client_ref)}</dd></dl>
        <dl class="inv-meta internal"><dt>DAP</dt><dd class="num">${fmt.money(inv.dap)}</dd><dt>Frais généraux</dt><dd class="num">${fmt.money(inv.frais_generaux)}</dd><dt>Total</dt><dd class="num">${fmt.money(inv.overhead)}</dd></dl></div>
      <div class="inv-parties"><div><div class="lbl">Invoiced for</div><b>${esc(st.client_name)}</b><br>${esc(st.client_address).replace(/\n/g, "<br>")}<br><span class="faint">${esc(st.client_id)}</span></div>
        <div><div class="lbl">Sent to</div><b>${esc(st.client_name)}</b><br>${esc(st.client_address).replace(/\n/g, "<br>")}</div></div>
      ${inv.lines.length ? `<div class="table-wrap" style="max-height:none"><table class="t inv-lines"><thead><tr><th>Projects</th><th class="hide-mobile">Statut</th><th class="hide-mobile">Date</th><th class="num">Price</th><th class="num internal">Projet salaires</th><th class="num internal">%</th><th class="num internal">DAP + op. cost</th></tr></thead><tbody>
        ${secs.map(([k, label]) => { const ls = inv.lines.filter((l) => l.section === k); return ls.length ? `<tr class="sec"><td colspan="7">${label} · ${ls.length} lots</td></tr>` + ls.map(line).join("") : ""; }).join("")}
        <tr class="tot"><td>Sub total</td><td class="hide-mobile"></td><td class="hide-mobile"></td><td class="num">${fmt.money(inv.subtotal.price)}</td><td class="num internal">${fmt.money(inv.subtotal.salary)}</td><td class="internal"></td><td class="num internal">${fmt.money(inv.subtotal.overhead)}</td></tr>
        <tr class="tot"><td>Cost + ${Math.round(inv.cost_plus_rate * 100)} %</td><td class="hide-mobile"></td><td class="hide-mobile"></td><td class="num">${fmt.money(inv.cost_plus.price)}</td><td class="num internal">${fmt.money(inv.cost_plus.salary)}</td><td class="internal"></td><td class="num internal">${fmt.money(inv.cost_plus.overhead)}</td></tr>
        <tr class="grand"><td>Total</td><td class="hide-mobile"></td><td class="hide-mobile"></td><td class="num">${fmt.money(inv.total.price)}</td><td class="num internal">${fmt.money(inv.total.salary)}</td><td class="internal"></td><td class="num internal">${fmt.money(inv.total.overhead)}</td></tr>
      </tbody></table></div>` : empty("Facture vide", "Importez les temps et les charges du mois.", "invoice")}
      <div class="inv-foot">${esc(st.issuer_footer)}</div></div>`;
  $$("[data-int]", el).forEach((b) => (b.onclick = () => { showInternal = b.dataset.int === "1"; tabFacture(el, d, m, locked); }));
  $$("tr[data-lot]", el).forEach((tr) => (tr.onclick = () => { const l = tr.dataset.lot; open.has(l) ? open.delete(l) : open.add(l); tabFacture(el, d, m, locked); }));
  const validate = async (force) => {
    if (!(await confirmDialog(force ? "Valider malgré les alertes ?" : "Valider la facture ?", `Total <b>${fmt.money(inv.total.price)}</b>. Le mois sera figé et les lots mensuels inscrits comme livrés au ${fmt.date(inv.date)}.`, { ok: "Valider", danger: force }))) return;
    await api(`/api/months/${m}/validate?force=${force}`, { method: "POST" });
    toast("Facture validée", "success"); S.months = await api("/api/months"); updateNavBadge(); rerender();
  };
  $("#val", el)?.addEventListener("click", () => validate(false));
  $("#force", el)?.addEventListener("click", () => validate(true));
}
