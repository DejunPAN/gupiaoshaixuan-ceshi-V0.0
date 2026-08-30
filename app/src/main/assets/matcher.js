/**
 * 量形选股 - 形态匹配核心算法 + 数据层
 * 将 pattern_scanner.py 的规则 1:1 翻译为 JS, 纯函数 + 可测试。
 */

// ---------- 可调参数(默认值, UI 可改) ----------
const CFG = {
  DAYS: 40,            // 回看交易日数量
  SURGE_RATIO: 1.8,    // 爆量阈值: 当日量 / 前N日均量
  MA_WINDOW: 10,       // 爆量判定的均量窗口
  MIN_GAP: 3,          // 两次爆量之间至少间隔的交易日
  FALL_DAYS: 2,        // 二次爆量后至少连续下跌的天数
  SUSTAIN_RATIO: 1.5,  // 一日游判定: 爆量次日量/基线 低于此倍数则剔除
  TODAY_PEAK_RATIO: 0.8, // 今日量上限: 必须 < 二次爆量峰值 * 此比例
  MAX_PRICE: 70,       // 股价上限
  CONCURRENCY: 6,      // 拉K线并发数
};

// 板块白名单前缀
const PREFIXES = ['600', '601', '603', '605', '000', '001', '002', '003', '300', '301'];

// 最小数据日期(过滤退市/停牌股的陈旧数据)
const MIN_DATE = '2026-08-20';

// ============ 形态算法(纯函数) ============

function mean(a) {
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}

/** 找出所有爆量点: 返回 [{i, ratio}, ...] */
function findSurges(vols, cfg) {
  const { MA_WINDOW, SURGE_RATIO } = cfg;
  const surges = [];
  for (let i = MA_WINDOW; i < vols.length; i++) {
    const base = mean(vols.slice(i - MA_WINDOW, i));
    if (base <= 0) continue;
    const ratio = vols[i] / base;
    if (ratio >= SURGE_RATIO) {
      const isPeak = vols[i] >= vols[i - 1] &&
        (i + 1 >= vols.length || vols[i] >= vols[i + 1]);
      if (isPeak) surges.push({ i, ratio });
    }
  }
  return surges;
}

/** 判断爆量是否"一日游"(次日量回落到基线以下太多) */
function isOneDaySpike(vols, i, cfg) {
  const { MA_WINDOW, SUSTAIN_RATIO } = cfg;
  const n = vols.length;
  if (i + 1 >= n) return true; // 无次日数据可看, 视为不稳 -> 剔除
  const base = mean(vols.slice(Math.max(0, i - MA_WINDOW), i));
  if (base <= 0) return true;
  return (vols[i + 1] / base) < SUSTAIN_RATIO;
}

/**
 * 判定形态是否匹配。返回 { score, detail }。
 * detail 含 matched / p1 / p2 / v1 / v2 / ratio1 / ratio2 / fall_len /
 *        p1_sustain / p2_sustain / today_up / today_chg / today_below_peak / reasons
 */
