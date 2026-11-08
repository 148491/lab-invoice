/* Analyse des projets (prototype) : build / run, projets, activités récurrentes, domaines, équipe. */
import { $, S, api, esc, icon, empty } from "../core.js";

// Run = bug fixes uniquement ; tout le reste (projets, évolutions mineures, autres activités) = build
const TYPES = [["Projet", "--s1", "Projets"], ["Agile", "--s2", "Évolutions mineures"], ["Support", "--s3", "Bug fixes (run)"], ["Run", "--s4", "Autres activités récurrentes"]];
const isRun = (k) => k === "Support";
const MN = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const ml = (m) => `${MN[+m.slice(5) - 1]} ${m.slice(2, 4)}`;
const nf0 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const money = (v) => nf0.format(v);
const kmoney = (v) => Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2).replace(".", ",") + " M" : Math.abs(v) >= 1e4 ? nf0.format(v / 1e3) + " k" : nf0.format(v);
const pct = (v) => (v * 100).toFixed(1).replace(".", ",") + " %";
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);

let DATA = null, MONTHS = [], ROOT = null;
const st = { from: null, to: null, types: new Set(TYPES.map((t) => t[0])), tab: "overview", sort: { k: "price", d: -1 }, q: "", status: "all", tables: {}, quick: "all" };

