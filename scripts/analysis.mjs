// 시총 미달 경고 → 회복/지정 결과와 여러 변수의 관계를 매일 다시 계산한다.
// 표본: KIND "관리종목 지정우려(시가총액 미달)" 경고. 경고 후 14일 안에 관리종목 지정되면 실패, 아니면 회복.
// 아직 14일이 안 지난 경고는 결과가 정해지지 않아 뺀다.
import { kindApi, loadCache, pool } from './history.mjs';

const UA = { 'User-Agent': 'Mozilla/5.0 (delisting-watch)' };
const MAX_DISC_FETCH = 100;
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function json(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.json();
    } catch {}
    await new Promise(r => setTimeout(r, 800 * (i + 1)));
  }
  return null;
}
const chartUrl = (kind, id, from) => `https://api.stock.naver.com/chart/domestic/${kind}/${id}/day?startDateTime=${from.replace(/-/g, '')}0000&endDateTime=${today().replace(/-/g, '')}2359`;

// ---------- 통계 ----------
const erf = x => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const pNorm = z => 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));
const lf = n => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
function fisher(a, b, c, d) {
  const n = a + b + c + d, r1 = a + b, c1 = a + c;
  const p = x => Math.exp(lf(r1) + lf(n - r1) + lf(c1) + lf(n - c1) - lf(n) - lf(x) - lf(r1 - x) - lf(c1 - x) - lf(n - r1 - c1 + x));
  const p0 = p(a); let s = 0;
  for (let x = Math.max(0, c1 - (n - r1)); x <= Math.min(r1, c1); x++) { const q = p(x); if (q <= p0 * 1.0000001) s += q; }
  return Math.min(1, s);
}
const median = v => { v = [...v].sort((a, b) => a - b); const h = v.length >> 1; return !v.length ? null : v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2; };
const mean = v => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : null);
function compare(rows, key, kind) {
  const a = rows.filter(r => r.y === 1 && r[key] != null && isFinite(r[key])).map(r => r[key]);
  const b = rows.filter(r => r.y === 0 && r[key] != null && isFinite(r[key])).map(r => r[key]);
  if (a.length < 5 || b.length < 5) return null;
  if (kind === 'bin') {
    const A = a.filter(Boolean).length, B = b.filter(Boolean).length;
    return { rec: A / a.length, fail: B / b.length, nRec: a.length, nFail: b.length, p: fisher(A, a.length - A, B, b.length - B) };
  }
  const all = [...a.map(v => [v, 1]), ...b.map(v => [v, 0])].sort((x, y) => x[0] - y[0]);
  const rk = [];
  for (let i = 0; i < all.length;) { let j = i; while (j < all.length && all[j][0] === all[i][0]) j++; for (let t = i; t < j; t++) rk[t] = (i + j + 1) / 2; i = j; }
  const Ra = all.reduce((s, x, i) => s + (x[1] ? rk[i] : 0), 0);
  const U = Ra - a.length * (a.length + 1) / 2;
  const mu = a.length * b.length / 2, sd = Math.sqrt(a.length * b.length * (a.length + b.length + 1) / 12);
  return { rec: median(a), fail: median(b), recMean: mean(a), failMean: mean(b), auc: U / (a.length * b.length), nRec: a.length, nFail: b.length, p: pNorm((U - mu) / sd) };
}

