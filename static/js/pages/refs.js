/* Référentiels : projets (MEP), epics Jira, collaborateurs. */
import { $, $$, api, can, esc, fmt, icon, chip, statusChip, empty, modal, formDialog, toast, confirmDialog, avatar, debounce, field as fieldHtml } from "../core.js";
import { rerender } from "../app.js";

const STATUS = [["IN PROGRESS", "En cours"], ["PRODUCTION", "En ligne"], ["ABANDONED", "Abandonné"]];
const CATS = ["Project", "Agile", "Support", "CX", "Innovation Forum", "CRO", "BI", "Migration", "Hosting", "Init"];
const MODES = [["jira", "Jira — temps importés"], ["manual", "Saisie — temps saisis dans l'application"], ["prorata", "Prorata — réparti selon l'équipe"], ["mirror", "Miroir — même répartition qu'un autre"]];

const CFG = {
  projects: {
    title: "Projets", sub: "Base de tous les lots facturés et de leur date de mise en ligne (ex-onglet MEP Dates).", pk: "lot",
    help: "Un projet passé <b>en ligne</b> à une date ne peut plus recevoir d'heures sur les mois suivants. Les lots mensuels sont inscrits automatiquement à la validation de chaque facture.",
    cols: [["lot", "Lot / projet", "text"], ["status", "Statut", "enum"], ["mel_date", "Mise en ligne", "date"], ["category", "Catégorie", "enum"], ["sub_category", "Sous-catégorie", "enum"]],
    defaults: {},
    form: (r = {}) => [
      { name: "lot", label: "Nom du lot facturé", value: r.lot, required: true, full: true },
      { name: "status", label: "Statut", type: "select", options: STATUS, value: r.status || "IN PROGRESS" },
      { name: "mel_date", label: "Date de mise en ligne", type: "date", value: r.mel_date || "" },
      { name: "category", label: "Catégorie", type: "select", options: ["", ...CATS], value: r.category || "" },
      { name: "sub_category", label: "Sous-catégorie", value: r.sub_category || "" },
    ],
  },
  epics: {
    title: "Epics Jira", sub: "Correspondance entre chaque epic Jira et le lot facturé (ex-onglet Roadmap). Mis à jour à chaque import du timesheet.", pk: "epic_key",
    help: "Le lot facturé est mensuel (« NOM - MM/AA ») quand son nom contient un mot-clé des lots mensuels (MINOR EVOLUTION, BUG, activités de run) : voir Paramètres.",
    cols: [["label", "Epic", "text"], ["lot_name", "Lot facturé", "text"], ["category", "Catégorie", "enum"], ["sub_category", "Sous-catégorie", "enum"], ["status", "Statut", "enum"], ["mel_date", "Mise en ligne", "date"]],
    defaults: {},
    form: (r = {}) => [
      { name: "label", label: "Epic (clé : nom)", value: r.label, required: true, full: true, placeholder: "EPICS-123: NOM DU PROJET" },
      { name: "lot_name", label: "Lot facturé (JIRA NAME)", value: r.lot_name, required: true, full: true },
      { name: "category", label: "Catégorie", type: "select", options: CATS, value: r.category || "Project" },
      { name: "sub_category", label: "Sous-catégorie", value: r.sub_category || "" },
      { name: "status", label: "Statut", type: "select", options: STATUS, value: r.status || "IN PROGRESS" },
      { name: "mel_date", label: "Date de mise en ligne", type: "date", value: r.mel_date || "" },
    ],
  },
  collaborators: {
    title: "Collaborateurs", sub: "Un seul nom par personne, utilisé partout (Jira, paie, saisies). Les autres graphies sont des alias.", pk: "id",
    help: "<b>Entité</b> : l'entreprise de rattachement ; seuls les collaborateurs de l'entité facturée (Paramètres) entrent dans la facture. <b>Mode</b> — Jira : temps importés · Saisie : temps déclarés dans l'application · Prorata : coût réparti selon les heures de l'équipe · Miroir : même répartition qu'un autre.",
    cols: [["name", "Nom", "text"], ["role", "Rôle", "enum"], ["entity", "Entité", "enum"], ["team", "Équipe", "enum"], ["mode", "Mode", "enum"], ["aliases", "Alias", "text"], ["active", "Statut", "enum"]],
    defaults: { active: ["1"] },
    bulk: true,
  },
};
const ENUM_LABEL = {
  status: { "IN PROGRESS": "En cours", PRODUCTION: "En ligne", ABANDONED: "Abandonné" },
  active: { 1: "Actif", 0: "Inactif" },
  mode: { jira: "Jira", manual: "Saisie", prorata: "Prorata", mirror: "Miroir" },
};
const enumLabel = (k, v) => (v === "" || v == null ? "(vide)" : ENUM_LABEL[k]?.[v] ?? String(v));

