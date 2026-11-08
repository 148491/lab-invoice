/* Lab Facturation — briques communes : API, état, formats, icônes, composants (modale, toast, combobox…). */

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ------------------------------------------------------------------ formats
const nf2 = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
export const fmt = {
  money: (v) => (v == null || isNaN(v) ? "—" : nf2.format(v)),
  money0: (v) => (v == null || isNaN(v) ? "—" : nf0.format(v)),
  num: (v) => (v == null || isNaN(v) ? "—" : nf1.format(v)),
  h: (v) => (v == null || isNaN(v) ? "—" : nf1.format(v) + " h"),
  pct: (v, d = 1) => (v == null || isNaN(v) ? "—" : (v * 100).toFixed(d).replace(".", ",") + " %"),
  date: (iso) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—"),
  datetime: (s) => { if (!s) return "—"; const d = new Date(s.replace(" ", "T") + "Z"); return d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }); },
  parse: (s) => { const v = parseFloat(String(s ?? "").replace(/[\s  ]/g, "").replace(",", ".")); return isNaN(v) ? null : v; },
};
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
export const month = {
  label: (m) => { const [y, mm] = m.split("-"); return `${MONTHS[+mm - 1]} ${y}`; },
  short: (m) => { const [y, mm] = m.split("-"); return `${MONTHS[+mm - 1].slice(0, 4).replace(/\.$/, "")}. ${y.slice(2)}`; },
  next: (m) => { let [y, mm] = m.split("-").map(Number); mm++; if (mm > 12) { mm = 1; y++; } return `${y}-${String(mm).padStart(2, "0")}`; },
  prev: (m) => { let [y, mm] = m.split("-").map(Number); mm--; if (mm < 1) { mm = 12; y--; } return `${y}-${String(mm).padStart(2, "0")}`; },
  current: () => new Date().toISOString().slice(0, 7),
  valid: (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m),
};

// ------------------------------------------------------------------ état global
export const S = { user: null, settings: {}, ai: false, months: [], route: "", params: [], cache: {} };
export const can = (p) => !!S.user && S.user.perms.includes(p);

// ------------------------------------------------------------------ API
export async function api(path, opts = {}) {
  const o = { credentials: "same-origin", ...opts };
  if (o.json !== undefined) { o.body = JSON.stringify(o.json); o.headers = { "Content-Type": "application/json" }; delete o.json; }
  if (o.form) { const fd = new FormData(); Object.entries(o.form).forEach(([k, v]) => v != null && fd.append(k, v)); o.body = fd; delete o.form; }
  const quiet = o.quiet; delete o.quiet;
  let r;
  try { r = await fetch(path, o); } catch (e) { toast("Serveur injoignable. Vérifiez votre connexion.", "error"); throw e; }
  if (r.status === 401 && !path.startsWith("/api/auth")) { window.dispatchEvent(new Event("auth:lost")); throw new Error("401"); }
  if (!r.ok) {
    let detail = r.statusText;
    try { const j = await r.json(); detail = j.detail ?? detail; } catch (_) { /* */ }
    const err = new Error(typeof detail === "string" ? detail : detail.message || "Erreur");
    err.detail = detail; err.status = r.status;
    if (!quiet) toast(err.message, "error");
    throw err;
  }
  return (r.headers.get("content-type") || "").includes("json") ? r.json() : r;
}