// [키, 이름, 종류, 단위, 그룹]
const VARS = [
  ['pre25', '경고 전 25거래일 주가 수익률', 'num', 'pct', '주가·수급'],
  ['excess', '같은 기간 코스닥 대비 초과수익', 'num', 'pct', '주가·수급'],
  ['idxPre', '경고 전 25거래일 코스닥 지수', 'num', 'pct', '시장'],
  ['idxPost', '경고 후 5거래일 코스닥 지수', 'num', 'pct', '시장'],
  ['turnover', '경고 전 일평균 거래대금', 'num', 'eok', '주가·수급'],
  ['vol60', '60일 변동성(연율)', 'num', 'pct', '주가·수급'],
  ['dd120', '120일 고점 대비 낙폭', 'num', 'pct', '주가·수급'],
  ['price', '경고일 주가', 'num', 'won', '주가·수급'],
  ['penny', '1,000원 미만 동전주', 'bin', '', '주가·수급'],
  ['foreign', '외국인 지분율', 'num', 'pp', '주가·수급'],
  ['rev', '직전 연도 매출', 'num', 'eok', '재무'],
  ['revGrowth', '직전 연도 매출 성장률', 'num', 'pct', '재무'],
  ['opm', '직전 연도 영업이익률', 'num', 'pp', '재무'],
  ['opPos', '직전 연도 영업흑자', 'bin', '', '재무'],
  ['niPos', '직전 연도 순이익 흑자', 'bin', '', '재무'],
  ['debt', '직전 연도 부채비율', 'num', 'pp', '재무'],
  ['dMajor', '최대주주·경영권 변경 공시', 'bin', '', '공시'],
  ['dThird', '제3자배정 유상증자 공시', 'bin', '', '공시'],
  ['dPublic', '일반공모·주주배정 유상증자 공시', 'bin', '', '공시'],
  ['dCB', 'CB·BW·EB 공시', 'bin', '', '공시'],
  ['dCut', '감자·주식병합 공시', 'bin', '', '공시'],
  ['dBuyback', '자사주 취득·소각 공시', 'bin', '', '공시'],
  ['dContract', '공급계약 공시', 'bin', '', '공시'],
  ['dMA', '합병·분할·타법인 취득 공시', 'bin', '', '공시'],
];
// 실제 최대주주·경영권 변경만. 담보제공·지분 변동 신고·소송·취소 공시는 제외한다.
export const MAJOR_RE = /^(?!.*(담보|소유주식변동|소송|기타시장안내|해제|취소|철회)).*(최대주주\s*변경|경영권\s*변경|주식\s*양수도)/;
const DISC = {
  dMajor: MAJOR_RE, dThird: /제3자배정/, dPublic: /일반공모|주주배정/, dCB: /전환사채|신주인수권|교환사채|주식관련사채/,
  dCut: /감자|병합/, dBuyback: /자기주식.*취득|주식소각/, dContract: /공급계약|단일판매/, dMA: /합병|분할|타법인|양수/,
};

// 기준 조건(경고 전 하락이 실패군 중앙값보다 작음)과 다른 조건을 2×2, 조합별로 비교한다.
// 기준선은 매번 그날의 실패군 중앙값으로 다시 잡는다.
function comboAnalysis(eps) {
  const E = eps.filter(e => e.pre25 != null);
  const failMed = k => median(E.filter(e => !e.y && e[k] != null).map(e => e[k]));
  const cutPre = failMed('pre25'), cutEx = failMed('excess'), cutTo = failMed('turnover');
  if (cutPre == null) return null;
  const base = e => e.pre25 > cutPre;
  const pc = v => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
  const C = [
    { key: 'major', short: '최대주주 변경', label: '최대주주·경영권 변경 공시', f: e => e.dMajor === 1 },
    { key: 'third', short: '제3자배정 증자', label: '제3자배정 유상증자 공시', f: e => e.dThird === 1 },
    { key: 'excess', short: `초과수익 > ${pc(cutEx)}`, label: `코스닥 대비 초과수익 ${pc(cutEx)}보다 덜 하락`, f: e => e.excess != null && e.excess > cutEx },
    { key: 'turn', short: `거래대금 < ${cutTo.toFixed(1)}억`, label: `일평균 거래대금 ${cutTo.toFixed(1)}억 미만`, f: e => e.turnover != null && e.turnover < cutTo },
  ];
  const cnt = a => ({ n: a.length, rec: a.filter(e => e.y).length });
  const test = (a, b) => { const x = a.filter(e => e.y).length, y = b.filter(e => e.y).length; return fisher(x, a.length - x, y, b.length - y); };
  const EA = E.filter(base), EB = E.filter(e => !base(e));
  const single = C.map(c => {
    const a1 = EA.filter(c.f), a0 = EA.filter(e => !c.f(e)), b1 = EB.filter(c.f), b0 = EB.filter(e => !c.f(e));
    return { key: c.key, label: c.label, a1: cnt(a1), a0: cnt(a0), b1: cnt(b1), b0: cnt(b0), pA: test(a1, a0), pB: test(b1, b0) };
  });
  const combos = [];
  for (let m = 1; m < (1 << C.length); m++) {
    const cs = C.filter((_, i) => (m >> i) & 1);
    if (cs.length < 2) continue;
    const s = EA.filter(e => cs.every(c => c.f(e))), rest = EA.filter(e => !cs.every(c => c.f(e)));
    if (!s.length) continue;
    combos.push({ keys: cs.map(c => c.key), labels: cs.map(c => c.label), shorts: cs.map(c => c.short), hit: cnt(s), rest: cnt(rest), p: test(s, rest) });
  }
  combos.sort((a, b) => a.p - b.p);
  const score = [];
  for (let k = 0; k <= C.length + 1; k++) {
    const s = E.filter(e => C.filter(c => c.f(e)).length + (base(e) ? 1 : 0) === k);
    score.push({ k, ...cnt(s) });
  }
  return {
    baseLabel: `경고 전 25거래일 주가가 ${pc(cutPre)}보다 덜 떨어짐`, cutPre, cutEx, cutTo,
    all: cnt(E), base: cnt(EA), notBase: cnt(EB), single, combos, score, nTests: single.length + combos.length,
  };
}

