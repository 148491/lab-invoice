/* Administration : comptes & droits, journal, paramètres. */
import { $, $$, S, api, esc, fmt, icon, chip, empty, modal, field, toast, avatar, dropzone, debounce, confirmDialog } from "../core.js";
import { rerender } from "../app.js";

export async function render(view, { arg }) {
  if (arg === "users") return users(view);
  if (arg === "audit") return audit(view);
  return settings(view);
}

const PERM_LABEL = { view: "Consulter factures et tableau de bord", "time.self": "Saisir ses temps", "time.all": "Gérer les temps de tous", costs: "Charges employeur", invoice: "CAPEX / FG et validation des factures", ref: "Référentiels", users: "Comptes et paramètres" };

async function users(view) {
  const [{ users, roles }, collabs] = await Promise.all([api("/api/users"), api("/api/ref/collaborators")]);
  view.innerHTML = `<div class="page-head"><div class="grow"><div class="crumbs">${icon("shield")}Administration</div><h1>Comptes & droits</h1><div class="sub">Qui peut se connecter et ce que chacun peut faire.</div></div>
      <div class="toolbar"><button class="btn" id="bulk">${icon("users")}Créer les comptes de l'équipe</button><button class="btn primary" id="add">${icon("userPlus")}Nouveau compte</button></div></div>
    <div class="grid g4" style="margin-bottom:16px">${Object.entries(roles).map(([k, r]) => `<div class="kpi"><div class="kpi-label">${icon(k === "admin" ? "shield" : k === "collaborateur" ? "clock" : "users")}${esc(r.label)}</div><div class="kpi-value">${users.filter((u) => u.role === k && u.active).length}</div><div class="kpi-sub">${r.perms.map((p) => PERM_LABEL[p]).filter(Boolean).slice(0, 3).join(" · ")}${r.perms.length > 3 ? "…" : ""}</div></div>`).join("")}</div>
    <div class="card"><div class="table-wrap tall"><table class="t responsive"><thead><tr><th>Utilisateur</th><th>Identifiant</th><th>Rôle</th><th>Collaborateur rattaché</th><th>Dernière connexion</th><th>Statut</th><th></th></tr></thead><tbody>
    ${users.map((u, i) => `<tr class="clickable" data-i="${i}"><td class="primary-cell" data-l=""><div class="person">${avatar(u.display_name)}<b>${esc(u.display_name)}</b></div></td><td data-l="Identifiant" class="mono">${esc(u.username)}</td>
      <td data-l="Rôle">${chip(u.role_label, u.role === "admin" ? "brand" : "")}</td><td data-l="Collaborateur">${u.collaborator ? esc(u.collaborator) : '<span class="faint">—</span>'}</td>
      <td data-l="Connexion" class="small">${u.last_login ? fmt.datetime(u.last_login) : '<span class="faint">jamais</span>'}</td><td data-l="Statut">${u.active ? (u.must_change ? chip("Mot de passe à changer", "warning") : chip("Actif", "success")) : chip("Désactivé")}</td><td class="actions">${icon("chevR", "faint")}</td></tr>`).join("")}
    </tbody></table></div></div>
    <div class="card card-pad" style="margin-top:16px"><h3>Droits par rôle</h3><div class="table-wrap"><table class="t"><thead><tr><th>Droit</th>${Object.values(roles).map((r) => `<th style="text-align:center">${esc(r.label)}</th>`).join("")}</tr></thead><tbody>
      ${Object.entries(PERM_LABEL).map(([p, l]) => `<tr><td>${l}</td>${Object.values(roles).map((r) => `<td style="text-align:center">${r.perms.includes(p) ? `<span style="color:var(--success)">${icon("check")}</span>` : '<span class="faint">—</span>'}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>`;
  const roleOpts = Object.entries(roles).map(([k, r]) => [k, r.label]);
  const collabOpts = [["", "— Aucun —"], ...collabs.filter((c) => c.active).map((c) => [c.name, c.name])];
  const userForm = (u) => modal({
    title: u ? u.display_name : "Nouveau compte", size: "md",
    body: `<form class="form-grid" onsubmit="return false">
      ${field({ name: "display_name", label: "Nom affiché", value: u?.display_name, required: true })}
      ${u ? `<div class="field"><label>Identifiant</label><input value="${esc(u.username)}" disabled></div>` : field({ name: "username", label: "Identifiant", required: true, help: "prenom.nom par exemple" })}
      ${field({ name: "role", label: "Rôle", type: "select", options: roleOpts, value: u?.role || "collaborateur" })}
      ${field({ name: "collaborator", label: "Collaborateur rattaché", type: "select", options: collabOpts, value: u?.collaborator || "", help: "Pour saisir ses propres temps." })}
      ${field({ name: "password", label: u ? "Nouveau mot de passe (facultatif)" : "Mot de passe provisoire", type: "text", required: !u, minlength: 8, value: u ? "" : genPassword(), help: "La personne devra le changer à sa première connexion.", full: true })}
      ${u ? field({ name: "active", label: "Compte actif", type: "checkbox", value: u.active, full: true }) : ""}</form>`,
    actions: [{ label: "Annuler" }, { label: "Enregistrer", kind: "primary", onClick: async (ctx) => {
      const f = $("form", ctx.el); if (!f.reportValidity()) return false;
      const d = Object.fromEntries(new FormData(f));
      d.active = u ? $("[name=active]", f).checked : true;
      if (u) d.id = u.id;
      await api("/api/users", { method: "POST", json: d });
      return d;
    } }],
    onMount: (ctx) => {
      const sel = $("[name=collaborator]", ctx.el), dn = $("[name=display_name]", ctx.el), un = $("[name=username]", ctx.el);
      sel.onchange = () => { if (!dn.value) dn.value = sel.value; if (un && !un.value && sel.value) un.value = slug(sel.value); };
    },
  });
  $("#add", view).onclick = async () => { const d = await userForm(null); if (d) { await showCredentials([{ name: d.display_name, username: d.username, password: d.password }]); rerender(); } };
  $$("tr[data-i]", view).forEach((tr) => (tr.onclick = async () => { const d = await userForm(users[+tr.dataset.i]); if (d) { toast("Compte mis à jour", "success"); if (d.password) await showCredentials([{ name: d.display_name, username: users[+tr.dataset.i].username, password: d.password }]); rerender(); } }));
  $("#bulk", view).onclick = async () => {
    const have = new Set(users.map((u) => u.collaborator).filter(Boolean));
    const todo = collabs.filter((c) => c.active && !have.has(c.name));
    if (!todo.length) return toast("Chaque collaborateur actif a déjà un compte.", "info");
    const ok = await modal({ title: "Créer les comptes de l'équipe", size: "md",
      body: `<p class="lead">${todo.length} collaborateur(s) actif(s) sans compte. Un compte <b>Collaborateur</b> (saisie de ses temps) sera créé pour chacun, avec un mot de passe provisoire.</p><div class="row" style="gap:6px">${todo.map((c) => chip(c.name)).join("")}</div>`,
      actions: [{ label: "Annuler" }, { label: `Créer ${todo.length} comptes`, kind: "primary", value: true }] });
    if (!ok) return;
    const created = [];
    for (const c of todo) {
      const cred = { name: c.name, username: slug(c.name), password: genPassword() };
      try { await api("/api/users", { method: "POST", json: { username: cred.username, display_name: c.name, role: "collaborateur", collaborator: c.name, password: cred.password }, quiet: true }); created.push(cred); } catch (_) { /* identifiant déjà pris */ }
    }
    await showCredentials(created); rerender();
  };
}

const slug = (n) => n.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/\s+/g, ".").replace(/[^a-z0-9.]/g, "");
function genPassword() { const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; const r = crypto.getRandomValues(new Uint32Array(12)); return [...r].map((x) => a[x % a.length]).join(""); }

function showCredentials(list) {
  if (!list.length) return;
  const txt = list.map((c) => `${c.name}\t${c.username}\t${c.password}`).join("\n");
  return modal({ title: "Identifiants à transmettre", size: "lg",
    body: `<div class="alert alert-warning" style="margin-bottom:14px">${icon("key")}<div>Ces mots de passe provisoires ne seront plus affichés. Transmettez-les de façon sécurisée ; chacun devra choisir le sien à la première connexion.</div></div>
      <div class="table-wrap" style="border:1px solid var(--border);border-radius:10px"><table class="t"><thead><tr><th>Nom</th><th>Identifiant</th><th>Mot de passe provisoire</th></tr></thead><tbody>${list.map((c) => `<tr><td>${esc(c.name)}</td><td class="mono">${esc(c.username)}</td><td class="mono">${esc(c.password)}</td></tr>`).join("")}</tbody></table></div>
      <p class="small muted" style="margin-top:10px">Adresse de connexion : <b>${esc(location.origin)}</b></p>`,
    actions: [{ label: "Copier", icon: "copy", onClick: () => { navigator.clipboard?.writeText(`Adresse : ${location.origin}\n${txt}`); toast("Copié", "success"); return false; } }, { label: "Terminé", kind: "primary" }] });
}

async function audit(view) {
  const rows = await api("/api/audit?limit=800");
  const LBL = { connexion: "Connexion", "temps.import": "Import du timesheet", "temps.saisie": "Temps enregistrés", "temps.saisie.soumise": "Temps déclarés", "charges.import": "Import des charges", "charges.saisie": "Charge saisie", "charges.copie": "Charges copiées", "facture.validation": "Facture validée", "facture.validation.forcee": "Facture validée (forcée)", "facture.reouverture": "Mois réouvert", "mois.parametres": "Paramètres du mois", "noms.rapprochement": "Noms rapprochés", "compte.modification": "Compte modifié", "compte.mot_de_passe": "Mot de passe changé", parametres: "Paramètres" };
  view.innerHTML = `<div class="page-head"><div class="grow"><div class="crumbs">${icon("shield")}Administration</div><h1>Journal</h1><div class="sub">Toutes les actions, par qui et quand.</div></div></div>
    <div class="card"><div class="card-head"><div class="input-icon" style="flex:1;max-width:420px">${icon("search")}<input id="q" placeholder="Filtrer (utilisateur, action, mois…)"></div></div>
    <div class="table-wrap tall"><table class="t responsive"><thead><tr><th>Date</th><th>Utilisateur</th><th>Action</th><th>Mois</th><th>Détail</th></tr></thead><tbody id="b"></tbody></table></div></div>`;
  const draw = (q = "") => {
    const w = q.toLowerCase();
    $("#b", view).innerHTML = rows.filter((r) => !w || JSON.stringify(r).toLowerCase().includes(w)).slice(0, 500).map((r) => `<tr><td data-l="Date" class="nowrap small">${fmt.datetime(r.at)}</td><td data-l="Utilisateur">${esc(r.username || "—")}</td><td class="primary-cell" data-l="">${esc(LBL[r.action] || r.action)}</td><td data-l="Mois">${esc(r.month || "")}</td><td data-l="Détail" class="xs faint" style="max-width:420px"><div class="ellipsis" title="${esc(r.detail || "")}">${esc(r.detail || "")}</div></td></tr>`).join("") || `<tr><td colspan="5">${empty("Aucune action")}</td></tr>`;
  };
  draw();
  $("#q", view).oninput = debounce((e) => draw(e.target.value), 150);
}

async function settings(view) {
  const st = await api("/api/settings");
  const F = [["issuer_name", "Émetteur de la facture"], ["issuer_footer", "Pied de facture", true], ["client_name", "Client"], ["client_address", "Adresse du client", true], ["client_id", "Identifiant client"], ["client_ref", "Référence client"], ["currency", "Devise"], ["hours_per_day", "Heures par jour"], ["default_cost_plus", "Cost + par défaut (ex. 0.07)"], ["expected_tolerance", "Tolérance sur les heures (ex. 0.2 = ±20 %)"]];
  let rules = {};
  try { rules = JSON.parse(st.monthly_keywords || "{}"); } catch (_) { /* */ }
  const KINDS = [["Agile", "Évolutions mineures (Agile)"], ["Support", "Bug fixes (Support)"], ["Run", "Run / activités récurrentes"]];
  view.innerHTML = `<div class="page-head"><div class="grow"><div class="crumbs">${icon("shield")}Administration</div><h1>Paramètres</h1></div></div>
  <div class="grid g-side"><div class="stack"><div class="card"><div class="card-head"><h2>Facture et calcul</h2></div><form class="card-body form-grid" id="sf" onsubmit="return false">
    ${F.map(([k, l, area]) => field({ name: k, label: l, value: st[k], type: area ? "textarea" : "text", rows: 2, full: !!area }))}</form>
    <div class="card-foot"><button class="btn primary" id="save">Enregistrer</button></div></div>
    <div class="card"><div class="card-head"><div class="grow"><h2>Lots facturés au mois</h2><div class="desc">Une epic dont le nom (JIRA NAME) contient l'un de ces mots est facturée mois par mois : « CSE - BUG FIXES » devient « CSE - BUG FIXES - 10/26 », livré en fin de mois. Toutes les autres epics sont des projets : une seule ligne jusqu'à leur mise en ligne.</div></div></div>
      <form class="card-body stack" id="mk" style="gap:12px" onsubmit="return false">
        ${KINDS.map(([k, l]) => field({ name: k, label: l, value: (rules[k] || []).join(", "), help: "Mots-clés séparés par des virgules, majuscules ou minuscules indifférentes." })).join("")}
        <p class="xs faint" style="margin:0">Tiré de l'historique : 109 des 134 lots mensuels depuis 2018 contiennent « MINOR EVOLUTION » ou « BUG » ; les autres sont des activités récurrentes de l'équipe CX et FASTERIZE.</p></form>
      <div class="card-foot"><button class="btn primary" id="saveMk">Enregistrer</button></div></div>
    <div class="card" id="aiCard"></div></div>
  <div class="stack"><div class="card" id="reprise"><div class="card-head"><div class="grow"><h2>Reprise des fichiers Excel</h2><div class="desc">Charge salariés, projets, epics, charges et l'historique des factures, puis recalcule chaque mois pour le comparer à vos factures Excel.</div></div></div>
      <div class="card-body stack" style="gap:10px">
        ${[["facturation", "Facturation Paris", true], ["charges", "Charge Patronale - BDD", true], ["timesheet", "Timesheet du dernier mois (facultatif)", false]].map(([k, l, req]) => `<label class="drop" style="padding:12px;text-align:left;display:flex;gap:12px;align-items:center" data-k="${k}"><span class="drop-ic" style="margin:0;width:36px;height:36px">${icon("file")}</span><span class="grow" style="flex:1;min-width:0"><span class="drop-title" style="font-size:13.5px">${l}${req ? ' <span class="req">*</span>' : ""}</span><span class="drop-sub ellipsis" style="display:block" data-name>Choisir le fichier .xlsx</span></span><input type="file" accept=".xlsx,.xlsm" hidden></label>`).join("")}
        <div class="row"><div class="field" style="flex:1"><label>Historique à partir de</label><input type="month" id="hf" value="2025-01"></div></div>
        <button class="btn primary" id="runReprise" disabled>${icon("zap")}Lancer la reprise</button>
        <p class="xs faint" style="margin:0">Rejouable : l'historique repris est remplacé ; comptes, saisies et mois en cours sont conservés.</p></div></div>
    <div class="card card-pad"><h3>Version 2 — Jira</h3><p class="small muted" style="margin:0">L'import des temps est isolé : il pourra lire directement les worklogs Jira (projets MC et RD10) au lieu du fichier.</p></div></div></div>`;
  aiModule($("#aiCard", view));
  $("#saveMk", view).onclick = async () => {
    const data = Object.fromEntries(new FormData($("#mk", view)));
    const out = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.split(",").map((x) => x.trim()).filter(Boolean)]));
    S.settings = await api("/api/settings", { method: "PUT", json: { monthly_keywords: JSON.stringify(out) } });
    toast("Règles des lots mensuels enregistrées", "success");
  };
  $("#save", view).onclick = async () => { S.settings = await api("/api/settings", { method: "PUT", json: Object.fromEntries(new FormData($("#sf", view))) }); toast("Paramètres enregistrés", "success"); };
  const files = {};
  const run = $("#runReprise", view);
  view.querySelectorAll("#reprise [data-k]").forEach((lab) => {
    const inp = lab.querySelector("input");
    inp.onchange = () => {
      files[lab.dataset.k] = inp.files[0];
      lab.querySelector("[data-name]").textContent = inp.files[0]?.name || "Choisir le fichier .xlsx";
      lab.classList.toggle("over", !!inp.files[0]);
      run.disabled = !(files.facturation && files.charges);
    };
  });
  run.onclick = async () => {
    run.classList.add("loading");
    try {
      const r = await api("/api/import/bootstrap", { method: "POST", form: { ...files, history_from: $("#hf", view).value } });
      S.months = await api("/api/months");
      const ok = r.months.filter((m) => m.status === "identique").length;
      const V = { identique: chip("Identique", "success"), ecart: chip("Écart", "warning"), excel_casse: chip("Onglet Excel en #REF!", "") };
      await modal({ title: "Reprise terminée", size: "lg",
        body: `<div class="grid g4" style="margin-bottom:16px">
            <div class="kpi"><div class="kpi-label">Factures reprises</div><div class="kpi-value">${r.months.length}</div><div class="kpi-sub">${ok} identiques au centime</div></div>
            <div class="kpi"><div class="kpi-label">Lignes de temps</div><div class="kpi-value">${fmt.num(r.entries)}</div><div class="kpi-sub">historique</div></div>
            <div class="kpi"><div class="kpi-label">Collaborateurs</div><div class="kpi-value">${r.collaborators}</div><div class="kpi-sub">${r.deactivated.length} anciens désactivés</div></div>
            <div class="kpi"><div class="kpi-label">Projets</div><div class="kpi-value">${fmt.num(r.projects)}</div><div class="kpi-sub">${r.epics} epics</div></div></div>
          <div class="table-wrap" style="max-height:360px;border:1px solid var(--border);border-radius:10px"><table class="t"><thead><tr><th>Mois</th><th class="num">Salaires Excel</th><th class="num">Recalculé</th><th class="num">Écart</th><th>Verdict</th></tr></thead><tbody>
          ${r.months.map((m) => `<tr><td>${esc(m.month)}</td><td class="num">${fmt.money(m.salary_excel)}</td><td class="num">${fmt.money(m.salary_calc)}</td><td class="num">${fmt.money(m.salary_diff)}</td><td>${V[m.status]}</td></tr>`).join("")}</tbody></table></div>
          ${r.draft_month ? `<div class="alert alert-info" style="margin-top:14px">${icon("arrowR")}<div>Prochaine étape : importer le timesheet de <b>${esc(r.draft_month)}</b> depuis Facture du mois › Temps.</div></div>` : ""}`,
        actions: [{ label: "Fermer", kind: "primary" }] });
    } finally { run.classList.remove("loading"); }
  };
}


