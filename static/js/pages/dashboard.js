import { S, api, can, esc, fmt, icon, month, statusChip, empty, formDialog } from "../core.js";
import { go, updateNavBadge } from "../app.js";

export async function render(view) {
  view.innerHTML = `<div class="skel-wrap"><div class="skel" style="height:90px"></div><div class="skel" style="height:240px"></div></div>`;
  const ms = (S.months = await api("/api/months"));
  updateNavBadge();
  if (!ms.length) {
    view.innerHTML = `<div class="page-head"><div class="grow"><h1>Bienvenue ${esc(S.user.display_name.split(" ")[0])}</h1><div class="sub">Votre espace est prêt. Trois étapes pour démarrer.</div></div></div>
      <div class="grid g3">
        ${[["upload", "1. Reprendre vos fichiers Excel", "Facturation Paris, Charge Patronale et le dernier timesheet : l'historique est chargé et chaque facture recalculée.", "parametres", "Ouvrir la reprise", can("settings")],
           ["shield", "2. Créer les comptes de l'équipe", "Un compte par collaborateur pour qu'il saisisse ses temps, et les rôles Finance / Chef de projet.", "comptes", "Gérer les comptes", can("users")],
           ["invoice", "3. Préparer la facture du mois", "Import du timesheet avec vérification, charges, CAPEX et frais généraux, contrôles.", `mois/${month.current()}/temps`, "Commencer", can("time.all")]]
          .filter((x) => x[5]).map(([ic, t, d, href, cta]) => `<div class="card card-pad"><div class="drop-ic" style="margin:0 0 12px">${icon(ic)}</div><h2>${t}</h2><p class="small muted" style="margin:6px 0 14px">${d}</p><a class="btn primary" href="#/${href}">${cta}</a></div>`).join("")}
      </div>`;
    return;
  }
  const draft = ms.find((m) => m.status === "draft");
  const validated = ms.filter((m) => m.total);
  const last = validated[0];
  const year = (last?.month || month.current()).slice(0, 4);
  const ytd = validated.filter((m) => m.month.startsWith(year)).reduce((a, m) => a + m.total, 0);
  const prevYear = validated.filter((m) => m.month.startsWith(String(+year - 1))).reduce((a, m) => a + m.total, 0);
  const chart = ms.slice(0, 18).reverse();
  const max = Math.max(1, ...chart.map((m) => m.total || 0));
  const avg = validated.slice(0, 6).reduce((a, m) => a + m.total, 0) / Math.max(1, Math.min(6, validated.length));
  const draftDetail = draft ? await api(`/api/months/${draft.month}`).catch(() => null) : null;
  const errs = draftDetail ? draftDetail.issues.filter((i) => i.level === "error").length : 0;

  view.innerHTML = `
  <div class="page-head"><div class="grow"><h1>Bonjour ${esc(S.user.display_name.split(" ")[0])}</h1><div class="sub">Vue d'ensemble de la refacturation par projet.</div></div>
    <div class="toolbar">${can("time.all") ? `<button class="btn" id="newMonth">${icon("plus")}Nouveau mois</button>` : ""}
    ${draft ? `<a class="btn primary" href="#/mois/${draft.month}">${icon("arrowR")}Reprendre ${month.label(draft.month)}</a>` : ""}</div></div>

  ${draft && draftDetail ? `<div class="card card-pad" style="margin-bottom:16px">
    <div class="row between"><div><div class="muted small">Mois en cours</div><div style="font-size:18px;font-weight:700">${month.label(draft.month)}</div></div>
    ${errs ? `<span class="chip chip-danger">${icon("alert")}${errs} point${errs > 1 ? "s" : ""} bloquant${errs > 1 ? "s" : ""}</span>` : `<span class="chip chip-success">${icon("check")}Prête à valider</span>`}</div>
    <div class="grid g4" style="margin-top:14px">
      ${progressStep("Temps", draftDetail.stats.entries > 0, `${fmt.num(draftDetail.stats.hours)} h · ${draftDetail.people.filter((p) => p.hours).length} pers.`, `mois/${draft.month}/temps`)}
      ${progressStep("Charges", draftDetail.stats.cost_total !== 0, draftDetail.stats.cost_total ? fmt.money0(draftDetail.stats.cost_total) : "à charger", `mois/${draft.month}/charges`)}
      ${progressStep("CAPEX & FG", draftDetail.invoice.overhead > 0, draftDetail.invoice.overhead ? fmt.money0(draftDetail.invoice.overhead) : "à saisir", `mois/${draft.month}/frais`)}
      ${progressStep("Facture", !draftDetail.blocking && draftDetail.invoice.lines.length > 0, draftDetail.invoice.lines.length ? fmt.money0(draftDetail.invoice.total.price) : "—", `mois/${draft.month}/facture`)}
    </div></div>` : ""}

  <div class="grid g4" style="margin-bottom:16px">
    ${kpi("coins", `Facturé ${year}`, fmt.money0(ytd), `${validated.filter((m) => m.month.startsWith(year)).length} factures${prevYear ? ` · ${year - 1} : ${fmt.money0(prevYear)}` : ""}`)}
    ${kpi("invoice", "Dernière facture", fmt.money0(last?.total), last ? month.label(last.month) : "—")}
    ${kpi("pie", "Moyenne 6 mois", fmt.money0(avg), "montant cost + inclus")}
    ${kpi("layers", "Lots facturés", last?.lines ?? "—", last ? `en ${month.label(last.month)}` : "")}
  </div>

  <div class="grid g-side">
    <div class="card"><div class="card-head"><div class="grow"><h2>Montant facturé par mois</h2><div class="desc">${esc(S.settings.currency || "")} · cost + inclus · survolez une barre</div></div></div>
      <div class="card-body">${chart.length ? `<div class="chart">${chart.map((m) => `<div class="chart-col" data-go="mois/${m.month}">
          <div class="chart-bar ${m.total ? "" : "draft"}" style="height:${m.total ? Math.max(4, (m.total / max) * 100) : 6}%"><span class="chart-tip">${month.label(m.month)} · ${m.total ? fmt.money0(m.total) : "brouillon"}</span></div>
          <span class="chart-lbl">${m.month.slice(5)}/${m.month.slice(2, 4)}</span></div>`).join("")}</div>` : empty("Aucune facture", "Créez votre premier mois.", "invoice")}</div></div>
    <div class="card"><div class="card-head"><h2>Coûts du dernier mois</h2></div><div class="card-body">${last ? `<dl class="kv">
      <dt>Coût salarial</dt><dd>${fmt.money0(last.salary)}</dd>
      <dt>DAP (CAPEX)</dt><dd>${fmt.money0(last.dap)}</dd>
      <dt>Frais généraux</dt><dd>${fmt.money0(last.frais_generaux)}</dd>
      <dt>Cost +</dt><dd>${fmt.money0(last.total - (last.salary + last.dap + last.frais_generaux))}</dd>
      <dt style="font-weight:700;color:var(--text)">Total</dt><dd style="font-weight:800">${fmt.money0(last.total)}</dd></dl>
      ${donut([[last.salary, "var(--brand)"], [last.dap + last.frais_generaux, "#22d3ee"], [last.total - (last.salary + last.dap + last.frais_generaux), "#f59e0b"]])}
      <div class="row small muted" style="justify-content:center;gap:14px"><span><span class="dot" style="background:var(--brand)"></span> Salaires</span><span><span class="dot" style="background:#22d3ee"></span> DAP + FG</span><span><span class="dot" style="background:#f59e0b"></span> Cost +</span></div>` : empty("—")}</div></div>
  </div>

  <div class="card" style="margin-top:16px"><div class="card-head"><div class="grow"><h2>Historique des factures</h2></div></div>
    <div class="table-wrap"><table class="t responsive"><thead><tr><th>Mois</th><th>Statut</th><th class="num">Lots</th><th class="num">Coût salarial</th><th class="num">DAP</th><th class="num">Frais généraux</th><th class="num">Total</th></tr></thead>
    <tbody>${ms.map((m) => `<tr class="clickable" data-go="mois/${m.month}"><td class="primary-cell" data-l="Mois"><strong>${month.label(m.month)}</strong></td><td data-l="Statut">${statusChip(m.status)}</td>
      <td class="num" data-l="Lots">${m.lines ?? "—"}</td><td class="num" data-l="Coût salarial">${fmt.money(m.salary)}</td><td class="num" data-l="DAP">${fmt.money(m.dap)}</td><td class="num" data-l="Frais généraux">${fmt.money(m.frais_generaux)}</td><td class="num" data-l="Total"><strong>${fmt.money(m.total)}</strong></td></tr>`).join("")}</tbody></table></div></div>`;

  view.querySelectorAll("[data-go]").forEach((el) => el.addEventListener("click", () => go(el.dataset.go)));
  view.querySelector("#newMonth")?.addEventListener("click", async () => {
    const latest = ms[0]?.month;
    const d = await formDialog("Nouveau mois à facturer", [{ name: "m", label: "Mois", type: "month", value: latest ? month.next(latest) : month.current(), required: true, full: true }], { ok: "Créer" });
    if (d && month.valid(d.m)) go(`mois/${d.m}/temps`);
  });
}

const kpi = (ic, label, value, sub) => `<div class="kpi"><div class="kpi-label">${icon(ic)}${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
const progressStep = (label, done, sub, href) => `<a href="#/${href}" class="kpi" style="text-decoration:none;color:inherit;display:flex;gap:12px;align-items:center">
  <span class="step-n" style="width:28px;height:28px;${done ? "background:var(--success);color:#fff" : ""}">${done ? icon("check") : icon("minus")}</span>
  <div style="min-width:0"><div style="font-weight:650">${label}</div><div class="faint small ellipsis">${sub}</div></div></a>`;

function donut(parts) {
  const total = parts.reduce((a, [v]) => a + Math.max(v, 0), 0) || 1;
  let acc = 0; const r = 52, c = 2 * Math.PI * r;
  return `<svg viewBox="0 0 140 140" style="width:150px;display:block;margin:16px auto 10px">${parts.map(([v, col]) => {
    const len = (Math.max(v, 0) / total) * c; const s = `<circle cx="70" cy="70" r="${r}" fill="none" stroke="${col}" stroke-width="18" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-acc}" transform="rotate(-90 70 70)"/>`; acc += len; return s;
  }).join("")}</svg>`;
}