/**
 * @param {object} p
 * @param {string} p.root
 * @param {Record<string, any[]>} p.lists
 * @param {(code:string)=>Promise<object>} p.details
 */
export async function buildAnalysis({ root, lists, details }) {
  const T = today();
  const { c: cache, save } = loadCache(root);
  cache.disc ||= {};

  const byName = {};
  for (const [mk, arr] of Object.entries(lists)) for (const s of arr)
    if (s.stockEndType === 'stock' && s.itemCode.endsWith('0')) byName[s.stockName] = { ...s, market: mk };

  const groups = {};
  for (const [rcp, e] of Object.entries(cache.events)) (groups[e.nm] ||= []).push({ ...e, rcp });

  const eps = [];
  let pending = 0, noData = 0;
  for (const [nm, es] of Object.entries(groups)) {
    es.sort((a, b) => (a.d < b.d ? -1 : 1));
    for (const w of es.filter(e => e.t === 'W')) {
      const desig = es.find(e => e.t === 'D' && e.d > w.d && e.d <= addDays(w.d, 14));
      if (!desig && w.d > addDays(T, -14)) { pending++; continue; }
      const s = byName[nm];
      if (!s) { noData++; continue; } // 상장폐지 등으로 데이터 없음
      eps.push({ nm, code: s.itemCode, m: s.market === 'KOSPI' ? 0 : 1, d: w.d, y: desig ? 0 : 1, delistedLater: es.some(e => e.x) });
    }
  }
  console.log('분석 표본', eps.length, '대기', pending, '데이터 없음', noData);

  const from = addDays(eps.reduce((m, e) => (e.d < m ? e.d : m), T), -220);
  const idx = (await json(chartUrl('index', 'KOSDAQ', from))) || [];
  const charts = {};
  await pool([...new Set(eps.map(e => e.code))], 4, async code => { charts[code] = (await json(chartUrl('item', code, from))) || []; });

  let discFetched = 0;
  for (const e of eps) {
    const key = `w|${e.code}|${e.d}`;
    if (!cache.disc[key] && !kindApi.blocked() && discFetched < MAX_DISC_FETCH) {
      try {
        if (!kindApi.hasSession()) await kindApi.session();
        // 지정 여부가 정해지기 전(경고 60일 전 ~ 7일 후) 공시만 본다
        const rows = await kindApi.search({ corp: e.nm, code: e.code, from: addDays(e.d, -60), to: addDays(e.d, 7) });
        cache.disc[key] = rows.filter(r => r.nm === e.nm).map(r => r.title);
        discFetched++;
      } catch (err) { console.error('경고 공시 조회 실패', e.nm, err.message); }
    }
    e.titles = cache.disc[key] || null;
  }
  save();

  for (const e of eps) {
    const ch = charts[e.code];
    const n = e.d.replace(/-/g, '');
    const i = ch.findIndex(x => x.localDate >= n);
    if (i >= 60) {
      const P = k => ch[k].closePrice;
      e.pre25 = P(i) / P(i - 25) - 1;
      const rets = [];
      for (let k = i - 59; k <= i; k++) rets.push(Math.log(P(k) / P(k - 1)));
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      e.vol60 = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) * Math.sqrt(250);
      e.dd120 = P(i) / Math.max(...ch.slice(Math.max(0, i - 120), i + 1).map(x => x.highPrice)) - 1;
      e.turnover = ch.slice(i - 25, i).reduce((a, x) => a + x.accumulatedTradingVolume * x.closePrice, 0) / 25 / 1e8;
      e.price = P(i);
      e.penny = P(i) < 1000 ? 1 : 0;
      e.foreign = ch[i].foreignRetentionRate;
    }
    const ii = idx.findIndex(x => x.localDate >= n);
    if (ii >= 25) {
      e.idxPre = idx[ii].closePrice / idx[ii - 25].closePrice - 1;
      e.idxPost = idx[Math.min(idx.length - 1, ii + 5)].closePrice / idx[ii].closePrice - 1;
      if (e.pre25 != null) e.excess = e.pre25 - e.idxPre;
    }
    const det = await details(e.code);
    const yr = String(+e.d.slice(0, 4) - 1);
    const yi = det.years.findIndex(k => k.startsWith(yr));
    const pi = det.years.findIndex(k => k.startsWith(String(+yr - 1)));
    const f = (t, j) => (j >= 0 ? det.fin[t]?.[j] ?? null : null);
    e.rev = f('매출액', yi);
    e.revGrowth = e.rev != null && f('매출액', pi) > 0 ? e.rev / f('매출액', pi) - 1 : null;
    const op = f('영업이익', yi), ni = f('당기순이익', yi);
    e.opm = e.rev > 0 && op != null ? op / e.rev * 100 : null;
    e.opPos = op == null ? null : op > 0 ? 1 : 0;
    e.niPos = ni == null ? null : ni > 0 ? 1 : 0;
    e.debt = f('부채비율', yi);
    e.sector = det.big;
    for (const [k, re] of Object.entries(DISC)) e[k] = e.titles ? (e.titles.some(t => re.test(t)) ? 1 : 0) : null;
  }

  const vars = VARS.map(([key, label, kind, unit, group]) => {
    const r = compare(eps, key, kind);
    return r && { key, label, kind, unit, group, ...r };
  }).filter(Boolean).sort((a, b) => a.p - b.p);

  const rate = a => (a.length ? a.filter(e => e.y).length / a.length : null);
  const months = {};
  for (const e of eps) (months[e.d.slice(0, 7)] ||= []).push(e);
  const byMonth = Object.keys(months).sort().map(m => ({
    m, n: months[m].length, rec: months[m].filter(e => e.y).length,
    idxPre: median(months[m].map(e => e.idxPre).filter(x => x != null)),
  }));
  const bucket = (label, f) => { const a = eps.filter(e => e.idxPre != null && f(e.idxPre)); return { label, n: a.length, rate: rate(a) }; };
  const market = [
    bucket('코스닥이 10% 넘게 빠진 시기', x => x <= -0.10),
    bucket('코스닥 -10% ~ 0%', x => x > -0.10 && x <= 0),
    bucket('코스닥이 오르던 시기', x => x > 0),
  ];
  const sec = {};
  for (const e of eps) (sec[e.sector || '기타'] ||= []).push(e);
  const sectors = Object.entries(sec).map(([b, a]) => ({ b, n: a.length, rec: a.filter(e => e.y).length })).sort((a, b) => b.n - a.n);

  const combos = comboAnalysis(eps);

  return {
    asOf: new Date().toISOString(),
    combos,
    n: eps.length, nRec: eps.filter(e => e.y).length, nFail: eps.filter(e => !e.y).length,
    pending, noData, uniq: new Set(eps.map(e => e.code)).size,
    first: eps.reduce((m, e) => (e.d < m ? e.d : m), T), last: eps.reduce((m, e) => (e.d > m ? e.d : m), '0'),
    discCovered: eps.filter(e => e.titles).length,
    vars, byMonth, market, sectors,
    // 경고 건별 값 (추가 분석용)
    eps: eps.map(e => { const o = { nm: e.nm, code: e.code, d: e.d, y: e.y, sector: e.sector }; for (const [k] of VARS) o[k] = e[k] ?? null; return o; }),
  };
}