// ------------------------------------------------------------------ assistant IA : fournisseur, modèle, raisonnement
async function aiModule(card) {
  const st = await api("/api/ai");
  const EFFORT_LBL = { none: "Aucun", minimal: "Minimal", low: "Faible", medium: "Moyen", high: "Élevé", xhigh: "Très élevé", max: "Maximum" };
  const ORDER = ["openai", "google", "anthropic"];
  const state = { provider: st.provider && st.provider !== "off" ? st.provider : (st.active || ""), model: st.model, effort: st.effort, models: [], keyDraft: "" };
  const keyLabel = (p) => { const k = st.keys[p] || {}; return k.origin === "db" ? `Clé enregistrée (${k.hint})` : k.origin ? `Fournie par le serveur (${k.origin}, ${k.hint})` : "Aucune clé"; };
  const draw = () => {
    const p = state.provider, info = st.providers[p];
    card.innerHTML = `<div class="card-head"><div class="grow"><h2>Assistant IA</h2><div class="desc">Rapproche les noms de collaborateurs inconnus lors des imports. Seuls des noms sont envoyés, jamais de montants.</div></div>
        ${st.active ? chip("Actif", "success", "sparkles") : chip("Inactif")}</div>
      <div class="card-body stack" style="gap:14px">
        ${st.active ? `<div class="small muted">En service : <b>${esc(st.label)}</b></div>` : ""}
        <div class="field"><label>1. Fournisseur</label>
          <div class="seg" role="tablist">${ORDER.map((k) => `<button type="button" data-p="${k}" class="${p === k ? "on" : ""}">${esc(st.providers[k].label)}</button>`).join("")}<button type="button" data-p="off" class="${p === "off" || !p ? "on" : ""}">Désactivé</button></div></div>
        ${p && p !== "off" ? `
        <div class="field"><label>Clé d'API ${esc(info.label)}</label>
          <div class="row"><input id="aiKey" type="password" autocomplete="off" placeholder="${esc(keyLabel(p))} — collez une nouvelle clé pour la remplacer" style="flex:1">
          ${st.keys[p]?.origin === "db" ? `<button class="btn sm ghost" id="aiDelKey" type="button">${icon("trash")}Supprimer</button>` : ""}</div>
          <div class="help">${esc(keyLabel(p))}. La clé est stockée sur le serveur et n'est jamais réaffichée.</div></div>
        <div class="field"><label>2. Modèle <span class="faint" id="aiCount"></span></label>
          <div class="row"><select id="aiModel" style="flex:1"><option value="">${state.model ? esc(state.model) : `Par défaut (${esc(info.default_model)})`}</option></select>
          <button class="btn sm" id="aiLoad" type="button">${icon("download")}Charger les modèles</button></div>
          <div class="help">Liste lue en direct chez ${esc(info.label)} : les nouveaux modèles apparaissent sans mise à jour de l'application.</div></div>
        <div class="field"><label>3. Niveau de raisonnement</label>
          <select id="aiEffort"><option value="">Par défaut du modèle</option>${info.efforts.map((e) => `<option value="${e}" ${state.effort === e ? "selected" : ""}>${EFFORT_LBL[e] || e} (${e})</option>`).join("")}</select>
          <div class="help">Plus élevé = plus réfléchi mais plus lent et plus cher. « Faible » suffit pour rapprocher des noms. Ignoré automatiquement si le modèle ne le prend pas en charge.</div></div>
        <div id="aiResult"></div>` : `<p class="small muted" style="margin:0">L'IA est désactivée : le rapprochement local (orthographe, ordre des mots, initiales, translittération) reste actif.</p>`}
      </div>
      <div class="card-foot">${p && p !== "off" ? `<button class="btn" id="aiTest" type="button">${icon("zap")}Tester</button>` : ""}<button class="btn primary" id="aiSave" type="button">Enregistrer</button></div>`;

    card.querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => {
      state.provider = b.dataset.p; state.models = []; state.keyDraft = "";
      if (state.provider !== st.provider) { state.model = ""; state.effort = ""; }
      else { state.model = st.model; state.effort = st.effort; }
      draw();
      if (state.provider !== "off" && st.keys[state.provider]?.origin) loadModels();
    }));
    const key = $("#aiKey", card), sel = $("#aiModel", card), eff = $("#aiEffort", card);
    if (key) { key.value = state.keyDraft; key.oninput = () => (state.keyDraft = key.value.trim()); }
    if (sel) { fillModels(); sel.onchange = () => (state.model = sel.value); }
    if (eff) eff.onchange = () => (state.effort = eff.value);
    $("#aiLoad", card)?.addEventListener("click", loadModels);
    $("#aiDelKey", card)?.addEventListener("click", async () => {
      if (!(await confirmDialog("Supprimer la clé ?", `La clé ${esc(st.providers[state.provider].label)} enregistrée sera effacée du serveur.`, { danger: true, ok: "Supprimer" }))) return;
      Object.assign(st, await api("/api/ai", { method: "PUT", json: { provider: st.provider, model: st.model, effort: st.effort, keys: { [state.provider]: "" } } }));
      toast("Clé supprimée", "success"); draw();
    });
    $("#aiTest", card)?.addEventListener("click", async (e) => {
      const b = e.currentTarget; b.classList.add("loading");
      try {
        const r = await api("/api/ai/test", { method: "POST", json: { provider: state.provider, model: state.model, effort: state.effort, key: state.keyDraft } });
        $("#aiResult", card).innerHTML = r.ok
          ? `<div class="alert alert-success">${icon("check")}<div class="grow"><div class="alert-title">Ça fonctionne (${r.seconds} s)</div><div class="small">${Object.entries(r.matches).map(([k, v]) => `${esc(k)} → <b>${esc(v.name)}</b>`).join(" · ") || "Aucun rapprochement proposé"}</div></div></div>`
          : `<div class="alert alert-danger">${icon("error")}<div class="grow"><div class="alert-title">Échec${r.status ? ` (${r.status})` : ""}</div><div class="small">${esc(r.error)}</div></div></div>`;
      } finally { b.classList.remove("loading"); }
    });
    $("#aiSave", card).onclick = async (e) => {
      const b = e.currentTarget; b.classList.add("loading");
      try {
        const body = { provider: state.provider || "off", model: state.model, effort: state.effort };
        if (state.keyDraft) body.keys = { [state.provider]: state.keyDraft };
        Object.assign(st, await api("/api/ai", { method: "PUT", json: body }));
        state.keyDraft = ""; S.ai = !!st.active; S.aiLabel = st.label;
        toast(st.active ? `IA active : ${st.label}` : "IA désactivée", "success"); draw();
      } finally { b.classList.remove("loading"); }
    };
  };
  const fillModels = () => {
    const sel = $("#aiModel", card); if (!sel) return;
    const info = st.providers[state.provider];
    const list = state.models;
    const known = list.some((m) => m.id === state.model);
    sel.innerHTML = `<option value="">Par défaut (${esc(info.default_model)})</option>`
      + (state.model && !known ? `<option value="${esc(state.model)}" selected>${esc(state.model)}</option>` : "")
      + list.map((m) => `<option value="${esc(m.id)}" ${m.id === state.model ? "selected" : ""}>${esc(m.label === m.id ? m.id : `${m.label} — ${m.id}`)}</option>`).join("");
    const c = $("#aiCount", card); if (c) c.textContent = list.length ? `· ${list.length} disponibles` : "";
  };
  const loadModels = async () => {
    const b = $("#aiLoad", card); b?.classList.add("loading");
    try {
      const r = await api("/api/ai/models", { method: "POST", json: { provider: state.provider, key: state.keyDraft } });
      state.models = r.models; fillModels();
      toast(`${r.models.length} modèles ${st.providers[state.provider].label} chargés`, "success");
    } finally { b?.classList.remove("loading"); }
  };
  draw();
  if (state.provider && state.provider !== "off" && st.keys[state.provider]?.origin) loadModels().catch(() => {});
}
