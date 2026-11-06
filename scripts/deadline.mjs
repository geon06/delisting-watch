// 시총 미달 기한 계산.
// - 관리종목이 아님: 기준 미달 30거래일 연속이면 관리종목 지정 → 남은 일수 = 30 - 연속 미달 일수
//   (코스닥은 25거래일째 경고 공시가 나오므로, 경고가 있으면 그 날짜로 정확히 센다)
// - 시총 미달 관리종목: 지정 후 90거래일 안에 기준 이상 45거래일 연속이어야 해제
//   → 늦어도 지정 후 45거래일째까지는 기준 위로 올라가 버텨야 한다
// 과거 시총은 종가 × 현재 주식수로 추정하므로 그사이 증자 등이 있었다면 오차가 있다.
import { mcapLimitAt } from './history.mjs';

// KRX 휴장일(주말 제외). 미래 날짜 계산에만 쓰며, 과거는 실제 거래일(차트 날짜)을 쓴다.
// 대체공휴일 포함 추정치라 실제 휴장일과 하루 이틀 다를 수 있다.
const HOLIDAYS = new Set([
  '2026-12-25', '2026-12-31',
  '2027-01-01', '2027-02-08', '2027-02-09', '2027-03-01', '2027-05-05', '2027-05-13',
  '2027-08-16', '2027-09-14', '2027-09-15', '2027-09-16', '2027-10-04', '2027-10-11',
  '2027-12-27', '2027-12-31',
]);

const iso = d => d.toISOString().slice(0, 10);
export function addTradingDays(from, n) {
  const d = new Date(from + 'T00:00:00Z');
  let k = 0;
  while (k < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const w = d.getUTCDay();
    if (w === 0 || w === 6 || HOLIDAYS.has(iso(d))) continue;
    k++;
  }
  return iso(d);
}

/**
 * @param {object} p
 * @param {[string, number][]} p.series  [YYYY-MM-DD, 종가] 오름차순 (실제 거래일)
 * @param {number} p.shares  현재 상장주식수
 * @param {number} p.m  0=코스피, 1=코스닥
 * @param {{d:string,t:string}[]} p.events  KIND 시총 이벤트 (W 경고, D 지정, R 해제), 날짜 오름차순
 */
export function computeDeadline({ series, shares, m, events }) {
  if (!series.length || !shares) return null;
  const last = series[series.length - 1][0];
  const below = series.map(([d, c]) => (c * shares) / 1e8 < mcapLimitAt(d, m));
  const idxAfter = d => { const i = series.findIndex(([x]) => x > d); return i < 0 ? series.length : i; };
  const runFromEnd = v => { let k = 0; for (let i = below.length - 1; i >= 0 && below[i] === v; i--) k++; return k; };

  const lastD = [...events].reverse().find(e => e.t === 'D');
  const lastR = [...events].reverse().find(e => e.t === 'R');
  const designated = lastD && (!lastR || lastR.d < lastD.d);

  if (designated) {
    // 공시 다음 거래일이 지정일. 지정일을 1일째로 센다.
    const startIdx = idxAfter(lastD.d);
    const elapsed = Math.max(0, series.length - startIdx); // 지정일부터 오늘까지 거래일 수
    const startDate = startIdx < series.length ? series[startIdx][0] : addTradingDays(lastD.d, 1);
    // 지난 날짜는 실제 거래일(차트)로, 앞으로의 날짜는 휴장일 목록으로 센다
    const nth = k => (startIdx + k < series.length ? series[startIdx + k][0] : addTradingDays(last, startIdx + k - (series.length - 1)));
    const latestStart = nth(45); // 이날까지 기준 위로 올라가야 45일 연속 가능
    const windowEnd = nth(89);   // 90거래일째
    const aboveRun = below[below.length - 1] ? 0 : Math.min(runFromEnd(false), elapsed);
    const left = 45 - elapsed;                               // 기준 위로 올라가야 하는 마감까지 남은 거래일
    if (aboveRun > 0) {
      const need = 45 - aboveRun;
      return { mode: 'D', state: 'recovering', run: aboveRun, left: need, date: addTradingDays(last, need), since: startDate, end: windowEnd };
    }
    if (left < 0) return { mode: 'D', state: 'passed', left, date: latestStart, since: startDate, end: windowEnd };
    return { mode: 'D', state: 'below', left, date: latestStart, since: startDate, end: windowEnd };
  }

  if (!below[below.length - 1]) return { mode: 'N', state: 'above', run: runFromEnd(false) };

  // 연속 미달 일수: 최근 경고 공시가 있으면 경고일 = 25일째로 정확히 센다
  let run = runFromEnd(true);
  let exact = false;
  const lastW = [...events].reverse().find(e => e.t === 'W');
  if (lastW && (!lastD || lastD.d < lastW.d)) {
    const after = series.length - idxAfter(lastW.d); // 경고일 다음 거래일부터 오늘까지
    const byWarn = 25 + after;
    if (after <= 10 && byWarn <= 30) { run = byWarn; exact = true; }
  }
  // 공식 공시와 맞지 않는 추정은 상한을 둔다 (증자 등으로 주식수가 바뀌면 과거 시총 추정이 틀어진다)
  // 코스닥은 25일째 경고, 30일째 지정 공시가 나와야 한다. 추정이 공시와 맞지 않으면 기한을 내지 않는다
  // (거래정지·리츠 등 예외이거나, 증자 등으로 주식수가 바뀌어 과거 시총 추정이 틀린 경우)
  if (!exact && ((m === 1 && run >= 25) || run >= 30)) return { mode: 'N', state: 'mismatch', run };
  const left = 30 - run;
  return { mode: 'N', state: 'below', run, left, date: addTradingDays(last, Math.max(0, left)), exact };
}