export async function render(view) {
  view.innerHTML = `<div class="skel-wrap"><div class="skel" style="height:60px"></div><div class="skel" style="height:320px"></div></div>`;
  DATA = await api("/api/analytics");
  MONTHS = DATA.months.map((x) => x.m);
  if (!MONTHS.length) { view.innerHTML = `<div class="card">${empty("Pas encore de données", "Les analyses portent sur les factures validées. Validez une facture ou lancez la reprise des fichiers Excel (Paramètres).", "pie")}</div>`; return; }
  if (!st.from || !MONTHS.includes(st.from)) { st.from = MONTHS[0]; st.to = MONTHS.at(-1); }
  ROOT = view;
  view.innerHTML = `<div class="an">
    <div class="page-head"><div class="grow"><div class="crumbs">${icon("pie")}Analyse <span class="chip chip-warning chip-xs" style="margin-left:6px">Prototype</span></div><h1>Analyse des projets</h1>
      <div class="sub">Où part le budget : build et run, projets, activités récurrentes, domaines, équipe. Factures validées uniquement.</div></div></div>
    <div class="an-filters card" role="toolbar" aria-label="Filtres">
      <label for="anFrom">Période</label><select id="anFrom"></select><span class="faint">→</span><select id="anTo"></select>
      <div class="seg" id="anQuick">${[["3", "3 mois"], ["6", "6 mois"], ["12", "12 mois"], ["all", "Tout"]].map(([k, l]) => `<button data-q="${k}" class="${st.quick === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <div class="row" style="gap:6px;flex-wrap:wrap;margin-left:auto"><span class="small muted" style="font-weight:600">Types</span><div id="anTypes" class="row" style="gap:6px;flex-wrap:wrap"></div></div></div>
    <div class="tabs" id="anTabs">${[["overview", "Vue d'ensemble"], ["projects", "Projets"], ["recurring", "Activités récurrentes"], ["domains", "Domaines"], ...(DATA.team.length ? [["team", "Équipe"]] : [])].map(([k, l]) => `<button data-t="${k}" class="${st.tab === k ? "on" : ""}">${l}</button>`).join("")}</div>
    <div id="anView"></div></div>`;
  const fill = (el, v) => { el.innerHTML = MONTHS.map((m) => `<option value="${m}" ${m === v ? "selected" : ""}>${ml(m)}</option>`).join(""); };
  fill($("#anFrom", view), st.from); fill($("#anTo", view), st.to);
  $("#anFrom", view).onchange = (e) => { st.from = e.target.value; if (st.from > st.to) { st.to = st.from; fill($("#anTo", view), st.to); } setQuick(null); draw(); };
  $("#anTo", view).onchange = (e) => { st.to = e.target.value; if (st.to < st.from) { st.from = st.to; fill($("#anFrom", view), st.from); } setQuick(null); draw(); };
  const setQuick = (q) => { st.quick = q; view.querySelectorAll("#anQuick button").forEach((b) => b.classList.toggle("on", b.dataset.q === q)); };
  view.querySelectorAll("#anQuick button").forEach((b) => b.onclick = () => {
    setQuick(b.dataset.q); st.to = MONTHS.at(-1); st.from = b.dataset.q === "all" ? MONTHS[0] : MONTHS[Math.max(0, MONTHS.length - +b.dataset.q)];
    fill($("#anFrom", view), st.from); fill($("#anTo", view), st.to); draw();
  });
  $("#anTypes", view).innerHTML = TYPES.map(([k, c, l]) => `<button class="typechip ${st.types.has(k) ? "" : "off"}" data-k="${k}" aria-pressed="${st.types.has(k)}"><span class="sw" style="background:var(${c})"></span>${l}</button>`).join("");
  view.querySelectorAll("#anTypes .typechip").forEach((b) => b.onclick = () => {
    const k = b.dataset.k; if (st.types.has(k) && st.types.size === 1) return;
    st.types.has(k) ? st.types.delete(k) : st.types.add(k);
    b.classList.toggle("off", !st.types.has(k)); b.setAttribute("aria-pressed", st.types.has(k)); draw();
  });
  view.querySelectorAll("#anTabs button").forEach((b) => b.onclick = () => { view.querySelectorAll("#anTabs button").forEach((x) => x.classList.toggle("on", x === b)); st.tab = b.dataset.t; draw(); });
  ensureOverlays();
  draw();
}

const inRange = (m) => m >= st.from && m <= st.to;
const months = () => MONTHS.filter(inRange);
const lots = () => DATA.lots.filter((l) => inRange(l.m) && st.types.has(l.kind));
const typeOf = (k) => TYPES.find((t) => t[0] === k);

// ---------------------------------------------------------------- infobulle et panneau latéral (partagés)
let tip, drawer;
function ensureOverlays() {
  tip = document.getElementById("anTip") || Object.assign(document.body.appendChild(document.createElement("div")), { id: "anTip", className: "an-tip", role: "tooltip" });
  drawer = document.getElementById("anDrawer") || Object.assign(document.body.appendChild(document.createElement("aside")), { id: "anDrawer", className: "an-drawer" });
  if (!window.__anBound) {
    window.__anBound = true;
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
    addEventListener("resize", () => { clearTimeout(window.__anRt); window.__anRt = setTimeout(() => { if (ROOT && document.body.contains(ROOT)) draw(); }, 150); });
    addEventListener("hashchange", () => { closeDrawer(); hideTip(); });
  }
}
const showTip = (e, html) => { tip.innerHTML = html; tip.classList.add("on"); const w = tip.offsetWidth, h = tip.offsetHeight; let x = e.clientX + 14, y = e.clientY + 14; if (x + w > innerWidth - 8) x = e.clientX - w - 14; if (y + h > innerHeight - 8) y = e.clientY - h - 14; tip.style.left = x + "px"; tip.style.top = y + "px"; };
const hideTip = () => tip?.classList.remove("on");
const closeDrawer = () => drawer?.classList.remove("on");
const tipRows = (rows, total) => rows.map(([c, l, v]) => `<div class="r"><span><i style="background:var(${c})"></i>${l}</span><b>${v}</b></div>`).join("") + (total ? `<div class="r tot"><span>Total</span><b>${total}</b></div>` : "");

// ---------------------------------------------------------------- graphiques SVG
function stackedBars(el, rows, opt = {}) {
  const W = el.clientWidth || 800, H = opt.h || 280, pad = { l: 56, r: 12, t: 12, b: 28 };
  const types = TYPES.filter((t) => st.types.has(t[0]));
  const max = Math.max(1, ...rows.map((r) => sum(types, (t) => Math.max(0, r.parts[t[0]] || 0))));
  const nice = Math.pow(10, Math.floor(Math.log10(max))), top = Math.ceil(max / nice) * nice;
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, step = iw / rows.length, bw = Math.max(4, Math.min(42, step * 0.62));
  const y = (v) => pad.t + ih - (v / top) * ih;
  let svg = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(opt.label || "")}"><g class="axis">`;
  for (let i = 0; i <= 4; i++) { const v = top * i / 4; svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${kmoney(v)}</text>`; }
  const every = Math.ceil(rows.length / Math.max(1, Math.floor(iw / 56)));
  rows.forEach((r, i) => { if (i % every === 0) svg += `<text x="${pad.l + step * i + step / 2}" y="${H - 8}" text-anchor="middle">${esc(r.label)}</text>`; });
  svg += `</g>`;
  rows.forEach((r, i) => {
    let base = 0; const x = pad.l + step * i + (step - bw) / 2;
    const segs = types.filter((t) => (r.parts[t[0]] || 0) > 0);
    segs.forEach(([k, c], j) => {
      const v = r.parts[k], y1 = y(base + v), y0 = y(base), last = j === segs.length - 1;
      const hgt = Math.max(0, y0 - y1 - (last ? 0 : 2));
      svg += last ? `<path d="M${x},${y0} V${Math.min(y0, y1 + 4)} Q${x},${y1} ${x + 4},${y1} H${x + bw - 4} Q${x + bw},${y1} ${x + bw},${Math.min(y0, y1 + 4)} V${y0} Z" fill="var(${c})"/>`
                  : `<rect x="${x}" y="${y0 - hgt}" width="${bw}" height="${hgt}" fill="var(${c})"/>`;
      base += v;
    });
    svg += `<rect class="hit" data-i="${i}" x="${pad.l + step * i}" y="${pad.t}" width="${step}" height="${ih}" fill="transparent"/>`;
  });
  el.innerHTML = svg + "</svg>";
  el.querySelectorAll(".hit").forEach((h) => {
    const r = rows[+h.dataset.i];
    h.onmousemove = (e) => showTip(e, `<div class="t">${esc(r.title || r.label)}</div>${tipRows(types.map(([k, c, l]) => [c, l, money(r.parts[k] || 0)]), money(sum(types, (t) => r.parts[t[0]] || 0)))}`);
    h.onmouseleave = hideTip;
    if (opt.onClick) { h.style.cursor = "pointer"; h.onclick = () => opt.onClick(r); }
  });
}

function lineChart(el, pts, opt = {}) {
  const W = el.clientWidth || 600, H = opt.h || 210, pad = { l: 44, r: 16, t: 14, b: 28 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const x = (i) => pad.l + (pts.length < 2 ? iw / 2 : iw * i / (pts.length - 1)), y = (v) => pad.t + ih - v * ih;
  let svg = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(opt.label || "")}"><g class="axis">`;
  [0, .25, .5, .75, 1].forEach((v) => { svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${v * 100} %</text>`; });
  const every = Math.ceil(pts.length / Math.max(1, Math.floor(iw / 56)));
  pts.forEach((p, i) => { if (i % every === 0) svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(p.label)}</text>`; });
  svg += `</g><path d="${pts.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.v)}`).join(" ")}" fill="none" stroke="var(${opt.color || "--s1"})" stroke-width="2" stroke-linejoin="round"/>`;
  svg += `<line class="cross" y1="${pad.t}" y2="${pad.t + ih}" stroke="var(--text-3)" stroke-dasharray="3 3" opacity="0"/><circle class="dot" r="4.5" fill="var(${opt.color || "--s1"})" stroke="var(--surface)" stroke-width="2" opacity="0"/>`;
  el.innerHTML = svg + `<rect class="hitl" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="transparent"/></svg>`;
  const hit = el.querySelector(".hitl"), cross = el.querySelector(".cross"), dot = el.querySelector(".dot");
  hit.onmousemove = (e) => {
    const r = hit.getBoundingClientRect(); const i = Math.max(0, Math.min(pts.length - 1, Math.round((e.clientX - r.left) / iw * (pts.length - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("opacity", 1);
    dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(pts[i].v)); dot.setAttribute("opacity", 1);
    showTip(e, `<div class="t">${esc(pts[i].label)}</div><div class="r"><span>${opt.series}</span><b>${pct(pts[i].v)}</b></div>${pts[i].extra || ""}`);
  };
  hit.onmouseleave = () => { hideTip(); cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); };
}

function donut(el, parts, center) {
  // parts: [{label, color, v}] — anneau avec écart de 2 px entre segments
  const size = Math.min(220, el.clientWidth || 220), r = size / 2 - 14, c = 2 * Math.PI * r, tot = sum(parts, (p) => Math.max(0, p.v)) || 1;
  let acc = 0;
  const gap = parts.filter((p) => p.v > 0).length > 1 ? 2 : 0;
  const arcs = parts.map((p, i) => { const len = Math.max(0, p.v) / tot * c; const s = `<circle data-i="${i}" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(${p.color})" stroke-width="26" stroke-dasharray="${Math.max(0, len - gap)} ${c - Math.max(0, len - gap)}" stroke-dashoffset="${-acc}" transform="rotate(-90 ${size / 2} ${size / 2})" style="cursor:pointer"/>`; acc += len; return s; }).join("");
  el.innerHTML = `<div class="an-donut"><svg width="${size}" height="${size}" role="img" aria-label="Répartition run / build">${arcs}
      <text x="${size / 2}" y="${size / 2 - 4}" text-anchor="middle" class="d-big">${center.big}</text><text x="${size / 2}" y="${size / 2 + 16}" text-anchor="middle" class="d-small">${center.small}</text></svg>
    <div class="an-donut-legend">${parts.map((p) => `<div><span class="sw" style="background:var(${p.color})"></span><div><div class="dl-l">${p.label}</div><div class="dl-v">${pct(p.v / tot)} · ${kmoney(p.v)}</div>${p.sub ? `<div class="xs faint">${p.sub}</div>` : ""}</div></div>`).join("")}</div></div>`;
  el.querySelectorAll("circle[data-i]").forEach((a) => { const p = parts[+a.dataset.i]; a.onmousemove = (e) => showTip(e, `<div class="t">${p.label}</div><div class="r"><span>Montant</span><b>${money(p.v)}</b></div><div class="r"><span>Part</span><b>${pct(p.v / tot)}</b></div>${p.sub ? `<div class="xs faint" style="margin-top:4px">${p.sub}</div>` : ""}`); a.onmouseleave = hideTip; });
}

const spark = (vals, w = 110, h = 26) => {
  const max = Math.max(1, ...vals), bw = w / vals.length;
  return `<svg width="${w}" height="${h}" aria-hidden="true">${vals.map((v, i) => v > 0 ? `<rect x="${i * bw + 0.5}" y="${h - (v / max) * h}" width="${Math.max(1, bw - 1.5)}" height="${(v / max) * h}" rx="1" fill="var(--s1)"/>` : `<rect x="${i * bw + 0.5}" y="${h - 1}" width="${Math.max(1, bw - 1.5)}" height="1" fill="var(--grid)"/>`).join("")}</svg>`;
};
const legend = () => `<div class="an-legend">${TYPES.filter((t) => st.types.has(t[0])).map(([, c, l]) => `<span><i style="background:var(${c})"></i>${l}</span>`).join("")}</div>`;
const tableToggle = (id) => `<button class="btn sm ghost" data-tt="${id}">${icon(st.tables[id] ? "pie" : "list")}${st.tables[id] ? "Graphique" : "Tableau"}</button>`;
const abar = (label, parts, max, right, attrs = "") => `<div class="abar" ${attrs}><span class="ellipsis" title="${esc(label)}">${esc(label)}</span><div class="track">${parts.filter((p) => p.v > 0).map((p) => `<div style="width:${p.v / max * 100}%;background:var(${p.c})"></div>`).join("")}</div><span class="num">${right}</span></div>`;

// ---------------------------------------------------------------- vues
function draw() {
  hideTip();
  const v = $("#anView", ROOT); if (!v) return;
  ({ overview, projects: projectsView, recurring: recurringView, domains: domainsView, team: teamView })[st.tab](v);
  v.querySelectorAll("[data-tt]").forEach((b) => b.onclick = () => { st.tables[b.dataset.tt] = !st.tables[b.dataset.tt]; draw(); });
}

function overview(v) {
  const ms = months(), L = lots();
  const total = sum(L, (l) => l.price), salary = sum(L, (l) => l.salary);
  const run = sum(L.filter((l) => isRun(l.kind)), (l) => l.price), build = total - run;
  const delivered = new Set(L.filter((l) => l.kind === "Projet" && DATA.status[l.lot]?.status === "PRODUCTION" && DATA.status[l.lot]?.mel && inRange(DATA.status[l.lot].mel.slice(0, 7))).map((l) => l.lot)).size;
  v.innerHTML = `<div class="grid g4 an-kpis" style="margin-bottom:16px">
      <div class="kpi"><div class="kpi-label">${icon("coins")}Facturé (hors cost +)</div><div class="kpi-value">${kmoney(total)}</div><div class="kpi-sub">${ms.length} mois · ${kmoney(total / Math.max(1, ms.length))} / mois</div></div>
      <div class="kpi"><div class="kpi-label">${icon("layers")}Build</div><div class="kpi-value">${pct(total ? build / total : 0)}</div><div class="kpi-sub">${kmoney(build)} · projets, évolutions, autres</div></div>
      <div class="kpi"><div class="kpi-label">${icon("zap")}Run (bug fixes)</div><div class="kpi-value">${pct(total ? run / total : 0)}</div><div class="kpi-sub">${kmoney(run)} · ${kmoney(run / Math.max(1, ms.length))} / mois</div></div>
      <div class="kpi"><div class="kpi-label">${icon("check")}Projets mis en ligne</div><div class="kpi-value">${delivered}</div><div class="kpi-sub">salaires : ${pct(total ? salary / total : 0)} du facturé</div></div></div>
    <div class="grid an-g-wide" style="margin-bottom:16px">
      <div class="card"><div class="card-head"><div class="grow"><h2>Répartition run / build</h2><div class="desc">Run = bug fixes · Build = projets, évolutions mineures et autres activités</div></div></div><div class="card-body" id="anDonut"></div></div>
      <div class="card"><div class="card-head"><div class="grow"><h2>Part du run dans la facture, mois par mois</h2><div class="desc">Survolez la courbe pour le détail du mois</div></div></div><div class="card-body"><div id="anRunLine"></div></div></div></div>
    <div class="grid an-g-wide-r">
      <div class="card"><div class="card-head"><div class="grow"><h2>Montant facturé par mois et par type</h2><div class="desc">Hors cost + · survolez une barre · cliquez pour les lots du mois</div></div>${tableToggle("ov")}</div>
        <div class="card-body">${legend()}<div id="anC1" style="margin-top:8px"></div></div></div>
      <div class="card"><div class="card-head"><div class="grow"><h2>Top 8 des lots</h2><div class="desc">Sur la période · cliquez pour le détail</div></div></div><div class="card-body" id="anTop"></div></div></div>
    <div class="alert alert-info" style="margin-top:16px">${icon("info")}<div>Coût d'un lot = salaires répartis au prorata des heures + quote-part DAP et frais généraux. Le cost + (7 %) s'applique ensuite à toute la facture : il est exclu ici pour comparer les lots.</div></div>`;
  // anneau run / build (sur les types sélectionnés)
  donut($("#anDonut", v), [
    { label: "Build", color: "--s1", v: build, sub: TYPES.filter((t) => !isRun(t[0]) && st.types.has(t[0])).map((t) => `${t[2]} ${kmoney(sum(L.filter((l) => l.kind === t[0]), (l) => l.price))}`).join(" · ") },
    { label: "Run (bug fixes)", color: "--s3", v: run },
  ], { big: pct(total ? build / total : 0), small: "build" });
  // part du run par mois (indépendante du filtre de types : toujours sur le total)
  lineChart($("#anRunLine", v), ms.map((m) => { const ls = DATA.lots.filter((l) => l.m === m); const t = sum(ls, (l) => l.price), r = sum(ls.filter((l) => isRun(l.kind)), (l) => l.price); return { label: ml(m), v: t ? r / t : 0, extra: `<div class="r"><span>Run</span><b>${money(r)}</b></div><div class="r"><span>Build</span><b>${money(t - r)}</b></div>` }; }), { series: "Part du run", label: "Part du run par mois", color: "--s3", h: 300 });
  // barres mensuelles
  const rows = ms.map((m) => { const parts = {}; L.filter((l) => l.m === m).forEach((l) => (parts[l.kind] = (parts[l.kind] || 0) + l.price)); return { key: m, label: ml(m), parts }; });
  const types = TYPES.filter((t) => st.types.has(t[0]));
  if (st.tables.ov) $("#anC1", v).innerHTML = `<div class="table-wrap" style="max-height:320px"><table class="t"><thead><tr><th>Mois</th>${types.map((t) => `<th class="num">${t[2]}</th>`).join("")}<th class="num">Total</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r.label}</td>${types.map((t) => `<td class="num">${money(r.parts[t[0]] || 0)}</td>`).join("")}<td class="num"><b>${money(sum(Object.values(r.parts), (x) => x))}</b></td></tr>`).join("")}</tbody></table></div>`;
  else stackedBars($("#anC1", v), rows, { label: "Montant facturé par mois", onClick: (r) => monthDrawer(r.key) });
  // top lots
  const agg = {}; L.forEach((l) => { const k = l.kind === "Projet" ? l.lot : l.base; const a = agg[k] || (agg[k] = { k, kind: l.kind, v: 0 }); a.v += l.price; });
  const top = Object.values(agg).sort((a, b) => b.v - a.v).slice(0, 8), tmax = top[0]?.v || 1;
  $("#anTop", v).innerHTML = top.map((t) => abar(t.k, [{ v: t.v, c: typeOf(t.kind)[1] }], tmax, kmoney(t.v), `data-lot="${esc(t.k)}" data-kind="${t.kind}" style="cursor:pointer"`)).join("") || empty("Aucun lot");
  $("#anTop", v).querySelectorAll("[data-lot]").forEach((r) => r.onclick = () => r.dataset.kind === "Projet" ? projectDrawer(r.dataset.lot) : familyDrawer(r.dataset.lot));
}

function projects() {
  const map = {};
  DATA.lots.filter((l) => l.kind === "Projet").forEach((l) => {
    const p = map[l.lot] || (map[l.lot] = { lot: l.lot, dom: l.dom, series: {}, price: 0, hours: 0 });
    if (inRange(l.m)) { p.price += l.price; p.hours += l.hours; }
    p.series[l.m] = (p.series[l.m] || 0) + l.price;
  });
  return Object.values(map).filter((p) => p.price > 0).map((p) => { const s2 = DATA.status[p.lot] || {}; return { ...p, status: s2.status || "IN PROGRESS", mel: s2.mel, months: Object.keys(p.series).length, total: sum(Object.values(p.series), (x) => x) }; });
}

function projectsView(v) {
  if (!st.types.has("Projet")) { v.innerHTML = `<div class="card">${empty("Type « Projets » masqué", "Réactivez le type Projets dans les filtres.", "filter")}</div>`; return; }
  let P = projects();
  if (st.status !== "all") P = P.filter((p) => (st.status === "live" ? p.status === "PRODUCTION" : p.status !== "PRODUCTION"));
  if (st.q) P = P.filter((p) => (p.lot + " " + p.dom).toLowerCase().includes(st.q.toLowerCase()));
  const { k, d } = st.sort; P.sort((a, b) => (typeof a[k] === "number" ? a[k] - b[k] : String(a[k] || "").localeCompare(String(b[k] || ""))) * d);
  const live = P.filter((p) => p.status === "PRODUCTION"), wip = P.filter((p) => p.status !== "PRODUCTION");
  v.innerHTML = `<div class="grid g4" style="margin-bottom:16px">
      <div class="kpi"><div class="kpi-label">Projets facturés</div><div class="kpi-value">${P.length}</div><div class="kpi-sub">${kmoney(sum(P, (p) => p.price))} sur la période</div></div>
      <div class="kpi"><div class="kpi-label">En cours</div><div class="kpi-value">${wip.length}</div><div class="kpi-sub">${kmoney(sum(wip, (p) => p.price))} sur la période</div></div>
      <div class="kpi"><div class="kpi-label">En ligne</div><div class="kpi-value">${live.length}</div><div class="kpi-sub">${kmoney(sum(live, (p) => p.price))} sur la période</div></div>
      <div class="kpi"><div class="kpi-label">Coût moyen d'un projet livré</div><div class="kpi-value">${kmoney(live.length ? sum(live, (p) => p.total) / live.length : 0)}</div><div class="kpi-sub">coût total, toute durée</div></div></div>
    <div class="card"><div class="card-head"><div class="grow"><h2>Projets</h2><div class="desc">Cliquez sur une ligne pour le détail · sur un titre de colonne pour trier</div></div>
      <div class="input-icon" style="width:240px">${icon("search")}<input id="anPq" placeholder="Rechercher…" value="${esc(st.q)}"></div>
      <div class="seg" id="anPst">${[["all", "Tous"], ["wip", "En cours"], ["live", "En ligne"]].map(([s2, l]) => `<button data-s="${s2}" class="${st.status === s2 ? "on" : ""}">${l}</button>`).join("")}</div></div>
      <div class="table-wrap tall"><table class="t"><thead><tr>
        ${[["lot", "Projet"], ["dom", "Domaine"], ["status", "Statut"], ["mel", "Mise en ligne"], ["months", "Mois", 1], ["price", "Période", 1], ["total", "Coût total", 1], ["hours", "Heures", 1]].map(([k2, l, n]) => `<th class="sortable ${n ? "num" : ""} ${st.sort.k === k2 ? "sorted" : ""}" data-sort="${k2}">${l}<span class="sort-ic">${st.sort.k === k2 ? (st.sort.d > 0 ? "▲" : "▼") : "↕"}</span></th>`).join("")}<th>Profil mensuel</th></tr></thead>
      <tbody>${P.map((p) => `<tr class="clickable" data-lot="${esc(p.lot)}"><td style="max-width:320px"><div class="ellipsis" style="font-weight:600" title="${esc(p.lot)}">${esc(p.lot)}</div></td><td class="xs muted">${esc(p.dom)}</td>
        <td>${p.status === "PRODUCTION" ? '<span class="chip chip-success">En ligne</span>' : '<span class="chip chip-info">En cours</span>'}</td><td class="xs nowrap">${p.mel ? p.mel.split("-").reverse().join("/") : '<span class="faint">—</span>'}</td>
        <td class="num">${p.months}</td><td class="num"><b>${money(p.price)}</b></td><td class="num">${money(p.total)}</td><td class="num">${nf0.format(p.hours)}</td><td>${spark(MONTHS.map((m) => p.series[m] || 0))}</td></tr>`).join("") || `<tr><td colspan="9">${empty("Aucun projet")}</td></tr>`}</tbody></table></div></div>`;
  $("#anPq", v).oninput = (e) => { st.q = e.target.value; const pos = e.target.selectionStart; draw(); const i = $("#anPq", ROOT); i.focus(); i.setSelectionRange(pos, pos); };
  v.querySelectorAll("#anPst button").forEach((b) => b.onclick = () => { st.status = b.dataset.s; draw(); });
  v.querySelectorAll("th[data-sort]").forEach((th) => th.onclick = () => { const k2 = th.dataset.sort; st.sort = { k: k2, d: st.sort.k === k2 ? -st.sort.d : (["lot", "dom", "status", "mel"].includes(k2) ? 1 : -1) }; draw(); });
  v.querySelectorAll("tbody tr[data-lot]").forEach((tr) => tr.onclick = () => projectDrawer(tr.dataset.lot));
}

function recurringView(v) {
  const ms = months(), kinds = ["Agile", "Support", "Run"].filter((k) => st.types.has(k));
  if (!kinds.length) { v.innerHTML = `<div class="card">${empty("Aucun type récurrent sélectionné", "Réactivez Évolutions mineures, Bug fixes ou Autres activités dans les filtres.", "filter")}</div>`; return; }
  const L = DATA.lots.filter((l) => inRange(l.m) && kinds.includes(l.kind));
  const fam = {}; L.forEach((l) => { const f = fam[l.base] || (fam[l.base] = { base: l.base, kind: l.kind, by: {}, v: 0 }); f.by[l.m] = (f.by[l.m] || 0) + l.price; f.v += l.price; });
  const F = Object.values(fam).sort((a, b) => b.v - a.v).slice(0, 25), max = Math.max(1, ...F.flatMap((f) => Object.values(f.by)));
  const steps = ["--seq-1", "--seq-2", "--seq-3", "--seq-4", "--seq-5", "--seq-6"];
  const color = (x) => x > 0 ? `var(${steps[Math.min(steps.length - 1, Math.floor(x / max * steps.length))]})` : "var(--seq-0)";
  v.innerHTML = `<div class="grid g4" style="margin-bottom:16px">${kinds.map((k) => { const t = typeOf(k); return `<div class="kpi"><div class="kpi-label"><span class="sw" style="background:var(${t[1]})"></span>${t[2]}</div><div class="kpi-value">${kmoney(sum(L.filter((l) => l.kind === k), (l) => l.price) / Math.max(1, ms.length))}</div><div class="kpi-sub">par mois en moyenne</div></div>`; }).join("")}
      <div class="kpi"><div class="kpi-label">Total activités récurrentes</div><div class="kpi-value">${kmoney(sum(L, (l) => l.price) / Math.max(1, ms.length))}</div><div class="kpi-sub">par mois · ${Object.keys(fam).length} activités</div></div></div>
    <div class="card"><div class="card-head"><div class="grow"><h2>Coût mensuel des activités récurrentes</h2><div class="desc">Top 25 · plus la case est foncée, plus le mois a coûté · cliquez sur une ligne pour le détail</div></div>
      <div class="an-ramp">0 ${steps.map((s2) => `<i style="background:var(${s2})"></i>`).join("")} ${kmoney(max)}</div></div>
      <div class="card-body" style="overflow-x:auto"><table class="an-heat"><thead><tr><th></th>${ms.map((m) => `<th>${ml(m).replace(" ", "<br>")}</th>`).join("")}<th style="text-align:right">Total</th></tr></thead>
      <tbody>${F.map((f) => `<tr data-fam="${esc(f.base)}"><td class="lbl" title="${esc(f.base)}"><span class="sw" style="background:var(${typeOf(f.kind)[1]})"></span>${esc(f.base)}</td>
        ${ms.map((m) => `<td class="c" data-v="${f.by[m] || 0}" data-m="${m}" style="background:${color(f.by[m] || 0)}"></td>`).join("")}<td class="num xs tot"><b>${kmoney(f.v)}</b></td></tr>`).join("")}</tbody></table></div></div>`;
  v.querySelectorAll("td.c").forEach((c) => { c.onmousemove = (e) => showTip(e, `<div class="t">${esc(c.parentElement.dataset.fam)}</div><div class="r"><span>${ml(c.dataset.m)}</span><b>${money(+c.dataset.v)}</b></div>`); c.onmouseleave = hideTip; });
  v.querySelectorAll("tr[data-fam]").forEach((tr) => tr.onclick = () => familyDrawer(tr.dataset.fam));
}

function domainsView(v) {
  const L = lots(), D = {};
  L.forEach((l) => { const d = D[l.dom] || (D[l.dom] = { dom: l.dom, parts: {}, v: 0, lots: new Set() }); d.parts[l.kind] = (d.parts[l.kind] || 0) + l.price; d.v += l.price; d.lots.add(l.kind === "Projet" ? l.lot : l.base); });
  const all = Object.values(D).sort((a, b) => b.v - a.v), top = all.slice(0, 15), rest = all.slice(15);
  if (rest.length) top.push({ dom: `Autres (${rest.length} domaines)`, parts: rest.reduce((acc, d) => { Object.entries(d.parts).forEach(([k, x]) => (acc[k] = (acc[k] || 0) + x)); return acc; }, {}), v: sum(rest, (d) => d.v), lots: new Set(rest.flatMap((d) => [...d.lots])) });
  const max = Math.max(1, ...top.map((d) => d.v)), types = TYPES.filter((t) => st.types.has(t[0]));
  v.innerHTML = `<div class="card"><div class="card-head"><div class="grow"><h2>Montant par domaine</h2><div class="desc">Domaine déduit du nom des lots · 15 premiers, le reste regroupé · survolez une barre</div></div>${tableToggle("dom")}</div>
    <div class="card-body">${legend()}<div id="anDoms" style="margin-top:10px"></div></div></div>
    <div class="alert alert-warning" style="margin-top:16px">${icon("info")}<div><b>À décider :</b> le domaine est déduit du nom des lots, d'où beaucoup de petits domaines. Un champ « Domaine » dans les epics, renseigné une fois, donnerait un regroupement exact.</div></div>`;
  const el = $("#anDoms", v);
  if (st.tables.dom) { el.innerHTML = `<table class="t"><thead><tr><th>Domaine</th>${types.map((t) => `<th class="num">${t[2]}</th>`).join("")}<th class="num">Total</th><th class="num">Lots</th></tr></thead><tbody>${top.map((d) => `<tr><td>${esc(d.dom)}</td>${types.map((t) => `<td class="num">${money(d.parts[t[0]] || 0)}</td>`).join("")}<td class="num"><b>${money(d.v)}</b></td><td class="num">${d.lots.size}</td></tr>`).join("")}</tbody></table>`; return; }
  el.innerHTML = top.map((d, i) => abar(d.dom, types.map((t) => ({ v: d.parts[t[0]] || 0, c: t[1] })), max, kmoney(d.v), `data-i="${i}"`)).join("");
  el.querySelectorAll("[data-i]").forEach((r) => { const d = top[+r.dataset.i]; r.onmousemove = (e) => showTip(e, `<div class="t">${esc(d.dom)}</div>${tipRows(types.map(([k, c, l]) => [c, l, money(d.parts[k] || 0)]), `${money(d.v)} · ${d.lots.size} lots`)}`); r.onmouseleave = hideTip; });
}