function analyze(vols, cfg) {
  const n = vols.length;
  const detail = {
    matched: false, surge_count: 0,
    p1: null, p2: null, v1: null, v2: null,
    ratio1: null, ratio2: null, fall_len: 0,
    p1_sustain: true, p2_sustain: true,
    today_up: false, today_chg: null, today_below_peak: true,
    reasons: [],
  };

  const surges = findSurges(vols, cfg);
  detail.surge_count = surges.length;
  if (surges.length < 2) {
    detail.reasons.push(`爆量次数不足(${surges.length}次)`);
    return { score: 0, detail };
  }

  // 找一对 p1 < p2 且 v[p2] > v[p1], 间隔 >= MIN_GAP
  let best = null;
  for (let a = 0; a < surges.length; a++) {
    for (let b = a + 1; b < surges.length; b++) {
      const s1 = surges[a], s2 = surges[b];
      if (s2.i - s1.i < cfg.MIN_GAP) continue;
      if (vols[s2.i] <= vols[s1.i]) continue;
      const scorePair = s1.ratio + s2.ratio + (s2.i / n);
      if (best == null || scorePair > best.score) {
        best = { score: scorePair, i1: s1.i, r1: s1.ratio, i2: s2.i, r2: s2.ratio };
      }
    }
  }
  if (best == null) {
    detail.reasons.push('未找到"第二次比第一次更高"的爆量对');
    return { score: 0, detail };
  }

  const { i1, r1, i2, r2 } = best;
  detail.p1 = i1; detail.p2 = i2;
  detail.v1 = Math.round(vols[i1] * 10) / 10;
  detail.v2 = Math.round(vols[i2] * 10) / 10;
  detail.ratio1 = Math.round(r1 * 100) / 100;
  detail.ratio2 = Math.round(r2 * 100) / 100;

  // 非一日游
  const p1_spike = isOneDaySpike(vols, i1, cfg);
  const p2_spike = isOneDaySpike(vols, i2, cfg);
  detail.p1_sustain = !p1_spike;
  detail.p2_sustain = !p2_spike;
  if (p1_spike) detail.reasons.push('第一次爆量次日回落无量(一日游)');
  if (p2_spike) detail.reasons.push('第二次爆量次日回落无量(一日游)');

  // 连续下跌
  let fall_len = 0;
  let j = i2 + 1;
  while (j < n && vols[j] < vols[j - 1]) { fall_len++; j++; }
  detail.fall_len = fall_len;
  if (fall_len < cfg.FALL_DAYS) {
    detail.reasons.push(`二次爆量后连续下跌仅${fall_len}天(<${cfg.FALL_DAYS})`);
  }

  // 今日 > 昨日
  const today_up = vols[n - 1] > vols[n - 2];
  detail.today_up = today_up;
  detail.today_chg = vols[n - 2] > 0
    ? Math.round((vols[n - 1] / vols[n - 2] - 1) * 10000) / 100 : null;
  if (!today_up) detail.reasons.push('今天量能未高于昨天');

  // 今日量 < 二次爆量峰值 * 比例
  const today_below_peak = vols[n - 1] < vols[i2] * cfg.TODAY_PEAK_RATIO;
  detail.today_below_peak = today_below_peak;
  if (!today_below_peak) {
    const pct = vols[i2] > 0 ? Math.round(vols[n - 1] / vols[i2] * 1000) / 10 : 0;
    detail.reasons.push(`今日量能已达二次峰值${pct}%(需低于${Math.round(cfg.TODAY_PEAK_RATIO * 100)}%)`);
  }

  // 综合评分
  let score = 40;
  const excess = vols[i1] > 0 ? (vols[i2] / vols[i1] - 1) : 0;
  score += Math.min(20, excess * 40);
  score += Math.min(20, fall_len / Math.max(cfg.FALL_DAYS, 1) * 10);
  if (today_up && vols[n - 2] > 0) {
    score += Math.min(20, (vols[n - 1] / vols[n - 2] - 1) * 100);
  }
  score = Math.round(Math.min(100, score) * 10) / 10;

  detail.matched =
    surges.length >= 2 && best != null &&
    fall_len >= cfg.FALL_DAYS && today_up &&
    !p1_spike && !p2_spike && today_below_peak;

  return { score, detail };
}

// ============ 数据层(桥优先, 浏览器 fetch 兜底) ============

let callbackSeq = 0;

/** 检测是否有原生桥(App 环境) */
function hasBridge() {
  return typeof window.NativeData !== 'undefined';
}

