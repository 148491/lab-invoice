/* Lab Facturation — coquille : authentification, navigation, routeur, palette de commandes. */
import { $, $$, S, api, can, esc, icon, avatar, month, toast, modal, formDialog, confirmDialog } from "./core.js";
import * as dashboard from "./pages/dashboard.js";
import * as monthPage from "./pages/month.js";
import * as mytime from "./pages/mytime.js";
import * as refs from "./pages/refs.js";
import * as admin from "./pages/admin.js";

const ROUTES = {
  "tableau-de-bord": { title: "Tableau de bord", icon: "home", perm: "view", page: dashboard },
  mois: { title: "Facture du mois", icon: "invoice", perm: "view", page: monthPage },
  "mes-temps": { title: "Temps", icon: "clock", perm: "time.self", page: mytime },
  projets: { title: "Projets", icon: "folder", perm: "view", page: refs, arg: "projects", group: "Référentiels" },
  epics: { title: "Epics Jira", icon: "tag", perm: "view", page: refs, arg: "epics", group: "Référentiels" },
  collaborateurs: { title: "Collaborateurs", icon: "users", perm: "view", page: refs, arg: "collaborators", group: "Référentiels" },
  comptes: { title: "Comptes & droits", icon: "shield", perm: "users", page: admin, arg: "users", group: "Administration" },
  journal: { title: "Journal", icon: "history", perm: "users", page: admin, arg: "audit", group: "Administration" },
  parametres: { title: "Paramètres", icon: "settings", perm: "users", page: admin, arg: "settings", group: "Administration" },
};
const defaultRoute = () => (can("view") ? "tableau-de-bord" : "mes-temps");

