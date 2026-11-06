// 네이버 증권 공개 데이터를 받아 시총 미달 후보를 추리고 public/index.html 을 만든다.
// 실행: node scripts/build.mjs  (Node 20 이상)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHistory } from './history.mjs';
import { buildAnalysis } from './analysis.mjs';
import { buildSignals } from './signals.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://m.stock.naver.com/api';
// 가장 늦은 단계(2028~)의 시총 기준. 이보다 작은 종목만 상세 데이터를 받는다.
const MCAP_LIMIT = { KOSPI: 5e10, KOSDAQ: 3e10 };

const BIG = {
  'IT·반도체': ['IT서비스','소프트웨어','전자장비와기기','디스플레이장비및부품','핸드셋','통신장비','컴퓨터와주변기기','반도체와반도체장비','전자제품','디스플레이패널','양방향미디어와서비스','사무용전자제품'],
  '자동차·운송': ['자동차부품','자동차','조선','항공화물운송과물류','해운사','운송인프라','항공사','도로와철도운송'],
  '소비재': ['섬유,의류,신발,호화품','식품','화장품','가구','가정용품','음료','레저용장비와제품','가정용기기와용품','문구류','판매업체','식품과기본식료품소매','백화점과일반상점','담배','호텔,레스토랑,레저','교육서비스','인터넷과카탈로그소매','다각화된소비자서비스'],
  '헬스케어': ['제약','건강관리장비와용품','생물공학','생명과학도구및서비스','건강관리업체및서비스','건강관리기술'],
  '소재': ['화학','철강','비철금속','포장재','종이와목재'],
  '산업재': ['기계','전기제품','전기장비','건설','건축자재','건축제품','상업서비스와공급품','우주항공과국방','에너지장비및서비스','무역회사와판매업체','복합기업'],
  '미디어·통신': ['방송과엔터테인먼트','광고','게임엔터테인먼트','출판','무선통신서비스','다각화된통신서비스'],
  '금융·부동산': ['부동산','창업투자','기타금융','증권','은행','손해보험','생명보험','카드'],
  '에너지·유틸리티': ['석유와가스','전기유틸리티','가스유틸리티','복합유틸리티'],
};
const bigOf = sec => Object.keys(BIG).find(k => BIG[k].includes(sec)) || '기타';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (delisting-watch)' }, signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.json();
    } catch {}
    await sleep(800 * (i + 1));
  }
  return null;
}
const num = v => {
  if (v == null || v === '-' || v === '') return null;
  const n = +String(v).replace(/,/g, '');
  return Number.isNaN(n) ? null : n;
};

async function listMarket(m) {
  const all = [];
  for (let p = 1; ; p++) {
    const r = await get(`${API}/stocks/marketValue/${m}?page=${p}&pageSize=100`);
    if (!r?.stocks?.length) break;
    all.push(...r.stocks);
    if (all.length >= r.totalCount) break;
  }
  return all;
}

