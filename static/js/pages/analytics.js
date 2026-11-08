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

let DATA = null, RAW = null, MONTHS = [], ROOT = null;
const st = { from: null, to: null, types: new Set(TYPES.map((t) => t[0])), tab: "overview", sort: { k: "price", d: -1 }, q: "", status: "all", tables: {}, quick: "all", member: null, poste: null, grp: "", unit: "h", msort: { k: "h", d: -1 } };
const hfmt = (v) => nf0.format(v) + " pts";
const h1 = (v) => (Math.round(v * 10) / 10).toLocaleString("fr-FR") + " pts";

export async function render(view) {
  view.innerHTML = `<div class="skel-wrap"><div class="skel" style="height:60px"></div><div class="skel" style="height:320px"></div></div>`;
  RAW = await api("/api/analytics");
  applyGroup();
  DATA = DATA || RAW;
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
      ${RAW.team.length ? `<label for="anGrp" style="margin-left:6px">Équipe</label><select id="anGrp">${groupOptions()}</select>` : ""}
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
  view.querySelectorAll("#anTabs button").forEach((b) => b.onclick = () => { view.querySelectorAll("#anTabs button").forEach((x) => x.classList.toggle("on", x === b)); st.tab = b.dataset.t; st.member = null; draw(); });
  if ($("#anGrp", view)) $("#anGrp", view).onchange = (e) => { st.grp = e.target.value; st.member = null; st.poste = null; applyGroup(); closeDrawer(); draw(); };
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
  for (let i = 0; i <= 4; i++) { const v = top * i / 4; svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${(opt.axis || kmoney)(v)}</text>`; }
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
    h.onmousemove = (e) => showTip(e, `<div class="t">${esc(r.title || r.label)}</div>${tipRows(types.map(([k, c, l]) => [c, l, (opt.fmt || money)(r.parts[k] || 0)]), (opt.fmt || money)(sum(types, (t) => r.parts[t[0]] || 0)))}`);
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

function donut(el, parts, center, fmt = kmoney) {
  // parts: [{label, color, v}] — anneau avec écart de 2 px entre segments
  const size = Math.min(220, el.clientWidth || 220), r = size / 2 - 14, c = 2 * Math.PI * r, tot = sum(parts, (p) => Math.max(0, p.v)) || 1;
  let acc = 0;
  const gap = parts.filter((p) => p.v > 0).length > 1 ? 2 : 0;
  const arcs = parts.map((p, i) => { const len = Math.max(0, p.v) / tot * c; const s = `<circle data-i="${i}" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(${p.color})" stroke-width="26" stroke-dasharray="${Math.max(0, len - gap)} ${c - Math.max(0, len - gap)}" stroke-dashoffset="${-acc}" transform="rotate(-90 ${size / 2} ${size / 2})" style="cursor:pointer"/>`; acc += len; return s; }).join("");
  el.innerHTML = `<div class="an-donut"><svg width="${size}" height="${size}" role="img" aria-label="Répartition run / build">${arcs}
      <text x="${size / 2}" y="${size / 2 - 4}" text-anchor="middle" class="d-big">${center.big}</text><text x="${size / 2}" y="${size / 2 + 16}" text-anchor="middle" class="d-small">${center.small}</text></svg>
    <div class="an-donut-legend">${parts.map((p) => `<div><span class="sw" style="background:var(${p.color})"></span><div><div class="dl-l">${p.label}</div><div class="dl-v">${pct(p.v / tot)} · ${fmt(p.v)}</div>${p.sub ? `<div class="xs faint">${p.sub}</div>` : ""}</div></div>`).join("")}</div></div>`;
  el.querySelectorAll("circle[data-i]").forEach((a) => { const p = parts[+a.dataset.i]; a.onmousemove = (e) => showTip(e, `<div class="t">${p.label}</div><div class="r"><span>Valeur</span><b>${fmt === kmoney ? money(p.v) : fmt(p.v)}</b></div><div class="r"><span>Part</span><b>${pct(p.v / tot)}</b></div>${p.sub ? `<div class="xs faint" style="margin-top:4px">${p.sub}</div>` : ""}`); a.onmouseleave = hideTip; });
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
  if (st.tab === "team" && st.member) memberView(v);
  else ({ overview, projects: projectsView, recurring: recurringView, domains: domainsView, team: teamView })[st.tab](v);
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

const POSTES = ["Développement", "Gestion de projet", "QA", "Direction", "CTO", "Non renseigné"];
function teamView(v) {
  const ms = months(), types = TYPES.filter((t) => st.types.has(t[0])), cost = st.unit === "c", key = cost ? "cost" : "hours";
  const F = cost ? kmoney : hfmt, Fx = cost ? money : hfmt;
  const T = DATA.team.map((p) => { const parts = {}; ms.forEach((m) => Object.entries(p[key][m] || {}).forEach(([k, x]) => { if (st.types.has(k)) parts[k] = (parts[k] || 0) + x; })); return { name: p.name, poste: p.poste, role: p.role, parts, v: sum(Object.values(parts), (x) => x) }; }).filter((p) => p.v > 0).sort((a, b) => b.v - a.v);
  const tot = sum(T, (p) => p.v);
  // regroupement par poste
  const G = POSTES.map((g) => { const ps = T.filter((p) => p.poste === g), parts = {}; ps.forEach((p) => Object.entries(p.parts).forEach(([k, x]) => (parts[k] = (parts[k] || 0) + x))); return { g, n: ps.length, parts, v: sum(ps, (p) => p.v) }; }).filter((g) => g.v > 0);
  const gmax = Math.max(1, ...G.map((g) => g.v));
  if (st.poste && !G.some((g) => g.g === st.poste)) st.poste = null;
  const TL = st.poste ? T.filter((p) => p.poste === st.poste) : T, max = Math.max(1, ...TL.map((p) => p.v));
  v.innerHTML = `<div class="row" style="justify-content:flex-end;margin-bottom:12px"><div class="seg" id="anUnit"><button data-u="h" class="${cost ? "" : "on"}">Points (heures)</button><button data-u="c" class="${cost ? "on" : ""}">Coût</button></div></div>
    <div class="grid an-g-wide-r" style="margin-bottom:16px">
      <div class="card"><div class="card-head"><div class="grow"><h2>Répartition par poste</h2><div class="desc">${cost ? "Coût salarial" : "Points"} par type de poste et par type d'activité · <b>cliquez sur un poste pour filtrer les collaborateurs</b></div></div>${tableToggle("poste")}</div>
        <div class="card-body">${legend()}<div id="anPostes" style="margin-top:10px"></div></div></div>
      <div class="card"><div class="card-head"><div class="grow"><h2>Où ${cost ? "va le coût" : "va le temps"} de l'équipe</h2><div class="desc">${Fx(tot)} sur ${ms.length} mois</div></div></div><div class="card-body" id="anTeamDonut"></div></div></div>
    <div class="card"><div class="card-head"><div class="grow"><h2>${cost ? "Coût" : "Points"} par collaborateur${st.poste ? ` · ${esc(st.poste)}` : ""}</h2><div class="desc">Répartitions au prorata comprises · <b>cliquez sur un nom pour ouvrir sa fiche</b></div></div>
      ${st.poste ? `<button class="btn sm ghost" id="anPosteClear">${icon("x")}Tous les postes</button>` : ""}${tableToggle("team")}</div>
      <div class="card-body">${legend()}<div id="anTm" style="margin-top:10px"></div></div></div>`;
  v.querySelectorAll("#anUnit button").forEach((b) => b.onclick = () => { st.unit = b.dataset.u; draw(); });
  if ($("#anPosteClear", v)) $("#anPosteClear", v).onclick = () => { st.poste = null; draw(); };
  donut($("#anTeamDonut", v), types.map(([k, c, l]) => ({ label: l, color: c, v: sum(T, (p) => p.parts[k] || 0) })), { big: cost ? kmoney(tot) : nf0.format(tot), small: cost ? "coût" : "points" }, F);
  // postes
  const pe = $("#anPostes", v);
  if (st.tables.poste) {
    pe.innerHTML = `<div class="table-wrap"><table class="t"><thead><tr><th>Poste</th><th class="num">Pers.</th>${types.map((t) => `<th class="num">${t[2]}</th>`).join("")}<th class="num">Total</th><th class="num">% équipe</th></tr></thead><tbody>${G.map((g) => `<tr class="clickable" data-g="${esc(g.g)}"><td>${esc(g.g)}</td><td class="num">${g.n}</td>${types.map((t) => `<td class="num">${cost ? money(g.parts[t[0]] || 0) : nf0.format(g.parts[t[0]] || 0)}<div class="xs faint">${pct(g.v ? (g.parts[t[0]] || 0) / g.v : 0)}</div></td>`).join("")}<td class="num"><b>${cost ? money(g.v) : nf0.format(g.v)}</b></td><td class="num">${pct(tot ? g.v / tot : 0)}</td></tr>`).join("")}</tbody></table></div>`;
  } else pe.innerHTML = G.map((g) => abar(`${g.g} (${g.n})`, types.map((t) => ({ v: g.parts[t[0]] || 0, c: t[1] })), gmax, `${F(g.v)} · ${Math.round(tot ? g.v / tot * 100 : 0)} %`, `data-g="${esc(g.g)}" data-link="1"${st.poste === g.g ? ' style="font-weight:700"' : ""}`)).join("");
  pe.querySelectorAll("[data-g]").forEach((r) => { const g = G.find((x) => x.g === r.dataset.g);
    r.onmousemove = (e) => showTip(e, `<div class="t">${esc(g.g)} · ${g.n} pers.</div>${tipRows(types.map(([k, c, l]) => [c, l, `${Fx(g.parts[k] || 0)} · ${pct(g.v ? (g.parts[k] || 0) / g.v : 0)}`]), `${Fx(g.v)} · ${pct(tot ? g.v / tot : 0)} de l'équipe`)}`);
    r.onmouseleave = hideTip; r.onclick = () => { hideTip(); st.poste = st.poste === g.g ? null : g.g; draw(); }; });
  // collaborateurs
  const el = $("#anTm", v);
  if (st.tables.team) { el.innerHTML = `<div class="table-wrap"><table class="t"><thead><tr><th>Collaborateur</th><th>Poste</th>${types.map((t) => `<th class="num">${t[2]}</th>`).join("")}<th class="num">Total</th></tr></thead><tbody>${TL.map((p) => `<tr class="clickable"><td>${esc(p.name)}</td><td class="xs muted">${esc(p.poste)}</td>${types.map((t) => `<td class="num">${cost ? money(p.parts[t[0]] || 0) : nf0.format(p.parts[t[0]] || 0)}</td>`).join("")}<td class="num"><b>${cost ? money(p.v) : nf0.format(p.v)}</b></td></tr>`).join("")}</tbody></table></div>`; el.querySelectorAll("tbody tr").forEach((tr, i) => tr.onclick = () => openMember(TL[i].name)); return; }
  el.innerHTML = TL.map((p, i) => abar(p.name, types.map((t) => ({ v: p.parts[t[0]] || 0, c: t[1] })), max, F(p.v), `data-i="${i}" data-link="1"`)).join("");
  el.querySelectorAll("[data-i]").forEach((r) => { const p = TL[+r.dataset.i]; r.onmousemove = (e) => showTip(e, `<div class="t">${esc(p.name)} · ${esc(p.poste)}</div>${tipRows(types.map(([k, c, l]) => [c, l, `${Fx(p.parts[k] || 0)} · ${pct(p.v ? (p.parts[k] || 0) / p.v : 0)}`]))}<div class="xs faint" style="margin-top:6px">Run : ${pct(p.v ? (p.parts.Support || 0) / p.v : 0)} · cliquez pour la fiche</div>`); r.onmouseleave = hideTip; r.onclick = () => { hideTip(); openMember(p.name); }; });
}

// ---------------------------------------------------------------- panneaux de détail
let redrawDrawer = null;
const isCost = () => st.unit === "c";
const uval = (l) => (isCost() ? l.price : l.hours);
const ufmt = (v) => (isCost() ? kmoney(v) : hfmt(v));
function openDrawer(title, sub, render) {
  redrawDrawer = () => {
    drawer.innerHTML = `<div class="dh"><div style="flex:1;min-width:0"><div class="xs faint">${sub}</div><h2 style="font-size:17px;margin-top:2px">${esc(title)}</h2></div>
      <div class="seg" id="anDUnit"><button data-u="h" class="${isCost() ? "" : "on"}">Points</button><button data-u="c" class="${isCost() ? "on" : ""}">Coût</button></div>
      <button class="icon-btn" aria-label="Fermer">${icon("x")}</button></div><div class="db">${render()}</div>`;
    drawer.querySelector(".icon-btn").onclick = closeDrawer;
    drawer.querySelectorAll("#anDUnit button").forEach((b) => b.onclick = () => { if (st.unit === b.dataset.u) return; st.unit = b.dataset.u; redrawDrawer(); draw(); });
    drawer.querySelectorAll("[data-member]").forEach((r) => r.onclick = () => { closeDrawer(); openMember(r.dataset.member); });
    drawer.querySelectorAll("[data-lot]").forEach((r) => r.onclick = () => r.dataset.kind === "Projet" ? projectDrawer(r.dataset.lot) : familyDrawer(r.dataset.base));
  };
  redrawDrawer(); drawer.classList.add("on");
}
function byMonth(ls) { const b = {}; ls.forEach((l) => (b[l.m] = (b[l.m] || 0) + uval(l))); return b; }
function seriesBlock(byM, label) {
  const max = Math.max(1, ...Object.values(byM));
  return `<div class="xs muted" style="margin-bottom:6px">${label}</div><div class="an-series">${MONTHS.map((m) => `<div title="${ml(m)} : ${isCost() ? money(byM[m] || 0) : h1(byM[m] || 0)}" style="background:${inRange(m) ? "var(--s1)" : "var(--seq-1)"};height:${(byM[m] || 0) / max * 100}%;min-height:${byM[m] ? 2 : 0}px"></div>`).join("")}</div><div class="xs faint row between" style="margin-top:4px"><span>${ml(MONTHS[0])}</span><span>${ml(MONTHS.at(-1))}</span></div>`;
}
function teamBlock(ls) {
  const t = {}; ls.forEach((l) => l.team.forEach(([n, h, c]) => (t[n] = (t[n] || 0) + (isCost() ? c : h))));
  const T = Object.entries(t).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]), max = T[0]?.[1] || 1;
  if (!T.length) return "";
  const tot = sum(T, (x) => x[1]);
  return `<h3 style="margin:20px 0 4px">Qui a travaillé dessus (période)</h3><div class="xs faint" style="margin-bottom:8px">${isCost() ? "Coût salarial affecté à chacun et sa part du coût salarial du lot" : "Points de chacun et sa part des points du lot"} · cliquez sur un nom pour sa fiche</div>
    ${T.map(([n, x]) => abar(n, [{ v: x, c: "--s1" }], max, `${ufmt(x)} · ${Math.round(x / tot * 100)} %`, `data-link="1" data-member="${esc(n)}"`)).join("")}`;
}
const kpi2 = (ls) => { const H = sum(ls, (l) => l.hours), C = sum(ls, (l) => l.price);
  return `<div class="kpi ${isCost() ? "" : "kpi-on"}"><div class="kpi-label">Points (heures)</div><div class="kpi-value">${nf0.format(H)}</div><div class="kpi-sub">sur la période</div></div>
    <div class="kpi ${isCost() ? "kpi-on" : ""}"><div class="kpi-label">Coût (hors cost +)</div><div class="kpi-value">${kmoney(C)}</div><div class="kpi-sub">${H ? money(C / H) + " / point" : "—"}</div></div>`; };
function projectDrawer(lot) {
  const ls = DATA.lots.filter((l) => l.lot === lot), s2 = DATA.status[lot] || {};
  openDrawer(lot, `Projet · ${esc(ls[0]?.dom || "")} · ${s2.status === "PRODUCTION" ? "en ligne" + (s2.mel ? " le " + s2.mel.split("-").reverse().join("/") : "") : "en cours"}`, () => {
    const per = ls.filter((l) => inRange(l.m));
    return `<div class="grid g2" style="margin-bottom:16px">${kpi2(per)}</div>
      ${seriesBlock(byMonth(ls), `${isCost() ? "Coût" : "Points"} par mois · total toutes périodes ${ufmt(sum(ls, uval))} · ${Object.keys(byMonth(ls)).length} mois (période en foncé)`)}${teamBlock(per)}`;
  });
}
function familyDrawer(base) {
  const ls = DATA.lots.filter((l) => l.base === base);
  openDrawer(base, `Activité récurrente · ${typeOf(ls[0]?.kind)?.[2] || ""}`, () => {
    const per = ls.filter((l) => inRange(l.m)), n = months().length;
    return `<div class="grid g2" style="margin-bottom:16px">${kpi2(per)}</div>
      <div class="xs muted" style="margin-bottom:12px">Moyenne mensuelle : <b>${ufmt(sum(per, uval) / Math.max(1, n))}</b> sur ${n} mois · un lot « - MM/AA » par mois</div>
      ${seriesBlock(byMonth(ls), `${isCost() ? "Coût" : "Points"} par mois (période en foncé)`)}${teamBlock(per)}`;
  });
}
function monthDrawer(m) {
  openDrawer(`Facture de ${ml(m).replace(".", "")}`, "Lots du mois", () => {
    const ls = lots().filter((l) => l.m === m).sort((a, b) => uval(b) - uval(a)), max = uval(ls[0] || { price: 1, hours: 1 }) || 1;
    return `<div class="grid g2" style="margin-bottom:14px">${kpi2(ls)}</div>
      ${ls.map((l) => abar(l.lot, [{ v: uval(l), c: typeOf(l.kind)[1] }], max, ufmt(uval(l)), `data-lot="${esc(l.lot)}" data-kind="${l.kind}" data-base="${esc(l.base)}" style="cursor:pointer"`)).join("")}`;
  });
}

// ---------------------------------------------------------------- fiche d'un membre de l'équipe
function openMember(name) {
  st.tab = "team"; st.member = name;
  ROOT.querySelectorAll("#anTabs button").forEach((x) => x.classList.toggle("on", x.dataset.t === "team"));
  draw(); ROOT.scrollIntoView({ block: "start" });
}

function memberView(v) {
  const P = DATA.team.find((p) => p.name === st.member);
  if (!P) { st.member = null; return teamView(v); }
  const ms = months(), types = TYPES.filter((t) => st.types.has(t[0])), cost = st.unit === "c";
  const F = cost ? kmoney : hfmt, Fx = cost ? money : h1, key = cost ? "cost" : "hours";
  // lignes par lot (projets) ou par activité (récurrentes, tous mois confondus)
  const rows = {};
  DATA.lots.filter((l) => inRange(l.m) && st.types.has(l.kind)).forEach((l) => {
    const me = l.team.find((t) => t[0] === P.name); if (!me) return;
    const k = l.kind === "Projet" ? l.lot : l.base;
    const r = rows[k] || (rows[k] = { k, kind: l.kind, h: 0, c: 0, lh: 0, lc: 0, months: new Set() });
    r.h += me[1]; r.c += me[2]; r.lh += l.hours; r.lc += l.salary; r.months.add(l.m);
  });
  const R = Object.values(rows), H = sum(R, (r) => r.h), C = sum(R, (r) => r.c);
  R.forEach((r) => { r.ph = H ? r.h / H : 0; r.pc = C ? r.c / C : 0; r.sh = r.lh ? r.h / r.lh : 0; r.sc = r.lc ? r.c / r.lc : 0; r.n = r.months.size; });
  const { k: sk, d: sd } = st.msort; R.sort((a, b) => (typeof a[sk] === "number" ? a[sk] - b[sk] : String(a[sk]).localeCompare(String(b[sk]))) * sd);
  const byType = (k) => sum(R.filter((r) => r.kind === k), (r) => (cost ? r.c : r.h));
  const tot = cost ? C : H, run = byType("Support");
  const active = ms.filter((m) => Object.values(P.hours[m] || {}).some((x) => x > 0)).length;
  const others = DATA.team.map((p) => p.name).filter((n) => n !== P.name).sort((a, b) => a.localeCompare(b, "fr"));
  v.innerHTML = `<div class="row" style="gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
      <button class="btn sm ghost" id="anBack">← Équipe</button>
      <div style="flex:1;min-width:180px"><h2 style="font-size:20px;margin:0">${esc(P.name)}</h2><div class="xs muted">${esc(P.poste)}${P.role && P.role !== P.poste ? " · " + esc(P.role) : ""}</div></div>
      <select id="anWho" aria-label="Autre collaborateur" style="width:auto;height:34px"><option value="${esc(P.name)}">${esc(P.name)}</option>${others.map((n) => `<option>${esc(n)}</option>`).join("")}</select>
      <div class="seg" id="anUnit"><button data-u="h" class="${cost ? "" : "on"}">Points (heures)</button><button data-u="c" class="${cost ? "on" : ""}">Coût</button></div></div>
    <div class="grid g4" style="margin-bottom:16px">
      <div class="kpi"><div class="kpi-label">${icon("clock")}Points (heures)</div><div class="kpi-value">${nf0.format(H)}</div><div class="kpi-sub">${active} mois actifs · ${nf0.format(H / Math.max(1, active))} / mois</div></div>
      <div class="kpi"><div class="kpi-label">${icon("coins")}Coût salarial affecté</div><div class="kpi-value">${kmoney(C)}</div><div class="kpi-sub">${H ? money(C / H) + " / point en moyenne" : "—"}</div></div>
      <div class="kpi"><div class="kpi-label">${icon("folder")}Lots et activités</div><div class="kpi-value">${R.length}</div><div class="kpi-sub">${R.filter((r) => r.kind === "Projet").length} projets</div></div>
      <div class="kpi"><div class="kpi-label">${icon("zap")}Part du run (bug fixes)</div><div class="kpi-value">${pct(tot ? run / tot : 0)}</div><div class="kpi-sub">${cost ? "en coût" : "en points"} · build ${pct(tot ? 1 - run / tot : 0)}</div></div></div>
    <div class="grid an-g-wide" style="margin-bottom:16px">
      <div class="card"><div class="card-head"><div class="grow"><h2>Répartition par type</h2><div class="desc">${cost ? "Coût" : "Points"} sur la période</div></div></div><div class="card-body" id="anMDonut"></div></div>
      <div class="card"><div class="card-head"><div class="grow"><h2>${cost ? "Coût" : "Points"} par mois</h2><div class="desc">Survolez une barre pour le détail</div></div></div><div class="card-body">${legend()}<div id="anMBars" style="margin-top:8px"></div></div></div></div>
    <div class="card"><div class="card-head"><div class="grow"><h2>Répartition par projet</h2><div class="desc"><b>% de son temps / coût</b> : où vont ses points · <b>Sa part du lot</b> : ce qu'il représente dans le lot · cliquez sur une ligne pour le détail du lot</div></div></div>
      <div class="table-wrap tall"><table class="t"><thead><tr>
      ${[["k", "Lot / activité"], ["kind", "Type"], ["n", "Mois", 1], ["h", "Points", 1], ["ph", "% de ses pts", 1], ["c", "Coût", 1], ["pc", "% de son coût", 1], ["sh", "Part du lot · pts", 1], ["sc", "Part du lot · coût", 1]].map(([k2, l, n]) => `<th class="sortable ${n ? "num" : ""} ${sk === k2 ? "sorted" : ""}" data-msort="${k2}">${l}<span class="sort-ic">${sk === k2 ? (sd > 0 ? "▲" : "▼") : "↕"}</span></th>`).join("")}</tr></thead>
      <tbody>${R.map((r) => `<tr class="clickable" data-lot="${esc(r.k)}" data-kind="${r.kind}"><td style="max-width:240px"><div class="ellipsis" style="font-weight:600" title="${esc(r.k)}">${esc(r.k)}</div></td>
        <td class="nowrap xs"><span class="sw" style="background:var(${typeOf(r.kind)[1]});margin-right:6px"></span>${typeOf(r.kind)[2]}</td><td class="num">${r.n}</td>
        <td class="num"><b>${h1(r.h).replace(" pts", "")}</b></td><td class="num">${pbar(r.ph)}</td><td class="num"><b>${money(r.c)}</b></td><td class="num">${pbar(r.pc)}</td>
        <td class="num">${pct(r.sh)}</td><td class="num">${pct(r.sc)}</td></tr>`).join("") || `<tr><td colspan="9">${empty("Aucune heure sur la période")}</td></tr>`}</tbody>
      ${R.length ? `<tfoot><tr><td colspan="3"><b>Total</b></td><td class="num"><b>${nf0.format(H)}</b></td><td class="num">100 %</td><td class="num"><b>${money(C)}</b></td><td class="num">100 %</td><td></td><td></td></tr></tfoot>` : ""}</table></div></div>
    <div class="alert alert-info" style="margin-top:16px">${icon("info")}<div>Points = heures de la feuille de temps (prorata compris). Coût = sa part de salaire chargé affectée au lot, au prorata de ses points dans le mois (hors DAP, frais généraux et cost +). « Sa part du lot » compare à l'ensemble des points ou des salaires du lot.</div></div>`;
  $("#anBack", v).onclick = () => { st.member = null; draw(); };
  $("#anWho", v).onchange = (e) => openMember(e.target.value);
  v.querySelectorAll("#anUnit button").forEach((b) => b.onclick = () => { st.unit = b.dataset.u; draw(); });
  v.querySelectorAll("th[data-msort]").forEach((th) => th.onclick = () => { const k2 = th.dataset.msort; st.msort = { k: k2, d: st.msort.k === k2 ? -st.msort.d : (["k", "kind"].includes(k2) ? 1 : -1) }; draw(); });
  v.querySelectorAll("tbody tr[data-lot]").forEach((tr) => tr.onclick = () => tr.dataset.kind === "Projet" ? projectDrawer(tr.dataset.lot) : familyDrawer(tr.dataset.lot));
  donut($("#anMDonut", v), types.map(([k, c, l]) => ({ label: l, color: c, v: byType(k) })), { big: cost ? kmoney(tot) : nf0.format(tot), small: cost ? "coût" : "points" }, F);
  stackedBars($("#anMBars", v), ms.map((m) => { const parts = {}; Object.entries(P[key][m] || {}).forEach(([k, x]) => (parts[k] = x)); return { label: ml(m), parts }; }),
    { label: `${cost ? "Coût" : "Points"} par mois`, axis: cost ? kmoney : (x) => nf0.format(x), fmt: Fx, h: 260 });
}
const pbar = (x, c = "--s1") => `<span class="pbar"><i style="width:${Math.min(100, x * 100)}%;background:var(${c})"></i></span>${pct(x)}`;

// ---------------------------------------------------------------- filtre équipe / poste (en haut de page)
function groupOptions() {
  const teams = [...new Set(RAW.team.map((p) => p.team).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
  const postes = POSTES.filter((g) => RAW.team.some((p) => p.poste === g));
  const o = (v, l) => `<option value="${esc(v)}" ${st.grp === v ? "selected" : ""}>${esc(l)}</option>`;
  return o("", "Toute l'équipe") + (teams.length ? `<optgroup label="Équipes">${teams.map((t) => o("team:" + t, t)).join("")}</optgroup>` : "")
    + `<optgroup label="Postes">${postes.map((g) => o("poste:" + g, g)).join("")}</optgroup>`;
}
// Restreint toutes les données aux membres du groupe choisi : points = leurs points ;
// coût du lot = coût du lot × leur part du salaire du lot (ou des points si pas de salaire).
function applyGroup() {
  if (!st.grp) { DATA = RAW; return; }
  const [kind, val] = [st.grp.slice(0, st.grp.indexOf(":")), st.grp.slice(st.grp.indexOf(":") + 1)];
  const keep = new Set(RAW.team.filter((p) => (kind === "team" ? p.team : p.poste) === val).map((p) => p.name));
  const lots = [];
  RAW.lots.forEach((l) => {
    const team = l.team.filter((t) => keep.has(t[0])); if (!team.length) return;
    const h = sum(team, (t) => t[1]), c = sum(team, (t) => t[2]);
    const share = l.salary > 0 ? c / l.salary : (l.hours > 0 ? h / l.hours : 0);
    lots.push({ ...l, team, hours: h, salary: c, price: l.price * share });
  });
  DATA = { ...RAW, lots, team: RAW.team.filter((p) => keep.has(p.name)) };
}