// ------------------------------------------------------------------ thème
const theme = {
  get: () => localStorageGet("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  apply: (t) => { document.documentElement.dataset.theme = t; },
  toggle: () => { const t = theme.get() === "dark" ? "light" : "dark"; localStorageSet("theme", t); theme.apply(t); },
};
function localStorageGet(k) { try { return localStorage.getItem("lab." + k); } catch (_) { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem("lab." + k, v); } catch (_) { /* */ } }
theme.apply(theme.get());

// ------------------------------------------------------------------ démarrage
async function boot() {
  const st = await api("/api/auth/state");
  S.ai = st.ai;
  if (st.needs_setup) return renderSetup();
  if (!st.user) return renderLogin();
  S.user = st.user;
  S.settings = await api("/api/settings");
  if (can("view")) S.months = await api("/api/months").catch(() => []);
  renderShell();
  if (!location.hash || location.hash === "#") location.hash = "#/" + defaultRoute();
  else route();
  if (S.user.must_change) setTimeout(changePassword, 400);
}
window.addEventListener("auth:lost", () => { S.user = null; toast("Session expirée : reconnectez-vous.", "warning"); renderLogin(); });

// ------------------------------------------------------------------ écrans d'accès
const authArt = `<div class="auth-art">
  <div class="brand"><div class="brand-logo">LF</div><div><div class="brand-name">Lab Facturation</div><div class="brand-sub">Refacturation par projet</div></div></div>
  <div><h1>Des temps de l'équipe à la facture du mois, sans tableur.</h1>
    <p>Temps Jira et saisies de chacun, coûts employeur, CAPEX et frais généraux : tout est rapproché, contrôlé et réparti par projet.</p></div>
  <div class="auth-feats">
    <div class="auth-feat">${icon("check")}<div>Chaque collaborateur saisit ses temps, depuis son ordinateur ou son téléphone.</div></div>
    <div class="auth-feat">${icon("check")}<div>Noms rapprochés automatiquement entre Jira, la paie et les saisies.</div></div>
    <div class="auth-feat">${icon("check")}<div>Contrôles bloquants avant validation, facture figée et exportable.</div></div>
  </div></div>`;

function renderLogin() {
  document.body.innerHTML = `<div class="auth">${authArt}<div class="auth-form"><form class="auth-box" id="loginForm">
    <div class="only-mobile brand" style="color:var(--text);padding:0 0 24px"><div class="brand-logo">LF</div><div class="brand-name">Lab Facturation</div></div>
    <h2>Connexion</h2><p class="muted" style="margin-bottom:22px">Accédez à votre espace.</p>
    <div class="stack" style="gap:14px">
      <div class="field"><label for="u">Identifiant</label><input id="u" name="username" autocomplete="username" required autofocus></div>
      <div class="field"><label for="p">Mot de passe</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
      <div id="loginErr"></div>
      <button class="btn primary lg block" type="submit">Se connecter</button>
      <p class="faint small" style="text-align:center">Mot de passe oublié ? Demandez à un administrateur de le réinitialiser.</p>
    </div></form></div></div>`;
  $("#loginForm").onsubmit = async (e) => {
    e.preventDefault();
    const b = $("button[type=submit]", e.target); b.classList.add("loading");
    try {
      await api("/api/auth/login", { method: "POST", json: { username: $("#u").value, password: $("#p").value }, quiet: true });
      location.reload();
    } catch (err) {
      $("#loginErr").innerHTML = `<div class="alert alert-danger">${icon("error")}<div>${esc(err.message)}</div></div>`;
      b.classList.remove("loading");
    }
  };
}

function renderSetup() {
  document.body.innerHTML = `<div class="auth">${authArt}<div class="auth-form"><form class="auth-box" id="setupForm">
    <h2>Bienvenue 👋</h2><p class="muted" style="margin-bottom:22px">Créez le compte administrateur pour démarrer.</p>
    <div class="stack" style="gap:14px">
      <div class="field"><label>Nom affiché</label><input name="display_name" required autofocus></div>
      <div class="field"><label>Identifiant</label><input name="username" autocomplete="username" required></div>
      <div class="field"><label>Mot de passe</label><input name="password" type="password" minlength="8" autocomplete="new-password" required><div class="help">8 caractères minimum.</div></div>
      <button class="btn primary lg block" type="submit">Créer et continuer</button></div></form></div></div>`;
  $("#setupForm").onsubmit = async (e) => {
    e.preventDefault();
    await api("/api/auth/setup", { method: "POST", json: Object.fromEntries(new FormData(e.target)) });
    location.reload();
  };
}

async function changePassword() {
  await formDialog("Changer de mot de passe", [
    { name: "current", label: "Mot de passe actuel", type: "password", required: true, full: true, autocomplete: "current-password" },
    { name: "new", label: "Nouveau mot de passe", type: "password", required: true, minlength: 8, full: true, autocomplete: "new-password", help: "8 caractères minimum." },
  ], {
    intro: S.user.must_change ? `<div class="alert alert-info" style="margin-bottom:14px">${icon("key")}<div>Votre mot de passe a été défini par un administrateur : choisissez le vôtre.</div></div>` : "",
    onSubmit: async (d) => { await api("/api/auth/password", { method: "POST", json: d }); S.user.must_change = false; toast("Mot de passe modifié", "success"); },
  });
}

// ------------------------------------------------------------------ coquille
function navHtml() {
  const items = Object.entries(ROUTES).filter(([, r]) => can(r.perm));
  let html = "", grp = null;
  for (const [k, r] of items) {
    if ((r.group || null) !== grp) { grp = r.group || null; if (grp) html += `<div class="nav-sec">${grp}</div>`; }
    const title = k === "mes-temps" ? (can("time.all") ? "Saisie des temps" : "Mes temps") : r.title;
    html += `<a href="#/${k}" data-r="${k}">${icon(r.icon)}<span>${title}</span>${k === "mois" ? '<span class="badge neutral" id="navDraft" hidden></span>' : ""}</a>`;
  }
  return html;
}

function renderShell() {
  const u = S.user;
  const bottom = [
    can("view") && ["tableau-de-bord", "home", "Accueil"],
    can("view") && ["mois", "invoice", "Facture"],
    ["mes-temps", "clock", can("time.all") ? "Temps" : "Mes temps"],
    can("view") && ["projets", "folder", "Projets"],
  ].filter(Boolean);
  document.body.innerHTML = `<div class="shell" id="shell">
    <aside class="side" aria-label="Navigation">
      <div class="brand"><div class="brand-logo">LF</div><div><div class="brand-name">Lab Facturation</div><div class="brand-sub">${esc(S.settings.client_name || "Refacturation par projet")}</div></div></div>
      ${can("view") ? `<button class="kbd-hint" id="openPalette">${icon("search")}Rechercher… <kbd>⌘K</kbd></button>` : ""}
      <nav class="nav" id="nav">${navHtml()}</nav>
      <div class="side-foot"><button class="me" id="meBtn">${avatar(u.display_name)}<div style="min-width:0;flex:1"><div class="me-name ellipsis">${esc(u.display_name)}</div><div class="me-role">${esc(u.role_label)}</div></div>${icon("more")}</button></div>
    </aside>
    <div class="side-scrim" id="scrim"></div>
    <div class="main">
      <header class="topbar"><button class="icon-btn" id="burger" aria-label="Menu">${icon("menu")}</button><div class="brand-logo">LF</div><div class="topbar-title" id="topTitle"></div>
        ${can("view") ? `<button class="icon-btn" id="openPalette2" aria-label="Rechercher">${icon("search")}</button>` : ""}<button class="icon-btn" id="meBtn2" aria-label="Mon compte">${avatar(u.display_name)}</button></header>
      <main class="content" id="view"></main>
    </div>
    <nav class="bottom-nav" id="bottomNav">${bottom.map(([k, ic, l]) => `<a href="#/${k}" data-r="${k}">${icon(ic)}<span>${l}</span></a>`).join("")}</nav>
  </div>`;
  const shell = $("#shell");
  $("#burger").onclick = () => shell.classList.add("side-open");
  $("#scrim").onclick = () => shell.classList.remove("side-open");
  $$("#nav a").forEach((a) => a.addEventListener("click", () => shell.classList.remove("side-open")));
  $("#meBtn").onclick = userMenu; $("#meBtn2").onclick = userMenu;
  $("#openPalette")?.addEventListener("click", palette);
  $("#openPalette2")?.addEventListener("click", palette);
  updateNavBadge();
}

export function updateNavBadge() {
  const b = $("#navDraft"); if (!b) return;
  const d = S.months.find((m) => m.status === "draft");
  b.hidden = !d; if (d) b.textContent = month.short(d.month);
}

async function userMenu() {
  const u = S.user;
  const v = await modal({
    title: "Mon compte", size: "sm",
    body: `<div class="row" style="gap:14px;margin-bottom:18px">${avatar(u.display_name, "lg")}<div><div style="font-weight:650;font-size:15px">${esc(u.display_name)}</div><div class="muted small">${esc(u.username)} · ${esc(u.role_label)}</div>${u.collaborator ? `<div class="faint xs">Collaborateur : ${esc(u.collaborator)}</div>` : ""}</div></div>
      <div class="list card">
        <button class="list-item btn ghost" style="height:auto;justify-content:flex-start;border-radius:0" data-v="theme">${icon(theme.get() === "dark" ? "sun" : "moon")}<span class="grow" style="text-align:left">Thème ${theme.get() === "dark" ? "clair" : "sombre"}</span></button>
        <button class="list-item btn ghost" style="height:auto;justify-content:flex-start;border-radius:0" data-v="pwd">${icon("key")}<span class="grow" style="text-align:left">Changer de mot de passe</span></button>
        <button class="list-item btn ghost" style="height:auto;justify-content:flex-start;border-radius:0;color:var(--danger)" data-v="logout">${icon("logout")}<span class="grow" style="text-align:left">Se déconnecter</span></button>
      </div>`,
    onMount: (ctx) => $$("[data-v]", ctx.el).forEach((b) => (b.onclick = () => ctx.close(b.dataset.v))),
  });
  if (v === "theme") theme.toggle();
  if (v === "pwd") changePassword();
  if (v === "logout") { await api("/api/auth/logout", { method: "POST" }); location.hash = ""; location.reload(); }
}

// ------------------------------------------------------------------ routeur
let renderToken = 0;
export function go(path) { if (location.hash === "#/" + path) route(); else location.hash = "#/" + path; }
window.addEventListener("hashchange", route);

async function route() {
  if (!S.user) return;
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  let key = parts[0] || defaultRoute();
  if (!ROUTES[key] || !can(ROUTES[key].perm)) key = defaultRoute();
  S.route = key; S.params = parts.slice(1);
  const r = ROUTES[key];
  $$("#nav a, #bottomNav a").forEach((a) => a.classList.toggle("on", a.dataset.r === key));
  const tt = $("#topTitle"); if (tt) tt.textContent = key === "mes-temps" && !can("time.all") ? "Mes temps" : r.title;
  document.title = `${r.title} · Lab Facturation`;
  const root = $("#view");
  const my = ++renderToken;
  // conteneur neuf à chaque rendu : un rendu plus lent resté en vol écrit dans un nœud détaché
  const view = document.createElement("div");
  view.className = "fade-in";
  root.replaceChildren(view);
  try {
    await r.page.render(view, { arg: r.arg, params: S.params, isCurrent: () => my === renderToken });
  } catch (e) {
    if (e.message === "401") return;
    console.error(e);
    view.innerHTML = `<div class="alert alert-danger">${icon("error")}<div class="grow"><div class="alert-title">Impossible d'afficher la page</div><div>${esc(e.message)}</div></div></div>`;
  }
  window.scrollTo({ top: 0 });
}
export const rerender = () => route();

// ------------------------------------------------------------------ palette de commandes (⌘K)
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && S.user && can("view")) { e.preventDefault(); palette(); }
});

