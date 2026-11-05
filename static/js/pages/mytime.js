import { $, S, api, can, esc, icon, month, empty, avatar } from "../core.js";
import { go } from "../app.js";
import { sheetEditor } from "./sheet.js";

export async function render(view, { params }) {
  // en début de mois on déclare le mois écoulé
  const dflt = new Date().getDate() <= 12 ? month.prev(month.current()) : month.current();
  const m = month.valid(params[0] || "") ? params[0] : (S.months.find((x) => x.status === "draft")?.month || dflt);
  let who = params[1] ? decodeURIComponent(params[1]) : S.user.collaborator;
  const collabs = can("time.all") ? (await api("/api/ref/collaborators")).filter((c) => c.active) : [];
  if (!who && collabs.length) who = null;

  view.innerHTML = `<div class="page-head"><div class="grow"><div class="crumbs">${icon("clock")}Temps</div>
      <h1>${can("time.all") && who !== S.user.collaborator ? "Saisie des temps" : "Mes temps"}</h1>
      <div class="sub">Déclarez les heures passées sur chaque projet pour le mois.</div></div>
    <div class="toolbar">
      ${collabs.length ? `<select id="who" style="min-width:220px" aria-label="Collaborateur"><option value="">— Choisir un collaborateur —</option>${collabs.map((c) => `<option ${c.name === who ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>` : ""}
      <div class="row" style="gap:4px"><button class="icon-btn" id="pm" aria-label="Mois précédent">${icon("chevL")}</button>
      <input type="month" id="mm" value="${m}" style="width:170px" aria-label="Mois"><button class="icon-btn" id="nm" aria-label="Mois suivant">${icon("chevR")}</button></div></div></div>
    <div id="editor"></div>`;
  const nav = (mm, w = who) => go(`mes-temps/${mm}${w ? "/" + encodeURIComponent(w) : ""}`);
  $("#pm", view).onclick = () => nav(month.prev(m));
  $("#nm", view).onclick = () => nav(month.next(m));
  $("#mm", view).onchange = (e) => month.valid(e.target.value) && nav(e.target.value);
  $("#who", view)?.addEventListener("change", (e) => nav(m, e.target.value));

  const ed = $("#editor", view);
  if (!who) {
    ed.innerHTML = `<div class="card">${empty(collabs.length ? "Choisissez un collaborateur" : "Compte non rattaché",
      collabs.length ? "Sélectionnez la personne pour qui vous saisissez des temps." : "Votre compte n'est pas encore rattaché à un collaborateur. Demandez à un administrateur de le faire dans « Comptes & droits ».", "users")}</div>`;
    return;
  }
  if (who !== S.user.collaborator) ed.insertAdjacentHTML("beforebegin", `<div class="alert alert-info" style="margin-bottom:14px">${avatar(who)}<div class="grow">Vous saisissez pour <b>${esc(who)}</b>.</div></div>`);
  await sheetEditor(ed, m, who);
}