/** 原生桥: 拉新浪 K 线(返回 [{day, open, high, low, close, volume}, ...] 或 null) */
function bridgeFetchSina(code, days) {
  return new Promise((resolve) => {
    const cb = '__volCb' + (++callbackSeq);
    const timer = setTimeout(() => { delete window[cb]; resolve(null); }, 20000);
    window[cb] = (raw) => {
      clearTimeout(timer);
      delete window[cb];
      if (raw == null || raw === 'null') { resolve(null); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { resolve(raw); }
    };
    window.NativeData.fetchSinaKline(code, days, cb);
  });
}

/** 原生桥: 拉腾讯批量行情(返回已解码文本字符串) */
function bridgeFetchQuotes(codesChunk) {
  return new Promise((resolve) => {
    const cb = '__volCb' + (++callbackSeq);
    const timer = setTimeout(() => { delete window[cb]; resolve(''); }, 20000);
    window[cb] = (txt) => {
      clearTimeout(timer);
      delete window[cb];
      resolve(txt == null ? '' : txt);
    };
    window.NativeData.fetchQuotes(codesChunk.join(','), cb);
  });
}

/** 解析腾讯行情返回文本 -> [{code, name, price}] */
function parseQuotes(text) {
  const stocks = [];
  if (!text) return stocks;
  const segs = text.split(';');
  for (const seg of segs) {
    const idx = seg.indexOf('="');
    if (idx < 0) continue;
    const payload = seg.slice(idx + 2, seg.length).replace(/"$/, '');
    if (!payload) continue;
    const parts = payload.split('~');
    if (parts.length < 4) continue;
    const name = parts[1];
    const code = parts[2];
    const price = parseFloat(parts[3]);
    if (!/^\d{6}$/.test(code) || isNaN(price)) continue;
    stocks.push({ code, name, price });
  }
  return stocks;
}

/** 构建全市场代码空间(板块白名单) */
function buildCodeSpace() {
  const codes = [];
  for (const p of PREFIXES) {
    for (let i = 0; i < 1000; i++) {
      codes.push(p + String(i).padStart(3, '0'));
    }
  }
  return codes;
}

/** 腾讯行情接口需要的带交易所前缀代码 */
function tdxSymbol(code) {
  return (code.startsWith('6') ? 'sh' : 'sz') + code;
}

/** 粗筛: 遍历代码空间拿全市场活跃股 + 过滤 ST/高价 */
async function coarseFilter(progressCb) {
  const codespace = buildCodeSpace();
  const all = [];
  const CHUNK = 60;
  let done = 0;
  for (let i = 0; i < codespace.length; i += CHUNK) {
    const chunk = codespace.slice(i, i + CHUNK);
    // 腾讯行情接口要求 sh600000 / sz000001 格式
    const symChunk = chunk.map(code => (code.startsWith('6') ? 'sh' : 'sz') + code);
    let text = '';
    if (hasBridge()) {
      text = await bridgeFetchQuotes(symChunk);
    } else {
      text = await browserFetchQuotes(symChunk);
    }
    const got = parseQuotes(text);
    all.push(...got);
    done += CHUNK;
    if (progressCb) progressCb(done, codespace.length, all.length);
    // 轻微限速, 避免风控
    await sleep(80);
  }
  // 过滤
  const filtered = [];
  for (const s of all) {
    if (s.name.toUpperCase().includes('ST')) continue;
    if (s.price > CFG.MAX_PRICE) continue;
    filtered.push(s);
  }
  return { all, filtered };
}

/** 浏览器兜底: 腾讯批量行情(支持 CORS), 无桥环境下粗筛仍可跑 */
async function browserFetchQuotes(chunk) {
  try {
    const url = 'https://qt.gtimg.cn/q=' + chunk.join(',');
    const resp = await fetch(url);
    const buf = await resp.arrayBuffer();
    return decodeGBK(buf);
  } catch (e) {
    return '';
  }
}

/** GBK 解码(浏览器兜底用, 腾讯行情是 GBK) */
function decodeGBK(buf) {
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch (e) {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/** 精筛: 对候选逐只拉 K 线并判定形态 */
async function fineScan(filtered, progressCb) {
  const codes = filtered.map(s => s.code);
  const results = [];
  let idx = 0;
  const queue = [...codes];

  async function worker() {
    while (queue.length > 0) {
      const code = queue.shift();
      const stock = filtered.find(x => x.code === code);
      const data = await fetchKline(code, CFG.DAYS);
      idx++;
      if (progressCb) progressCb(idx, codes.length);
      if (!data) continue;
      if (data.dates[data.dates.length - 1] < MIN_DATE) continue; // 过滤陈旧
      const { score, detail } = analyze(data.volumes, CFG);
      if (score > 0) {
        results.push({
          code, name: stock ? stock.name : code, price: stock ? stock.price : null,
          score, dates: data.dates, volumes: data.volumes, kline: data, ...detail,
        });
      }
      await sleep(30);
    }
  }

  const workers = [];
  const wc = Math.min(CFG.CONCURRENCY, Math.max(1, codes.length));
  for (let k = 0; k < wc; k++) workers.push(worker());
  await Promise.all(workers);

  results.sort((a, b) => (b.score - a.score) || ((b.ratio2 || 0) - (a.ratio2 || 0)));
  return results;
}

async function fetchKline(code, days) {
  let data = null;
  if (hasBridge()) {
    const raw = await bridgeFetchSina(code, days);
    if (Array.isArray(raw) && raw.length >= Math.min(days, 5)) {
      data = {
        dates: raw.map(k => k.day),
        opens: raw.map(k => parseFloat(k.open)),
        highs: raw.map(k => parseFloat(k.high)),
        lows: raw.map(k => parseFloat(k.low)),
        closes: raw.map(k => parseFloat(k.close)),
        volumes: raw.map(k => parseFloat(k.volume)),
      };
    }
  } else {
    // 浏览器兜底: 新浪无 CORS, 基本会失败; 提示用途
    data = null;
  }
  return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ 导出(通达信自选清单) ============

/** 生成通达信可导入文本: 每行一个股票代码(带 sh/sz 前缀), 可附名称 */
function exportTdxText(results, withName) {
  return results.map(r => {
    const sym = tdxSymbol(r.code);
    return withName ? `${sym}\t${r.name || ''}` : sym;
  }).join('\n');
}

/** 仅 6 位代码(通达信部分版本用裸代码) */
function exportCodesText(results) {
  return results.map(r => r.code).join('\n');
}

/** 复制或分享文本: 优先系统分享, 失败回退剪贴板 */
async function shareOrCopy(text) {
  if (navigator.share) {
    try {
      await navigator.share({ title: '量形选股结果', text });
      return 'shared';
    } catch (e) { /* 用户取消或不可用, 继续走复制 */ }
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return 'copied';
    }
  } catch (e) { /* ignore */ }
  return 'fail';
}

// 暴露给调试/测试
if (typeof window !== 'undefined') {
  window.VolMatcher = {
    CFG, analyze, findSurges, parseQuotes, coarseFilter, fineScan, buildCodeSpace,
    tdxSymbol, exportTdxText, exportCodesText, shareOrCopy,
  };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CFG, analyze, findSurges, parseQuotes, buildCodeSpace, tdxSymbol };
}
