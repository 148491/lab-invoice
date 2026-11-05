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
    cols: [["lot", "Lot / projet"], ["status", "Statut"], ["mel_date", "Mise en ligne"], ["category", "Catégorie"]],
    filters: [["", "Tous"], ["IN PROGRESS", "En cours"], ["PRODUCTION", "En ligne"], ["ABANDONED", "Abandonnés"]],
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
    help: "Les catégories <b>Agile, Support et CX</b> produisent un lot mensuel « NOM - MM/AA ».",
    cols: [["label", "Epic"], ["lot_name", "Lot facturé"], ["category", "Catégorie"], ["status", "Statut"], ["mel_date", "Mise en ligne"]],
    filters: [["", "Toutes"], ["IN PROGRESS", "En cours"], ["PRODUCTION", "En ligne"]],
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
    help: "<b>Jira</b> : temps importés · <b>Saisie</b> : temps déclarés dans l'application · <b>Prorata</b> : coût réparti selon les heures de l'équipe · <b>Miroir</b> : même répartition qu'un autre collaborateur.",
    cols: [["name", "Nom"], ["role", "Rôle"], ["mode", "Mode"], ["aliases", "Alias"], ["active", "Statut"]],
    filters: [["1", "Actifs"], ["0", "Inactifs"], ["", "Tous"]],
  },
};

let state = { table: null, q: "", f: null, limit: 150 };

export async function render(view, { arg, params }) {
  const cfg = CFG[arg];
  if (state.table !== arg) state = { table: arg, q: params[0] ? decodeURIComponent(params[0]) : "", f: cfg.filters[0][0], limit: 150 };
  else if (params[0]) state.q = decodeURIComponent(params[0]);
  const data = await api(`/api/ref/${arg}`);
  const editable = can("ref");
  view.innerHTML = `<div class="page-head"><div class="grow"><div class="crumbs">${icon("layers")}Référentiels</div><h1>${cfg.title}</h1><div class="sub">${cfg.sub}</div></div>
      ${editable ? `<div class="toolbar"><button class="btn primary" id="add">${icon("plus")}Ajouter</button></div>` : ""}</div>
    <div class="alert alert-info" style="margin-bottom:16px">${icon("info")}<div>${cfg.help}</div></div>
    <div class="card"><div class="card-head"><div class="input-icon" style="flex:1;min-width:220px;max-width:420px">${icon("search")}<input id="q" placeholder="Rechercher…" value="${esc(state.q)}"></div>
      <div class="seg">${cfg.filters.map(([v, l]) => `<button data-f="${v}" class="${state.f === v ? "on" : ""}">${l}</button>`).join("")}</div><span class="faint small" id="count"></span></div>
      <div class="table-wrap tall"><table class="t responsive"><thead><tr>${cfg.cols.map(([, l]) => `<th>${l}</th>`).join("")}<th></th></tr></thead><tbody id="body"></tbody></table></div></div>`;

  const filtered = () => {
    const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    return data.filter((r) => {
      if (state.f !== "" && state.f != null) { if (arg === "collaborators" ? String(r.active) !== state.f : r.status !== state.f) return false; }
      const txt = Object.values(r).join(" ").toLowerCase();
      return words.every((w) => txt.includes(w));
    });
  };
  const cell = (r, k) => {
    const v = r[k];
    if (k === "status") return statusChip(v);
    if (k === "mel_date") return v ? fmt.date(v) : '<span class="faint">—</span>';
    if (k === "category") return v ? chip(v) : "";
    if (k === "name") return `<div class="person">${avatar(v)}<b>${esc(v)}</b></div>`;
    if (k === "mode") return chip({ jira: "Jira", manual: "Saisie", prorata: "Prorata", mirror: `Miroir · ${r.mirror_of || "?"}` }[v] || v, v === "jira" ? "" : "brand");
    if (k === "aliases") { const a = JSON.parse(v || "[]"); return a.length ? `<span class="xs faint">${a.map(esc).join(", ")}</span>` : ""; }
    if (k === "active") return v ? chip("Actif", "success") : chip("Inactif");
    if (k === "label" || k === "lot") return `<span style="font-weight:550">${esc(v)}</span>`;
    return esc(v ?? "");
  };
  const draw = () => {
    const rows = filtered();
    $("#count", view).textContent = `${rows.length} élément${rows.length > 1 ? "s" : ""}`;
    $("#body", view).innerHTML = rows.slice(0, state.limit).map((r, i) => `<tr class="${editable ? "clickable" : ""}" data-i="${data.indexOf(r)}">${cfg.cols.map(([k, l], j) => `<td data-l="${l}" class="${j === 0 ? "primary-cell" : ""}">${cell(r, k)}</td>`).join("")}<td class="actions">${editable ? icon("chevR", "faint") : ""}</td></tr>`).join("")
      + (rows.length > state.limit ? `<tr><td colspan="9" style="text-align:center"><button class="btn sm" id="more">Afficher plus (${rows.length - state.limit})</button></td></tr>` : "")
      + (!rows.length ? `<tr><td colspan="9">${empty("Aucun résultat", "Modifiez la recherche ou le filtre.", "search")}</td></tr>` : "");
    $("#more", view)?.addEventListener("click", () => { state.limit += 300; draw(); });
    if (editable) $$("#body tr[data-i]", view).forEach((tr) => (tr.onclick = () => edit(arg, data[+tr.dataset.i], data)));
  };
  draw();
  $("#q", view).oninput = debounce((e) => { state.q = e.target.value; state.limit = 150; draw(); }, 120);
  $$("[data-f]", view).forEach((b) => (b.onclick = () => { state.f = b.dataset.f; $$("[data-f]", view).forEach((x) => x.classList.toggle("on", x === b)); draw(); }));
  $("#add", view)?.addEventListener("click", () => (arg === "collaborators" ? addCollaborator(data) : edit(arg, null, data)));
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
  return editCollaborator({ name: d.name, role: "", mode: "jira", prorata_base: "costed", aliases: "[]", active: 1, _new: true }, all);
}

async function editCollaborator(row, all) {
  const names = all.filter((c) => c.active && c.name !== row.name).map((c) => c.name);
  const res = await modal({
    title: row._new ? "Nouveau collaborateur" : row.name, size: "md",
    body: `<form class="form-grid" onsubmit="return false">
      ${fieldHtml({ name: "name", label: "Nom officiel", value: row.name, required: true, full: true, help: row._new ? "" : "Renommer conserve l'ancien nom en alias et met à jour les temps." })}
      ${fieldHtml({ name: "role", label: "Rôle", value: row.role, placeholder: "Developeur, QA, CTO…" })}
      ${fieldHtml({ name: "active", label: "Statut", type: "select", options: [["1", "Actif"], ["0", "Inactif"]], value: String(row.active ?? 1) })}
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