const states = {};
const getState = (arg, params) => {
  const cfg = CFG[arg];
  const st = states[arg] || (states[arg] = { q: "", sort: null, filters: Object.fromEntries(Object.entries(cfg.defaults).map(([k, v]) => [k, v.slice()])), limit: 150, open: false, sel: new Set() });
  if (params[0]) st.q = decodeURIComponent(params[0]);
  return st;
};

export async function render(view, { arg, params }) {
  const cfg = CFG[arg];
  const st = getState(arg, params);
  const data = await api(`/api/ref/${arg}`);
  const editable = can("ref");
  const values = (k) => [...new Set(data.map((r) => String(r[k] ?? "")))].sort((a, b) => a.localeCompare(b, "fr"));

  view.innerHTML = `<div class="page-head"><div class="grow"><div class="crumbs">${icon("layers")}Référentiels</div><h1>${cfg.title}</h1><div class="sub">${cfg.sub}</div></div>
      ${editable ? `<div class="toolbar"><button class="btn primary" id="add">${icon("plus")}Ajouter</button></div>` : ""}</div>
    <div class="alert alert-info" style="margin-bottom:16px">${icon("info")}<div>${cfg.help}</div></div>
    <div class="card"><div class="card-head" style="gap:10px">
        <div class="input-icon" style="flex:1;min-width:220px;max-width:420px">${icon("search")}<input id="q" placeholder="Rechercher dans toutes les colonnes…" value="${esc(st.q)}"></div>
        <button class="btn sm" id="ftoggle">${icon("filter")}Filtres<span class="badge" id="fcount" hidden></span></button>
        <span class="faint small" id="count"></span><div style="flex:1"></div>
        <div id="bulkbar" hidden class="row" style="gap:6px"></div></div>
      <div id="fpanel" class="filter-panel" ${st.open ? "" : "hidden"}></div>
      <div id="fchips" class="filter-chips"></div>
      <div class="table-wrap tall"><table class="t responsive"><thead><tr id="thead"></tr></thead><tbody id="body"></tbody></table></div></div>`;

  // ------------------------------------------------ filtres
  const active = () => Object.entries(st.filters).filter(([, v]) => (Array.isArray(v) ? v.length : v && (v.from || v.to || v.text)));
  const passes = (r) => active().every(([k, f]) => {
    const v = r[k] ?? "";
    if (Array.isArray(f)) return f.includes(String(v));
    if (f.text) return String(v).toLowerCase().includes(f.text.toLowerCase());
    if (f.from && (!v || v < f.from)) return false;
    if (f.to && (!v || v > f.to)) return false;
    return true;
  });
  const drawPanel = () => {
    $("#fpanel", view).innerHTML = `<div class="filter-grid">${cfg.cols.map(([k, l, t]) => {
      const f = st.filters[k];
      if (t === "date") return `<div class="field field-date"><label>${l} (du … au …)</label><div class="date-range"><input type="date" data-from="${k}" value="${f?.from || ""}" aria-label="${l} à partir du"><span class="faint xs">au</span><input type="date" data-to="${k}" value="${f?.to || ""}" aria-label="${l} jusqu'au"></div></div>`;
      if (t === "enum") {
        const vals = values(k), sel = new Set(Array.isArray(f) ? f : []);
        return `<div class="field"><label>${l}</label><details class="multi"><summary>${sel.size ? `${sel.size} sélectionné${sel.size > 1 ? "s" : ""}` : "Tous"}</summary><div class="multi-list">
          ${vals.length > 8 ? `<input class="multi-q" placeholder="Filtrer…">` : ""}
          ${vals.map((v) => `<label class="check xs"><input type="checkbox" data-enum="${k}" value="${esc(v)}" ${sel.has(v) ? "checked" : ""}><span>${esc(enumLabel(k, v))}</span><span class="faint" style="margin-left:auto">${data.filter((r) => String(r[k] ?? "") === v).length}</span></label>`).join("")}</div></details></div>`;
      }
      return `<div class="field"><label>${l} contient</label><input data-text="${k}" value="${esc(f?.text || "")}"></div>`;
    }).join("")}</div><div class="row end" style="margin-top:10px"><button class="btn sm ghost" id="fclear">${icon("x")}Effacer les filtres</button></div>`;
    const p = $("#fpanel", view);
    p.querySelectorAll("[data-from],[data-to]").forEach((inp) => inp.onchange = () => {
      const k = inp.dataset.from || inp.dataset.to, f = st.filters[k] || (st.filters[k] = {});
      f[inp.dataset.from ? "from" : "to"] = inp.value; refresh();
    });
    p.querySelectorAll("[data-text]").forEach((inp) => inp.oninput = debounce(() => { st.filters[inp.dataset.text] = { text: inp.value }; refresh(); }, 150));
    p.querySelectorAll("[data-enum]").forEach((cb) => cb.onchange = () => {
      const k = cb.dataset.enum, cur = new Set(Array.isArray(st.filters[k]) ? st.filters[k] : []);
      cb.checked ? cur.add(cb.value) : cur.delete(cb.value);
      st.filters[k] = [...cur];
      const sum = cb.closest("details").querySelector("summary"); sum.textContent = cur.size ? `${cur.size} sélectionné${cur.size > 1 ? "s" : ""}` : "Tous";
      refresh();
    });
    p.querySelectorAll(".multi-q").forEach((q) => q.oninput = () => q.parentElement.querySelectorAll("label").forEach((lb) => (lb.hidden = !lb.textContent.toLowerCase().includes(q.value.toLowerCase()))));
    $("#fclear", p).onclick = () => { st.filters = {}; drawPanel(); refresh(); };
  };
  const drawChips = () => {
    const a = active();
    $("#fcount", view).hidden = !a.length; $("#fcount", view).textContent = a.length;
    $("#fchips", view).innerHTML = a.map(([k, f]) => {
      const l = cfg.cols.find((c) => c[0] === k)?.[1] || k;
      const txt = Array.isArray(f) ? f.map((v) => enumLabel(k, v)).join(", ") : f.text ? `contient « ${f.text} »` : `${f.from ? `du ${fmt.date(f.from)}` : ""}${f.from && f.to ? " " : ""}${f.to ? `au ${fmt.date(f.to)}` : ""}`;
      return `<span class="chip chip-brand fchip">${esc(l)} : ${esc(txt)}<button data-rmf="${k}" aria-label="Retirer le filtre">${icon("x")}</button></span>`;
    }).join("") + (a.length ? `<button class="btn sm ghost" id="fclear2">Tout effacer</button>` : "");
    $$("[data-rmf]", view).forEach((b) => b.onclick = () => { delete st.filters[b.dataset.rmf]; drawPanel(); refresh(); });
    $("#fclear2", view)?.addEventListener("click", () => { st.filters = {}; drawPanel(); refresh(); });
  };

  // ------------------------------------------------ tri
  const drawHead = () => {
    $("#thead", view).innerHTML = (cfg.bulk && editable ? `<th style="width:34px"><input type="checkbox" id="selall" aria-label="Tout sélectionner"></th>` : "")
      + cfg.cols.map(([k, l]) => `<th class="sortable ${st.sort?.key === k ? "sorted" : ""}" data-sort="${k}" aria-sort="${st.sort?.key === k ? (st.sort.dir > 0 ? "ascending" : "descending") : "none"}">${l}<span class="sort-ic">${st.sort?.key === k ? (st.sort.dir > 0 ? "▲" : "▼") : "↕"}</span></th>`).join("") + "<th></th>";
    $$("[data-sort]", view).forEach((th) => th.onclick = () => {
      const k = th.dataset.sort;
      st.sort = st.sort?.key !== k ? { key: k, dir: 1 } : st.sort.dir > 0 ? { key: k, dir: -1 } : null;
      drawHead(); draw();
    });
    $("#selall", view)?.addEventListener("change", (e) => { rowsCache.slice(0, st.limit).forEach((r) => (e.target.checked ? st.sel.add(r[cfg.pk]) : st.sel.delete(r[cfg.pk]))); draw(); });
  };
  const sorted = (rows) => {
    if (!st.sort) return rows;
    const { key, dir } = st.sort;
    return rows.slice().sort((a, b) => {
      const x = a[key] ?? "", y = b[key] ?? "";
      if (x === "" && y !== "") return 1;
      if (y === "" && x !== "") return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "fr", { numeric: true })) * dir;
    });
  };

  // ------------------------------------------------ cellules et lignes
  const cell = (r, k) => {
    const v = r[k];
    if (k === "status") return statusChip(v);
    if (k === "mel_date") return v ? fmt.date(v) : '<span class="faint">—</span>';
    if (k === "category" || k === "sub_category" || k === "team") return v ? chip(v) : '<span class="faint">—</span>';
    if (k === "entity") return v ? chip(v, "info") : '<span class="faint">—</span>';
    if (k === "name") return `<div class="person">${avatar(v)}<b>${esc(v)}</b></div>`;
    if (k === "mode") return chip({ jira: "Jira", manual: "Saisie", prorata: "Prorata", mirror: `Miroir · ${r.mirror_of || "?"}` }[v] || v, v === "jira" ? "" : "brand");
    if (k === "aliases") { const a = JSON.parse(v || "[]"); return a.length ? `<span class="xs faint">${a.map(esc).join(", ")}</span>` : ""; }
    if (k === "active") return v ? chip("Actif", "success") : chip("Inactif");
    if (k === "label" || k === "lot") return `<span style="font-weight:550">${esc(v)}</span>`;
    return esc(v ?? "");
  };
  let rowsCache = [];
  const draw = () => {
    const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
    rowsCache = sorted(data.filter((r) => passes(r) && words.every((w) => Object.values(r).join(" ").toLowerCase().includes(w))));
    const rows = rowsCache;
    $("#count", view).textContent = `${rows.length} / ${data.length}`;
    const bulk = cfg.bulk && editable;
    $("#body", view).innerHTML = rows.slice(0, st.limit).map((r) => `<tr class="${editable ? "clickable" : ""}" data-i="${data.indexOf(r)}">${bulk ? `<td data-l="" onclick="event.stopPropagation()"><input type="checkbox" data-sel="${esc(r[cfg.pk])}" ${st.sel.has(r[cfg.pk]) ? "checked" : ""} aria-label="Sélectionner"></td>` : ""}${cfg.cols.map(([k, l], j) => `<td data-l="${l}" class="${j === 0 ? "primary-cell" : ""}">${cell(r, k)}</td>`).join("")}<td class="actions">${editable ? icon("chevR", "faint") : ""}</td></tr>`).join("")
      + (rows.length > st.limit ? `<tr><td colspan="10" style="text-align:center"><button class="btn sm" id="more">Afficher plus (${rows.length - st.limit})</button></td></tr>` : "")
      + (!rows.length ? `<tr><td colspan="10">${empty("Aucun résultat", "Modifiez la recherche ou les filtres.", "search")}</td></tr>` : "");
    $("#more", view)?.addEventListener("click", () => { st.limit += 300; draw(); });
    if (editable) $$("#body tr[data-i]", view).forEach((tr) => (tr.onclick = () => edit(arg, data[+tr.dataset.i], data)));
    $$("[data-sel]", view).forEach((cb) => cb.onchange = () => { const id = isNaN(+cb.dataset.sel) ? cb.dataset.sel : +cb.dataset.sel; cb.checked ? st.sel.add(id) : st.sel.delete(id); drawBulk(); });
    drawBulk();
  };
  const drawBulk = () => {
    const bar = $("#bulkbar", view); if (!bar) return;
    bar.hidden = !st.sel.size;
    bar.innerHTML = st.sel.size ? `<span class="small"><b>${st.sel.size}</b> sélectionné${st.sel.size > 1 ? "s" : ""}</span><button class="btn sm primary" id="bulkEdit">${icon("edit")}Modifier la sélection</button><button class="btn sm ghost" id="bulkClear">${icon("x")}</button>` : "";
    $("#bulkClear", view)?.addEventListener("click", () => { st.sel.clear(); draw(); });
    $("#bulkEdit", view)?.addEventListener("click", () => bulkEditCollaborators([...st.sel], data, () => { st.sel.clear(); rerender(); }));
  };
  const refresh = () => { st.limit = 150; drawChips(); draw(); };

  drawHead(); drawPanel(); drawChips(); draw();
  const closeMulti = (e) => {
    if (!document.body.contains(view)) return document.removeEventListener("mousedown", closeMulti);
    view.querySelectorAll("details.multi[open]").forEach((dt) => { if (!dt.contains(e.target)) dt.removeAttribute("open"); });
  };
  document.addEventListener("mousedown", closeMulti);
  view.addEventListener("keydown", (e) => { if (e.key === "Escape") view.querySelectorAll("details.multi[open]").forEach((dt) => dt.removeAttribute("open")); });
  view.addEventListener("toggle", (e) => {
    if (e.target.matches?.("details.multi") && e.target.open) view.querySelectorAll("details.multi[open]").forEach((dt) => dt !== e.target && dt.removeAttribute("open"));
  }, true);
  $("#q", view).oninput = debounce((e) => { st.q = e.target.value; st.limit = 150; draw(); }, 120);
  $("#ftoggle", view).onclick = () => { st.open = !st.open; $("#fpanel", view).hidden = !st.open; };
  $("#add", view)?.addEventListener("click", () => (arg === "collaborators" ? addCollaborator(data) : edit(arg, null, data)));
}