// ------------------------------------------------------------------ icônes (traits 24px, style « lucide »)
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>',
  invoice: '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/><path d="M9 13h7M9 17h7M9 9h2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 20a6.5 6.5 0 0 0-2.5-5.1"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  clipboard: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 10h6M9 14h6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
  chevL: '<path d="m15 6-6 6 6 6"/>', chevR: '<path d="m9 6 6 6-6 6"/>', chevD: '<path d="m6 9 6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>', sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  userPlus: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  printer: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  coins: '<ellipse cx="9" cy="6" rx="6" ry="3"/><path d="M3 6v4c0 1.7 2.7 3 6 3s6-1.3 6-3V6"/><path d="M9 13v4c0 1.7 2.7 3 6 3s6-1.3 6-3v-4c0-1.7-2.7-3-6-3"/>',
  pie: '<path d="M12 3v9h9a9 9 0 1 1-9-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/>',
  send: '<path d="M21 3 3 10.5l7 2.5 2.5 7z"/><path d="m21 3-11 10"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  file: '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  arrowR: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/>',
};
export const icon = (n, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ""}</svg>`;

// ------------------------------------------------------------------ toasts
export function toast(msg, kind = "info", { action, onAction, timeout } = {}) {
  let host = $("#toasts");
  if (!host) { host = document.createElement("div"); host.id = "toasts"; host.setAttribute("aria-live", "polite"); document.body.appendChild(host); }
  const t = document.createElement("div");
  t.className = `toast toast-${kind}`;
  t.innerHTML = `${icon(kind === "success" ? "check" : kind === "error" ? "error" : kind === "warning" ? "alert" : "info")}<div class="toast-msg">${esc(msg)}</div>${action ? `<button class="toast-act">${esc(action)}</button>` : ""}<button class="toast-x" aria-label="Fermer">${icon("x")}</button>`;
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add("in"));
  const close = () => { t.classList.remove("in"); setTimeout(() => t.remove(), 250); };
  $(".toast-x", t).onclick = close;
  if (action) $(".toast-act", t).onclick = () => { onAction?.(); close(); };
  setTimeout(close, timeout || (kind === "error" ? 8000 : 4000));
}

// ------------------------------------------------------------------ modale
export function modal({ title, body = "", size = "md", actions = [], onMount, dismissable = true }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `<div class="modal modal-${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header class="modal-head"><h2>${title}</h2>${dismissable ? `<button class="icon-btn" data-close aria-label="Fermer">${icon("x")}</button>` : ""}</header>
      <div class="modal-body">${body}</div>
      ${actions.length ? `<footer class="modal-foot">${actions.map((a, i) => `<button class="btn ${a.kind || ""}" data-act="${i}" ${a.disabled ? "disabled" : ""}>${a.icon ? icon(a.icon) : ""}${esc(a.label)}</button>`).join("")}</footer>` : ""}
    </div>`;
    document.body.appendChild(wrap);
    document.body.classList.add("no-scroll");
    requestAnimationFrame(() => wrap.classList.add("in"));
    const m = $(".modal", wrap);
    const close = (val) => {
      wrap.classList.remove("in");
      document.removeEventListener("keydown", onKey);
      setTimeout(() => { wrap.remove(); if (!$(".modal-backdrop")) document.body.classList.remove("no-scroll"); prevFocus?.focus?.(); }, 180);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape" && dismissable) close(undefined);
      if (e.key === "Tab") {
        const f = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', m).filter((x) => !x.disabled && x.offsetParent);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
        else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    if (dismissable) wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) close(undefined); });
    $$("[data-close]", wrap).forEach((b) => (b.onclick = () => close(undefined)));
    const ctx = { el: m, close, setBusy: (b) => $$(".modal-foot .btn", m).forEach((x) => (x.disabled = b)) };
    $$("[data-act]", wrap).forEach((b) => (b.onclick = async () => {
      const a = actions[+b.dataset.act];
      if (!a.onClick) return close(a.value);
      b.classList.add("loading"); ctx.setBusy(true);
      try { const v = await a.onClick(ctx); if (v !== false) close(v === undefined ? a.value : v); }
      catch (_) { /* erreur déjà affichée */ }
      finally { b.classList.remove("loading"); ctx.setBusy(false); }
    }));
    onMount?.(ctx);
    setTimeout(() => ($("[autofocus]", m) || $("input, select, textarea", m) || $(".modal-foot .btn.primary", m))?.focus(), 60);
  });
}

export const confirmDialog = (title, message, { danger = false, ok = "Confirmer" } = {}) =>
  modal({ title, body: `<p class="lead">${message}</p>`, size: "sm",
    actions: [{ label: "Annuler", value: false }, { label: ok, kind: danger ? "danger" : "primary", value: true }] }).then((v) => !!v);

/** Formulaire simple en modale : fields = [{name, label, type, value, options, help, required}] */
export function formDialog(title, fields, { ok = "Enregistrer", onSubmit, intro = "" } = {}) {
  const body = `${intro}<form class="form-grid" onsubmit="return false">${fields.map((f) => field(f)).join("")}</form>`;
  return modal({
    title, body, actions: [{ label: "Annuler" }, {
      label: ok, kind: "primary", onClick: async (ctx) => {
        const form = $("form", ctx.el);
        if (!form.reportValidity()) return false;
        const data = Object.fromEntries(fields.map((f) => [f.name, f.type === "checkbox" ? $(`[name="${f.name}"]`, form).checked : $(`[name="${f.name}"]`, form).value]));
        return onSubmit ? onSubmit(data, ctx) : data;
      },
    }],
  });
}

export function field(f) {
  const id = `f_${f.name}_${Math.random().toString(36).slice(2, 7)}`;
  const req = f.required ? "required" : "";
  let input;
  if (f.type === "select") input = `<select id="${id}" name="${f.name}" ${req}>${(f.options || []).map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(f.value ?? "") === String(v) ? "selected" : ""}>${esc(l)}</option>`; }).join("")}</select>`;
  else if (f.type === "textarea") input = `<textarea id="${id}" name="${f.name}" rows="${f.rows || 4}" placeholder="${esc(f.placeholder || "")}" ${req}>${esc(f.value ?? "")}</textarea>`;
  else if (f.type === "checkbox") return `<label class="check ${f.full ? "full" : ""}"><input type="checkbox" name="${f.name}" ${f.value ? "checked" : ""}><span>${esc(f.label)}</span></label>`;
  else input = `<input id="${id}" name="${f.name}" type="${f.type || "text"}" value="${esc(f.value ?? "")}" placeholder="${esc(f.placeholder || "")}" ${f.list ? `list="${f.list}"` : ""} ${f.autocomplete ? `autocomplete="${f.autocomplete}"` : ""} ${f.minlength ? `minlength="${f.minlength}"` : ""} ${req} ${f.autofocus ? "autofocus" : ""}>`;
  return `<div class="field ${f.full ? "full" : ""}"><label for="${id}">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ""}</label>${input}${f.help ? `<div class="help">${f.help}</div>` : ""}</div>`;
}