function palette() {
  if ($(".palette")) return;
  const el = document.createElement("div");
  el.className = "palette";
  el.innerHTML = `<div class="palette-box" role="dialog" aria-label="Recherche"><div class="palette-in">${icon("search")}<input placeholder="Aller à une page, un mois, un projet, un collaborateur…" aria-label="Recherche"><kbd>Échap</kbd></div><div class="palette-list"></div></div>`;
  document.body.appendChild(el);
  const input = $("input", el), list = $(".palette-list", el);
  let items = [], active = 0, remote = [];
  const base = () => {
    const pages = Object.entries(ROUTES).filter(([, r]) => can(r.perm)).map(([k, r]) => ({ grp: "Pages", label: r.title, icon: r.icon, go: k }));
    const months = (S.months || []).slice(0, 24).map((m) => ({ grp: "Mois", label: `Facture de ${month.label(m.month)}`, icon: "invoice", sub: m.status === "validated" ? "validée" : "brouillon", go: `mois/${m.month}` }));
    const actions = [
      { grp: "Actions", label: "Importer le timesheet du mois", icon: "upload", go: `mois/${(S.months.find((m) => m.status === "draft") || S.months[0] || { month: month.current() }).month}/temps` },
      { grp: "Actions", label: "Saisir mes temps", icon: "clock", go: "mes-temps" },
      { grp: "Actions", label: "Changer de thème", icon: "moon", run: theme.toggle },
    ];
    return [...actions, ...pages, ...months];
  };
  const typeIcon = { collaborateur: "users", projet: "folder", epic: "tag" };
  const typeGo = { collaborateur: "collaborateurs", projet: "projets", epic: "epics" };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    items = base().filter((i) => !q || `${i.label} ${i.sub || ""}`.toLowerCase().includes(q)).slice(0, 14)
      .concat(remote.map((r) => ({ grp: "Résultats", label: r.label, sub: r.sub, icon: typeIcon[r.type], go: `${typeGo[r.type]}/${encodeURIComponent(r.label)}` })));
    active = Math.min(active, Math.max(0, items.length - 1));
    let g = null;
    list.innerHTML = items.map((it, i) => { const h = it.grp !== g ? `<div class="palette-grp">${it.grp}</div>` : ""; g = it.grp; return `${h}<div class="palette-item ${i === active ? "on" : ""}" data-i="${i}">${icon(it.icon || "arrowR")}<span>${esc(it.label)}</span>${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ""}</div>`; }).join("") || `<div class="cb-empty">Aucun résultat</div>`;
  };
  let t;
  input.addEventListener("input", () => {
    active = 0; draw(); clearTimeout(t);
    t = setTimeout(async () => { const q = input.value.trim(); remote = q.length >= 2 ? await api(`/api/search?q=${encodeURIComponent(q)}`).catch(() => []) : []; draw(); }, 180);
  });
  const run = (i) => { const it = items[i]; if (!it) return; close(); if (it.run) it.run(); else go(it.go); };
  const close = () => el.remove();
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); draw(); }
    else if (e.key === "Enter") { e.preventDefault(); run(active); }
    else if (e.key === "Escape") close();
  });
  list.addEventListener("click", (e) => { const it = e.target.closest(".palette-item"); if (it) run(+it.dataset.i); });
  el.addEventListener("mousedown", (e) => { if (e.target === el) close(); });
  draw(); input.focus();
}

export { confirmDialog };
boot();