async function bulkEditCollaborators(ids, all, done) {
  const entities = [...new Set(all.map((c) => c.entity).filter(Boolean))].sort();
  const teams = [...new Set(all.map((c) => c.team).filter(Boolean))].sort();
  const res = await modal({
    title: `Modifier ${ids.length} collaborateur${ids.length > 1 ? "s" : ""}`, size: "md",
    body: `<p class="small muted">Laissez un champ vide pour ne pas le modifier.</p><form class="form-grid" onsubmit="return false">
      ${fieldHtml({ name: "entity", label: "Entité", list: "dl-ent", placeholder: "inchangée" })}
      ${fieldHtml({ name: "team", label: "Équipe", list: "dl-team", placeholder: "inchangée" })}
      ${fieldHtml({ name: "active", label: "Statut", type: "select", options: [["", "inchangé"], ["1", "Actif"], ["0", "Inactif"]] })}</form>
      <datalist id="dl-ent">${entities.map((e) => `<option value="${esc(e)}">`).join("")}</datalist><datalist id="dl-team">${teams.map((e) => `<option value="${esc(e)}">`).join("")}</datalist>
      <div class="xs faint">${esc(all.filter((c) => ids.includes(c.id)).map((c) => c.name).join(", "))}</div>`,
    actions: [{ label: "Annuler" }, { label: "Appliquer", kind: "primary", onClick: async (ctx) => {
      const d = Object.fromEntries(new FormData($("form", ctx.el)));
      const patch = {};
      if (d.entity.trim()) patch.entity = d.entity.trim();
      if (d.team.trim()) patch.team = d.team.trim();
      if (d.active !== "") patch.active = +d.active;
      if (!Object.keys(patch).length) return true;
      for (const id of ids) await api("/api/ref/collaborators", { method: "POST", json: { id, ...patch } });
      return true;
    } }],
  });
  if (res) { toast("Collaborateurs mis à jour", "success"); done(); }
}