async function main() {
  const industries = [];
  for (let p = 1; p <= 3; p++) {
    const r = await get(`${API}/stocks/industry?page=${p}&pageSize=50`);
    if (!r?.groups?.length) break;
    industries.push(...r.groups);
  }
  const indName = Object.fromEntries(industries.map(g => [g.no, g.name]));

  const cands = [];
  const lists = {};
  for (const m of ['KOSPI', 'KOSDAQ']) {
    const list = await listMarket(m);
    lists[m] = list;
    console.log(m, 'listed', list.length);
    if (list.length < 500) throw new Error(`${m} 종목 목록이 너무 적음(${list.length}) - API 응답 이상`);
    for (const s of list) {
      const mcap = +s.marketValueRaw;
      if (s.stockEndType !== 'stock' || !s.itemCode.endsWith('0') || !(mcap < MCAP_LIMIT[m])) continue;
      if (/클래스/.test(s.stockName)) continue;
      cands.push({ code: s.itemCode, name: s.stockName, market: m, price: +s.closePriceRaw,
        chg: +s.fluctuationsRatio, mcap, stop: s.tradeStopType?.name });
    }
  }
  console.log('candidates', cands.length);

  const detailCache = {};
  async function details(code) {
    if (detailCache[code]) return detailCache[code];
    const s = {};
    const [it, fa] = await Promise.all([
      get(`${API}/stock/${code}/integration`),
      get(`${API}/stock/${code}/finance/annual`),
    ]);
    const ti = Object.fromEntries((it?.totalInfos || []).map(x => [x.code, x.value]));
    s.sector = indName[it?.industryCode] || '기타';
    s.pbr = ti.pbr && ti.pbr !== 'N/A' ? parseFloat(ti.pbr.replace(/,/g, '')) : null;
    s.hi = num(ti.highPriceOf52Weeks); s.lo = num(ti.lowPriceOf52Weeks);
    s.fin = {}; s.years = [];
    const fi = fa?.financeInfo;
    if (fi) {
      s.years = fi.trTitleList.filter(t => t.isConsensus === 'N').map(t => t.key);
      for (const r of fi.rowList)
        if (['매출액', '영업이익', '당기순이익', '부채비율'].includes(r.title))
          s.fin[r.title] = s.years.map(k => num(r.columns[k]?.value));
    }
    s.big = bigOf(s.sector);
    return (detailCache[code] = s);
  }
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < cands.length) {
      const s = cands[i++];
      Object.assign(s, await details(s.code));
    }
  }));

  const last = a => (a?.length ? a[a.length - 1] : null);
  const rows = cands.map(s => ({
    c: s.code, n: s.name, m: s.market === 'KOSPI' ? 0 : 1, p: s.price, ch: s.chg,
    mc: Math.round(s.mcap / 1e7) / 10, sec: s.sector, b: bigOf(s.sector),
    y: s.years.map(k => k.slice(0, 4) + '.' + k.slice(4)),
    rv: s.fin['매출액'] || [], op: s.fin['영업이익'] || [], ni: s.fin['당기순이익'] || [],
    db: last(s.fin['부채비율']), pbr: s.pbr, hi: s.hi, lo: s.lo,
    st: s.stop !== 'TRADING' ? 1 : 0, sp: /스팩/.test(s.name) ? 1 : 0,
  }));
  const withFin = rows.filter(r => r.rv.length).length;
  if (withFin < rows.length * 0.8) throw new Error(`재무 데이터가 비어 있는 종목이 너무 많음(${withFin}/${rows.length})`);

  const data = { asOf: new Date().toISOString(), rows };
  const tpl = fs.readFileSync(path.join(ROOT, 'scripts', 'template.html'), 'utf8');
  fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'public', 'index.html'), tpl.replace('__DATA__', () => JSON.stringify(data)));
  fs.writeFileSync(path.join(ROOT, 'public', 'data.json'), JSON.stringify(data));
  console.log('wrote public/index.html,', rows.length, 'rows');

  // 과거 회복 사례. 실패하면 저장소에 커밋된 스냅샷을 쓴다.
  const histOut = path.join(ROOT, 'public', 'history.json');
  const histSnap = path.join(ROOT, 'data', 'history.json');
  try {
    const hist = await buildHistory({ root: ROOT, lists, details });
    if (hist.cases.length < 10) throw new Error('회복 사례가 너무 적음: ' + hist.cases.length);
    const json = JSON.stringify(hist);
    fs.writeFileSync(histOut, json);
    fs.mkdirSync(path.dirname(histSnap), { recursive: true });
    fs.writeFileSync(histSnap, json);
  } catch (e) {
    console.error('history 수집 실패, 스냅샷 사용:', e.message);
    if (fs.existsSync(histSnap)) fs.copyFileSync(histSnap, histOut);
  }

  // 회복 요인 분석. 실패하면 스냅샷을 쓴다.
  const anOut = path.join(ROOT, 'public', 'analysis.json');
  const anSnap = path.join(ROOT, 'data', 'analysis.json');
  try {
    const an = await buildAnalysis({ root: ROOT, lists, details });
    if (an.n < 20) throw new Error('분석 표본이 너무 적음: ' + an.n);
    const json = JSON.stringify(an);
    fs.writeFileSync(anOut, json);
    fs.writeFileSync(anSnap, json);
  } catch (e) {
    console.error('analysis 실패, 스냅샷 사용:', e.message);
    if (fs.existsSync(anSnap)) fs.copyFileSync(anSnap, anOut);
  }

  // 현재 후보 종목의 회복 신호 점수
  const sigOut = path.join(ROOT, 'public', 'signals.json');
  try {
    const an = JSON.parse(fs.readFileSync(anOut, 'utf8'));
    const sig = await buildSignals({ root: ROOT, rows: rows.map(r => ({ c: r.c, n: r.n, m: r.m, mc: r.mc, p: r.p })), combos: an.combos });
    fs.writeFileSync(sigOut, JSON.stringify(sig));
    console.log('회복 신호', Object.keys(sig.s).length, '종목, 공시', sig.discOk ? '확인' : '실패');
  } catch (e) {
    console.error('signals 실패:', e.message);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
