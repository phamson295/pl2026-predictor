// Lấy kết quả mới nhất từ API Fantasy Premier League (miễn phí, không cần key),
// chạy mô phỏng Monte Carlo và ghi ra data.js (+ history.json để theo dõi xu hướng).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const API = "https://fantasy.premierleague.com/api";
const SIMS = 20000;   // số mùa giải mô phỏng
const PRIOR = 6;      // "số trận ảo" ở mức trung bình giải để tránh dự đoán cực đoan đầu mùa
const UA = { headers: { "User-Agent": "Mozilla/5.0" } };

const get = async (p) => {
  const r = await fetch(API + p, UA);
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
};

// Poisson sampler (Knuth)
function poisson(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

const [boot, fixtures] = await Promise.all([get("/bootstrap-static/"), get("/fixtures/")]);

const teams = boot.teams.map((t) => ({
  id: t.id, name: t.name, short: t.short_name, code: t.code,
  p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, hGf: 0, hGa: 0, hP: 0, aGf: 0, aGa: 0, aP: 0, form: [],
}));
const T = Object.fromEntries(teams.map((t) => [t.id, t]));

const played = fixtures.filter((f) => f.finished || f.finished_provisional)
  .filter((f) => f.team_h_score != null && f.team_a_score != null)
  .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));
const remaining = fixtures.filter((f) => !played.includes(f));

let lastResults = [];
for (const f of played) {
  const h = T[f.team_h], a = T[f.team_a], hs = f.team_h_score, as = f.team_a_score;
  h.p++; a.p++; h.gf += hs; h.ga += as; a.gf += as; a.ga += hs;
  h.hP++; h.hGf += hs; h.hGa += as; a.aP++; a.aGf += as; a.aGa += hs;
  if (hs > as) { h.w++; a.l++; h.form.push("W"); a.form.push("L"); }
  else if (hs < as) { a.w++; h.l++; h.form.push("L"); a.form.push("W"); }
  else { h.d++; a.d++; h.form.push("D"); a.form.push("D"); }
}
lastResults = played.slice(-10).reverse().map((f) => ({
  date: f.kickoff_time, home: T[f.team_h].short, away: T[f.team_a].short, hs: f.team_h_score, as: f.team_a_score,
}));

// ---- CÔNG THỨC ----
// Bàn thắng kỳ vọng của đội nhà  = TB_bàn_nhà  × Tấn công(nhà) × Phòng thủ yếu(khách)
// Bàn thắng kỳ vọng của đội khách = TB_bàn_khách × Tấn công(khách) × Phòng thủ yếu(nhà)
// Tấn công = (bàn ghi + PRIOR×TB) / ((số trận + PRIOR)×TB)  -> kéo về 1.0 khi ít dữ liệu
const nPlayed = played.length;
const avgHome = nPlayed ? played.reduce((s, f) => s + f.team_h_score, 0) / nPlayed : 1.5;
const avgAway = nPlayed ? played.reduce((s, f) => s + f.team_a_score, 0) / nPlayed : 1.2;
const avgGoals = (avgHome + avgAway) / 2;
for (const t of teams) {
  const g = Math.max(t.p, 0);
  t.attack = (t.gf + PRIOR * avgGoals) / ((g + PRIOR) * avgGoals);
  t.defence = (t.ga + PRIOR * avgGoals) / ((g + PRIOR) * avgGoals); // >1 = phòng thủ tệ
  t.pts = t.w * 3 + t.d;
  t.gd = t.gf - t.ga;
}

const fx = remaining.map((f) => {
  const h = T[f.team_h], a = T[f.team_a];
  return { h: h.id, a: a.id, lh: avgHome * h.attack * a.defence, la: avgAway * a.attack * h.defence };
});

const idx = teams.map((t) => t.id);
const champ = Object.fromEntries(idx.map((i) => [i, 0]));
const top4 = { ...champ }, rel = { ...champ }, ptsSum = { ...champ };

for (let s = 0; s < SIMS; s++) {
  const pts = {}, gd = {}, gf = {};
  for (const t of teams) { pts[t.id] = t.pts; gd[t.id] = t.gd; gf[t.id] = t.gf; }
  for (const m of fx) {
    const hs = poisson(m.lh), as = poisson(m.la);
    gd[m.h] += hs - as; gd[m.a] += as - hs; gf[m.h] += hs; gf[m.a] += as;
    if (hs > as) pts[m.h] += 3; else if (hs < as) pts[m.a] += 3; else { pts[m.h]++; pts[m.a]++; }
  }
  const order = [...idx].sort((x, y) => pts[y] - pts[x] || gd[y] - gd[x] || gf[y] - gf[x] || Math.random() - 0.5);
  champ[order[0]]++;
  for (let i = 0; i < 4; i++) top4[order[i]]++;
  for (let i = order.length - 3; i < order.length; i++) rel[order[i]]++;
  for (const i of idx) ptsSum[i] += pts[i];
}

const out = teams.map((t) => ({
  id: t.id, name: t.name, short: t.short, code: t.code,
  played: t.p, w: t.w, d: t.d, l: t.l, gf: t.gf, ga: t.ga, gd: t.gd, pts: t.pts,
  form: t.form.slice(-5),
  attack: +t.attack.toFixed(2), defence: +t.defence.toFixed(2),
  champion: champ[t.id] / SIMS, top4: top4[t.id] / SIMS, relegation: rel[t.id] / SIMS,
  projPts: +(ptsSum[t.id] / SIMS).toFixed(1),
})).sort((a, b) => b.champion - a.champion || b.pts - a.pts);

// Lịch sử dự đoán theo ngày
const histFile = join(DIR, "history.json");
const history = existsSync(histFile) ? JSON.parse(readFileSync(histFile, "utf8")) : [];
const today = new Date().toISOString().slice(0, 10);
const prev = [...history].reverse().find((h) => h.date !== today);
const snap = { date: today, played: nPlayed, champion: Object.fromEntries(out.map((t) => [t.short, +t.champion.toFixed(4)])) };
const i = history.findIndex((h) => h.date === today);
if (i >= 0) history[i] = snap; else history.push(snap);
writeFileSync(histFile, JSON.stringify(history, null, 1));
for (const t of out) t.change = prev ? t.champion - (prev.champion[t.short] ?? 0) : null;

const nextGw = boot.events.find((e) => e.is_next) || boot.events.find((e) => e.is_current);
const data = {
  updatedAt: new Date().toISOString(),
  season: "2026/27",
  matchesPlayed: nPlayed, matchesLeft: remaining.length, sims: SIMS,
  currentGameweek: (boot.events.find((e) => e.is_current) || {}).id ?? null,
  nextGameweek: nextGw ? nextGw.id : null,
  avgHome: +avgHome.toFixed(2), avgAway: +avgAway.toFixed(2),
  teams: out, lastResults,
  history: history.map((h) => ({ date: h.date, champion: h.champion })),
};
writeFileSync(join(DIR, "data.js"), "window.PL_DATA = " + JSON.stringify(data) + ";\n");
console.log(`OK: ${nPlayed} trận đã đá, ${remaining.length} trận còn lại.`);
console.log(out.slice(0, 5).map((t) => `${t.name} ${(t.champion * 100).toFixed(1)}%`).join(" | "));