async function edit(table, row, all) {
  if (table === "collaborators") return editCollaborator(row, all);
  const cfg = CFG[table];
  const res = await modal({
    title: row ? "Modifier" : "Ajouter", size: "md",
    body: `<form class="form-grid" onsubmit="return false">${cfg.form(row || {}).map((f) => fieldHtml(f)).join("")}</form>`,
    actions: [...(row ? [{ label: "Supprimer", kind: "ghost", value: "delete" }] : []), { label: "Annuler" }, {
      label: "Enregistrer", kind: "primary", onClick: async (ctx) => {
        const form = $("form", ctx.el); if (!form.reportValidity()) return false;
        const data = Object.fromEntries(new FormData(form));
        await api(`/api/ref/${table}`, { method: "POST", json: { ...data, ...(row ? { _original: row[cfg.pk] } : {}) } });
        return "saved";
      },
    }],
  });
  if (res === "delete" && (await confirmDialog("Supprimer ?", `« ${esc(row[cfg.pk])} » sera supprimé du référentiel.`, { danger: true, ok: "Supprimer" }))) {
    await api(`/api/ref/${table}/${encodeURIComponent(row[cfg.pk])}`, { method: "DELETE" }); toast("Supprimé", "success"); rerender();
  }
  if (res === "saved") { toast("Enregistré", "success"); rerender(); }
}