// ------------------------------------------------------------------ zone de dépôt
export function dropzone(el, onFile, accept = ".xlsx,.xlsm,.xls") {
  const input = document.createElement("input");
  input.type = "file"; input.accept = accept; input.hidden = true;
  el.appendChild(input);
  input.addEventListener("click", (e) => e.stopPropagation()); // évite que le clic remonte et rouvre le sélecteur
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.addEventListener("click", (e) => { if (e.target.closest("a,button:not(.drop-btn)")) return; input.click(); });
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  input.addEventListener("change", () => { input.files[0] && onFile(input.files[0]); input.value = ""; });
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("over"); });
  el.addEventListener("dragleave", () => el.classList.remove("over"));
  el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("over"); e.dataTransfer.files[0] && onFile(e.dataTransfer.files[0]); });
}

// ------------------------------------------------------------------ liste déroulante avec recherche
/** combobox(input, () => options[{value, label, sub, tag}], onPick) */
export function combobox(input, getOptions, onPick) {
  const list = document.createElement("div");
  list.className = "cb-list";
  list.setAttribute("role", "listbox");
  document.body.appendChild(list);
  input.setAttribute("autocomplete", "off");
  input.setAttribute("role", "combobox");
  let items = [], active = 0, open = false;
  const place = () => {
    const r = input.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    list.style.left = `${Math.max(8, r.left)}px`;
    list.style.width = `${Math.max(r.width, Math.min(460, window.innerWidth - 16))}px`;
    if (below < 240 && r.top > below) { list.style.top = ""; list.style.bottom = `${window.innerHeight - r.top + 4}px`; }
    else { list.style.bottom = ""; list.style.top = `${r.bottom + 4}px`; }
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    items = getOptions().filter((o) => { const t = `${o.label} ${o.sub || ""}`.toLowerCase(); return words.every((w) => t.includes(w)); }).slice(0, 60);
    active = Math.min(active, Math.max(items.length - 1, 0));
    list.innerHTML = items.length ? items.map((o, i) => `<div class="cb-item ${i === active ? "on" : ""}" role="option" data-i="${i}">
        <div class="cb-main">${esc(o.label)}</div>${o.sub || o.tag ? `<div class="cb-sub">${o.tag ? `<span class="chip chip-xs">${esc(o.tag)}</span>` : ""}${esc(o.sub || "")}</div>` : ""}</div>`).join("")
      : `<div class="cb-empty">Aucun résultat</div>`;
    place();
  };
  const show = () => { open = true; list.classList.add("open"); render(); };
  const hide = () => { open = false; list.classList.remove("open"); };
  const pick = (i) => { const o = items[i]; if (!o) return; input.value = o.value; hide(); onPick?.(o); input.dispatchEvent(new Event("change", { bubbles: true })); };
  input.addEventListener("focus", show);
  input.addEventListener("input", () => { active = 0; show(); });
  input.addEventListener("blur", () => setTimeout(hide, 150));
  input.addEventListener("keydown", (e) => {
    if (!open && (e.key === "ArrowDown")) { show(); return; }
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); render(); $(".cb-item.on", list)?.scrollIntoView({ block: "nearest" }); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); render(); $(".cb-item.on", list)?.scrollIntoView({ block: "nearest" }); }
    else if (e.key === "Enter") { if (items[active]) { e.preventDefault(); pick(active); } }
    else if (e.key === "Escape") hide();
  });
  list.addEventListener("mousedown", (e) => { const it = e.target.closest(".cb-item"); if (it) { e.preventDefault(); pick(+it.dataset.i); } });
  window.addEventListener("scroll", () => open && place(), true);
  const obs = new MutationObserver(() => { if (!document.body.contains(input)) { list.remove(); obs.disconnect(); } });
  obs.observe(document.body, { childList: true, subtree: true });
  return { close: hide };
}