function teamView(v) {
  const ms = months(), types = TYPES.filter((t) => st.types.has(t[0]));
  const T = DATA.team.map((p) => { const parts = {}; ms.forEach((m) => Object.entries(p.hours[m] || {}).forEach(([k, h]) => { if (st.types.has(k)) parts[k] = (parts[k] || 0) + h; })); return { name: p.name, parts, v: sum(Object.values(parts), (x) => x) }; }).filter((p) => p.v > 0).sort((a, b) => b.v - a.v);
  const max = Math.max(1, ...T.map((p) => p.v)), tot = sum(T, (p) => p.v);
  v.innerHTML = `<div class="grid an-g-wide"><div class="card"><div class="card-head"><div class="grow"><h2>Heures par collaborateur et par type</h2><div class="desc">Heures facturées sur la période (répartitions au prorata comprises) · aucun coût individuel affiché</div></div>${tableToggle("team")}</div>
      <div class="card-body">${legend()}<div id="anTm" style="margin-top:10px"></div></div></div>
      <div class="card"><div class="card-head"><div class="grow"><h2>Où va le temps de l'équipe</h2><div class="desc">${nf0.format(tot)} h sur ${ms.length} mois</div></div></div><div class="card-body" id="anTeamDonut"></div></div></div>`;
  donut($("#anTeamDonut", v), types.map(([k, c, l]) => ({ label: l, color: c, v: sum(T, (p) => p.parts[k] || 0) })), { big: nf0.format(tot), small: "heures" });
  $("#anTeamDonut", v).querySelectorAll(".dl-v").forEach((e) => (e.textContent = e.textContent.replace(/ · .*$/, "")));
  const el = $("#anTm", v);
  if (st.tables.team) { el.innerHTML = `<table class="t"><thead><tr><th>Collaborateur</th>${types.map((t) => `<th class="num">${t[2]}</th>`).join("")}<th class="num">Total</th></tr></thead><tbody>${T.map((p) => `<tr><td>${esc(p.name)}</td>${types.map((t) => `<td class="num">${nf0.format(p.parts[t[0]] || 0)}</td>`).join("")}<td class="num"><b>${nf0.format(p.v)}</b></td></tr>`).join("")}</tbody></table>`; return; }
  el.innerHTML = T.map((p, i) => abar(p.name, types.map((t) => ({ v: p.parts[t[0]] || 0, c: t[1] })), max, `${nf0.format(p.v)} h`, `data-i="${i}"`)).join("");
  el.querySelectorAll("[data-i]").forEach((r) => { const p = T[+r.dataset.i]; r.onmousemove = (e) => showTip(e, `<div class="t">${esc(p.name)}</div>${tipRows(types.map(([k, c, l]) => [c, l, `${nf0.format(p.parts[k] || 0)} h · ${pct(p.v ? (p.parts[k] || 0) / p.v : 0)}`]))}`); r.onmouseleave = hideTip; });
}