async function addCollaborator(all) {
  const d = await formDialog("Nouveau collaborateur", [{ name: "name", label: "Nom complet (Prénom Nom)", required: true, full: true, autofocus: true }], { ok: "Continuer" });
  if (!d) return;
  const chk = await api("/api/collaborators/check", { method: "POST", json: { name: d.name } });
  if (chk.duplicate) {
    toast(`Ce collaborateur existe déjà : ${chk.duplicate}`, "warning");
    return editCollaborator(all.find((c) => c.name === chk.duplicate), all);
  }
  if (chk.suggestions.length) {
    const v = await modal({
      title: "Doublon possible", size: "md",
      body: `<p class="lead">« <b>${esc(d.name)}</b> » ressemble à un collaborateur existant :</p>
        <div class="list card">${chk.suggestions.map((s) => `<button class="list-item btn ghost" style="height:auto;border-radius:0;justify-content:flex-start" data-n="${esc(s.name)}">${avatar(s.name)}<div class="grow" style="text-align:left"><b>${esc(s.name)}</b><div class="xs faint">${Math.round(s.score * 100)} % · ${esc(s.reason)}</div></div><span class="chip chip-brand">C'est la même personne</span></button>`).join("")}</div>
        <p class="small muted" style="margin-top:12px">S'il s'agit de la même personne, « ${esc(d.name)} » sera enregistré comme alias pour éviter les doublons.</p>`,
      actions: [{ label: "Annuler" }, { label: "Non, c'est une autre personne", kind: "primary", value: "new" }],
      onMount: (ctx) => $$("[data-n]", ctx.el).forEach((b) => (b.onclick = () => ctx.close("alias:" + b.dataset.n))),
    });
    if (!v) return;
    if (v.startsWith("alias:")) {
      const c = all.find((x) => x.name === v.slice(6));
      const al = [...new Set([...JSON.parse(c.aliases || "[]"), d.name])];
      await api("/api/ref/collaborators", { method: "POST", json: { id: c.id, aliases: al } });
      toast(`Alias ajouté à ${c.name}`, "success"); return rerender();
    }
  }
  return editCollaborator({ name: d.name, role: "", mode: "jira", prorata_base: "costed", aliases: "[]", active: 1, entity: "", team: "", _new: true }, all);
}

async function editCollaborator(row, all) {
  const names = all.filter((c) => c.active && c.name !== row.name).map((c) => c.name);
  const res = await modal({
    title: row._new ? "Nouveau collaborateur" : row.name, size: "md",
    body: `<form class="form-grid" onsubmit="return false">
      ${fieldHtml({ name: "name", label: "Nom officiel", value: row.name, required: true, full: true, help: row._new ? "" : "Renommer conserve l'ancien nom en alias et met à jour les temps." })}
      ${fieldHtml({ name: "role", label: "Rôle", value: row.role, placeholder: "Developeur, QA, CTO…" })}
      ${fieldHtml({ name: "active", label: "Statut", type: "select", options: [["1", "Actif"], ["0", "Inactif"]], value: String(row.active ?? 1) })}
      ${fieldHtml({ name: "entity", label: "Entité (entreprise)", value: row.entity || "", list: "dl-ent1", help: "Seuls les collaborateurs de l'entité facturée entrent dans la facture." })}
      ${fieldHtml({ name: "team", label: "Équipe", value: row.team || "", list: "dl-team1" })}
      <datalist id="dl-ent1">${[...new Set(all.map((c) => c.entity).filter(Boolean))].map((e) => `<option value="${esc(e)}">`).join("")}</datalist>
      <datalist id="dl-team1">${[...new Set(all.map((c) => c.team).filter(Boolean))].map((e) => `<option value="${esc(e)}">`).join("")}</datalist>
      ${fieldHtml({ name: "mode", label: "Mode de saisie des temps", type: "select", options: MODES, value: row.mode, full: true })}
      <div class="field full" id="fBase">${fieldHtml({ name: "prorata_base", label: "Base de répartition", type: "select", options: [["jira", "Heures Jira de toute l'équipe"], ["costed", "Heures des salariés ayant un coût (hors CX / freelances)"]], value: row.prorata_base })}</div>
      <div class="field full" id="fMirror">${fieldHtml({ name: "mirror_of", label: "Même répartition que", type: "select", options: ["", ...names], value: row.mirror_of || "" })}</div>
      ${fieldHtml({ name: "aliases", label: "Autres graphies (une par ligne)", type: "textarea", rows: 3, value: JSON.parse(row.aliases || "[]").join("\n"), full: true, help: "Ex. : jerome.martin, DUPONT Marie. Toutes ces graphies seront reconnues comme cette personne." })}
    </form>`,
    onMount: (ctx) => {
      const sync = () => { const m = $("[name=mode]", ctx.el).value; $("#fBase", ctx.el).style.display = m === "prorata" ? "" : "none"; $("#fMirror", ctx.el).style.display = m === "mirror" ? "" : "none"; };
      $("[name=mode]", ctx.el).onchange = sync; sync();
    },
    actions: [{ label: "Annuler" }, {
      label: "Enregistrer", kind: "primary", onClick: async (ctx) => {
        const form = $("form", ctx.el); if (!form.reportValidity()) return false;
        const d = Object.fromEntries(new FormData(form));
        const payload = { ...d, active: +d.active, aliases: d.aliases.split("\n").map((s) => s.trim()).filter(Boolean), mirror_of: d.mirror_of || null };
        if (!row._new) payload.id = row.id;
        await api("/api/ref/collaborators", { method: "POST", json: payload });
        return true;
      },
    }],
  });
  if (res) { toast("Collaborateur enregistré", "success"); rerender(); }
}