// ------------------------------------------------------------------ petits composants
export const chip = (text, kind = "", ic = "") => `<span class="chip ${kind ? "chip-" + kind : ""}">${ic ? icon(ic) : ""}${esc(text)}</span>`;
export const statusChip = (s) => ({ PRODUCTION: chip("En ligne", "success"), "IN PROGRESS": chip("En cours", "info"), ABANDONED: chip("Abandonné", "danger"), validated: chip("Validée", "success", "lock"), draft: chip("Brouillon", "warning") }[s] || chip(s || "—"));
export const empty = (title, text = "", ic = "folder", actionHtml = "") => `<div class="empty"><div class="empty-ic">${icon(ic)}</div><div class="empty-title">${esc(title)}</div>${text ? `<div class="empty-text">${text}</div>` : ""}${actionHtml}</div>`;
export const skeleton = (n = 4) => `<div class="skel-wrap">${'<div class="skel"></div>'.repeat(n)}</div>`;
export const initials = (name) => (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
export const avatar = (name, cls = "") => { let h = 0; for (const c of name || "") h = (h * 31 + c.charCodeAt(0)) % 360; return `<span class="avatar ${cls}" style="--h:${h}">${esc(initials(name))}</span>`; };

export function progressRing(value, max, size = 120, label = "") {
  const r = (size - 14) / 2, c = 2 * Math.PI * r;
  const ratio = max ? Math.min(value / max, 1.25) : 0;
  const kind = !max ? "" : ratio > 1.2 ? "danger" : ratio >= 0.8 ? "success" : "warning";
  return `<div class="ring ring-${kind}" style="width:${size}px;height:${size}px">
    <svg viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-bg"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-fg" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - Math.min(ratio, 1))}"/></svg>
    <div class="ring-txt"><strong>${fmt.num(value)}</strong><span>${label || `sur ${fmt.num(max)} h`}</span></div></div>`;
}

/** Barre heures déclarées vs attendues */
export function hoursBar(h, expected, tol = 0.2) {
  const ratio = expected ? h / expected : 0;
  const kind = ratio > 1 + tol ? "danger" : ratio >= 1 - tol ? "success" : ratio > 0 ? "warning" : "muted";
  return `<div class="hbar" title="${fmt.h(h)} / ${fmt.h(expected)}"><div class="hbar-fill hbar-${kind}" style="width:${Math.min(ratio, 1.3) / 1.3 * 100}%"></div><div class="hbar-mark" style="left:${100 / 1.3}%"></div></div>`;
}

export function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

export async function download(url, opts = {}) {
  const r = await api(url, opts);
  const blob = await r.blob();
  const name = (r.headers.get("content-disposition") || "").match(/filename="([^"]+)"/)?.[1] || "export.xlsx";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Bouton + / − : passe au multiple de 0,5 suivant ou précédent (0,29 → 0,5 → 1 ; 0,57 → 0,5 → 0). */
export function stepHalf(v, dir, step = 0.5) {
  const x = +v || 0, eps = 1e-9;
  const n = dir > 0 ? Math.floor(x / step + eps) + 1 : Math.ceil(x / step - eps) - 1;
  return Math.max(0, Math.round(n * step * 100) / 100);
}