// ---------------------------------------------------------------- panneaux de détail
function openDrawer(title, sub, body) {
  drawer.innerHTML = `<div class="dh"><div style="flex:1;min-width:0"><div class="xs faint">${sub}</div><h2 style="font-size:17px;margin-top:2px">${esc(title)}</h2></div><button class="icon-btn" aria-label="Fermer">${icon("x")}</button></div><div class="db">${body}</div>`;
  drawer.querySelector(".icon-btn").onclick = closeDrawer; drawer.classList.add("on");
}
function seriesBlock(byM, label) {
  const max = Math.max(1, ...Object.values(byM));
  return `<div class="xs muted" style="margin-bottom:6px">${label}</div><div class="an-series">${MONTHS.map((m) => `<div title="${ml(m)} : ${money(byM[m] || 0)}" style="background:${inRange(m) ? "var(--s1)" : "var(--seq-1)"};height:${(byM[m] || 0) / max * 100}%;min-height:${byM[m] ? 2 : 0}px"></div>`).join("")}</div><div class="xs faint row between" style="margin-top:4px"><span>${ml(MONTHS[0])}</span><span>${ml(MONTHS.at(-1))}</span></div>`;
}
function teamBlock(ls) {
  const t = {}; ls.forEach((l) => l.team.forEach(([n, h]) => (t[n] = (t[n] || 0) + h)));
  const T = Object.entries(t).sort((a, b) => b[1] - a[1]), max = T[0]?.[1] || 1;
  if (!T.length) return "";
  return `<h3 style="margin:20px 0 8px">Qui a travaillé dessus (période)</h3>${T.map(([n, h]) => abar(n, [{ v: h, c: "--s1" }], max, `${nf0.format(h)} h`)).join("")}`;
}
function projectDrawer(lot) {
  const ls = DATA.lots.filter((l) => l.lot === lot), byM = {}; ls.forEach((l) => (byM[l.m] = (byM[l.m] || 0) + l.price));
  const s2 = DATA.status[lot] || {}, tot = sum(ls, (l) => l.price), per = sum(ls.filter((l) => inRange(l.m)), (l) => l.price);
  openDrawer(lot, `Projet · ${esc(ls[0]?.dom || "")}`, `<div class="grid g2" style="margin-bottom:16px">
    <div class="kpi"><div class="kpi-label">Coût total</div><div class="kpi-value">${kmoney(tot)}</div><div class="kpi-sub">${Object.keys(byM).length} mois facturés</div></div>
    <div class="kpi"><div class="kpi-label">Statut</div><div class="kpi-value" style="font-size:18px">${s2.status === "PRODUCTION" ? "En ligne" : "En cours"}</div><div class="kpi-sub">${s2.mel ? "mis en ligne le " + s2.mel.split("-").reverse().join("/") : "pas encore en ligne"}</div></div></div>
    ${seriesBlock(byM, `Montant par mois · ${kmoney(per)} sur la période (en foncé)`)}${teamBlock(ls.filter((l) => inRange(l.m)))}`);
}
function familyDrawer(base) {
  const ls = DATA.lots.filter((l) => l.base === base), byM = {}; ls.forEach((l) => (byM[l.m] = (byM[l.m] || 0) + l.price));
  const tot = sum(ls.filter((l) => inRange(l.m)), (l) => l.price), n = months().length;
  openDrawer(base, `Activité récurrente · ${typeOf(ls[0]?.kind)?.[2] || ""}`, `<div class="grid g2" style="margin-bottom:16px">
    <div class="kpi"><div class="kpi-label">Sur la période</div><div class="kpi-value">${kmoney(tot)}</div><div class="kpi-sub">${n} mois</div></div>
    <div class="kpi"><div class="kpi-label">Moyenne mensuelle</div><div class="kpi-value">${kmoney(tot / Math.max(1, n))}</div><div class="kpi-sub">un lot « - MM/AA » par mois</div></div></div>
    ${seriesBlock(byM, "Montant par mois (période en foncé)")}${teamBlock(ls.filter((l) => inRange(l.m)))}`);
}
function monthDrawer(m) {
  const ls = lots().filter((l) => l.m === m).sort((a, b) => b.price - a.price), tot = sum(ls, (l) => l.price), max = ls[0]?.price || 1;
  openDrawer(`Facture de ${ml(m).replace(".", "")}`, "Lots du mois", `<div class="kpi" style="margin-bottom:14px"><div class="kpi-label">Montant (hors cost +)</div><div class="kpi-value">${money(tot)}</div><div class="kpi-sub">${ls.length} lots</div></div>
    ${ls.map((l) => abar(l.lot, [{ v: l.price, c: typeOf(l.kind)[1] }], max, kmoney(l.price), `data-lot="${esc(l.lot)}" data-kind="${l.kind}" data-base="${esc(l.base)}" style="cursor:pointer"`)).join("")}`);
  drawer.querySelectorAll("[data-lot]").forEach((r) => r.onclick = () => r.dataset.kind === "Projet" ? projectDrawer(r.dataset.lot) : familyDrawer(r.dataset.base));
}
