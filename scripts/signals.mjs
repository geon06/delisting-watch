// 현재 시총 미달 후보 종목마다 '회복 요인'에서 뚜렷했던 조건 5개를 오늘 기준으로 채점한다.
// 1) 최근 25거래일 주가가 실패군 중앙값보다 덜 하락  2) 같은 기간 지수 대비 초과수익이 실패군 중앙값보다 덜 하락
// 3) 최근 25거래일 일평균 거래대금이 실패군 중앙값 미만  4) 최근 60일 제3자배정 유상증자 공시  5) 최근 60일 최대주주·경영권 변경 공시
// 공시는 종목별이 아니라 공시 이름으로 시장 전체를 검색해 KIND 요청 수를 줄인다.
import { kindApi, pool, loadCache } from './history.mjs';
import { computeDeadline } from './deadline.mjs';
import { MAJOR_RE } from './analysis.mjs';

const UA = { 'User-Agent': 'Mozilla/5.0 (delisting-watch)' };
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

/**
 * @param {object} p
 * @param {{c:string,n:string,m:number}[]} p.rows  현재 후보 종목
 * @param {object} p.combos  analysis.combos (기준선과 점수별 과거 회복률)
 */
export async function buildSignals({ root, rows, combos }) {
  if (!combos) throw new Error('기준선(analysis.combos)이 없음');
  const T = today();
  const from = addDays(T, -200); // 관리종목 지정 후 기간까지 보려고 길게 받는다
  const { c: cache } = loadCache(root);
  const evByName = {};
  for (const e of Object.values(cache.events)) (evByName[e.nm] ||= []).push({ d: e.d, t: e.t });
  for (const a of Object.values(evByName)) a.sort((x, y) => (x.d < y.d ? -1 : 1));
  const idx = { 0: (await json(chartUrl('index', 'KOSPI', from))) || [], 1: (await json(chartUrl('index', 'KOSDAQ', from))) || [] };

  // 공시: 시장 전체 검색 (최근 60일)
  const third = {}, major = {};
  let discOk = false;
  try {
    if (!kindApi.hasSession()) await kindApi.session();
    const dFrom = addDays(T, -60);
    for (const r of await kindApi.search({ reportNm: '제3자배정', from: dFrom, to: T })) {
      if (/제3자배정/.test(r.title) && !/철회/.test(r.title)) (third[r.nm] ||= []).push(r.dt);
    }
    for (const q of ['최대주주 변경', '경영권 변경', '주식양수도']) {
      for (const r of await kindApi.search({ reportNm: q, from: dFrom, to: T })) {
        if (MAJOR_RE.test(r.title)) (major[r.nm] ||= []).push(r.dt + ' ' + r.title);
      }
    }
    discOk = true;
  } catch (e) {
    console.error('신호용 공시 조회 실패:', e.message);
  }

  const out = {};
  await pool(rows, 6, async r => {
    const ch = (await json(chartUrl('item', r.c, from))) || [];
    const o = {};
    const L = ch.length - 1;
    if (L >= 25) {
      const ix = idx[r.m];
      o.pre25 = ch[L].closePrice / ch[L - 25].closePrice - 1;
      const i0 = ix.findIndex(x => x.localDate >= ch[L - 25].localDate);
      const i1 = ix.findIndex(x => x.localDate >= ch[L].localDate);
      if (i0 >= 0) o.excess = o.pre25 - (ix[i1 < 0 ? ix.length - 1 : i1].closePrice / ix[i0].closePrice - 1);
      o.turnover = ch.slice(L - 24, L + 1).reduce((s, x) => s + x.accumulatedTradingVolume * x.closePrice, 0) / 25 / 1e8;
    }
    if (discOk) {
      o.third = (third[r.n] || []).sort().at(-1) || null;
      o.major = (major[r.n] || []).sort().at(-1) || null;
    }
    const c = [
      o.pre25 != null && o.pre25 > combos.cutPre,
      o.excess != null && o.excess > combos.cutEx,
      o.turnover != null && o.turnover < combos.cutTo,
      !!o.third,
      !!o.major,
    ];
    o.ok = c.map(Number);
    o.score = c.filter(Boolean).length;
    o.star = c[0] && c[3] && (c[2] || c[4]) ? 1 : 0;
    if (r.p > 0 && r.mc > 0) {
      const series = ch.map(x => [`${x.localDate.slice(0, 4)}-${x.localDate.slice(4, 6)}-${x.localDate.slice(6, 8)}`, x.closePrice]);
      o.dl = computeDeadline({ series, shares: r.mc * 1e8 / r.p, m: r.m, events: evByName[r.n] || [] });
    }
    out[r.c] = o;
  });

  return {
    asOf: new Date().toISOString(), discOk,
    cuts: { pre: combos.cutPre, ex: combos.cutEx, to: combos.cutTo },
    hist: combos.score, // 점수별 과거 회복률
    s: out,
  };
}
