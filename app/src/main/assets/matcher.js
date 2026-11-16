/**
 * 换手突破选股 - 筛选核心算法 + 数据层
 * 选股规则:
 *   1. 换手率 > 阈值(默认 5%)
 *   2. 当日最低价 > 前 2 个交易日的最低价
 *   3. 当日最高价 > 前 2 个交易日的最高价
 *   4. 排除北交所 / 科创板(代码白名单只保留沪深主板 + 创业板)
 */

// ---------- 可调参数(默认值, UI 可改) ----------
const CFG = {
  DAYS: 10,            // 拉取 K 线交易日数量(至少 3 日用于判定高低价突破)
  TURNOVER_MIN: 5,     // 换手率下限(%)
  MIN_FRESH_DAYS: 60,  // K 线最后一根距今天数超过此值视为陈旧数据
  CONCURRENCY: 6,      // 拉 K 线并发数
};

// 板块白名单前缀: 沪深主板 + 创业板; 不包含北交所(43/83/87/92 等), 也不包含科创板(688/689)
const PREFIXES = ['600', '601', '603', '605', '000', '001', '002', '003', '300', '301', '302'];

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// K 线数据新鲜度下限(过滤长期停牌/退市股的陈旧数据; 不属于选股规则本身)
const MIN_DATE = (() => {
  const d = new Date();
  d.setDate(d.getDate() - CFG.MIN_FRESH_DAYS);
  return localDateStr(d);
})();

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ============ 纯函数: 判定算法 ============

/** 解析腾讯批量行情文本 -> [{code,name,price,high,low,turnover}, ...] */
function parseQuotes(text) {
  const stocks = [];
  if (!text) return stocks;
  const segs = text.split(';');
  for (const seg of segs) {
    const idx = seg.indexOf('="');
    if (idx < 0) continue;
    const payload = seg.slice(idx + 2).replace(/"$/, '');
    if (!payload) continue;
    const parts = payload.split('~');
    if (parts.length < 39) continue;
    const name = parts[1];
    const code = parts[2];
    const price = parseFloat(parts[3]);
    const high = parseFloat(parts[33]);
    const low = parseFloat(parts[34]);
    const turnover = parseFloat(parts[38]); // 腾讯行情第 38 位: 换手率(%)
    if (!/^\d{6}$/.test(code) || !isAllowedBoard(code)) continue;
    if (!isFinite(price) || price <= 0) continue;
    stocks.push({
      code,
      name,
      price,
      high: isFinite(high) ? high : null,
      low: isFinite(low) ? low : null,
      turnover: isFinite(turnover) ? turnover : null,
    });
  }
  return stocks;
}

/** 是否属于允许扫描的板块(沪深主板 + 创业板); 自动排除北交所/科创板 */
function isAllowedBoard(code) {
  return PREFIXES.some(p => code.startsWith(p));
}

/**
 * 换手突破判定。
 * 返回 { score, detail }，detail.matched 为是否命中全部规则。
 */
function analyzeTurnoverBreakout(stock, k, cfg) {
  const detail = {
    matched: false,
    turnover: stock ? stock.turnover : null,
    today_high: null,
    today_low: null,
    prev_high: null,
    prev_low: null,
    high_break: false,
    low_break: false,
    reasons: [],
  };

  if (!k || !k.dates || k.dates.length < 3) {
    detail.reasons.push('K线数据不足(需最近3个交易日)');
    return { score: 0, detail };
  }

  if (k.dates[k.dates.length - 1] < MIN_DATE) {
    detail.reasons.push('K线数据过旧');
    return { score: 0, detail };
  }

  const n = k.dates.length;
  const todayHigh = parseFloat(k.highs[n - 1]);
  const todayLow = parseFloat(k.lows[n - 1]);
  const prevHighMax = Math.max(parseFloat(k.highs[n - 2]), parseFloat(k.highs[n - 3]));
  const prevLowMax = Math.max(parseFloat(k.lows[n - 2]), parseFloat(k.lows[n - 3]));

  if (![todayHigh, todayLow, prevHighMax, prevLowMax].every(v => isFinite(v) && v > 0)) {
    detail.reasons.push('K线高低价无效');
    return { score: 0, detail };
  }

  const turnover = stock ? parseFloat(stock.turnover) : NaN;
  detail.turnover = isFinite(turnover) ? turnover : null;
  detail.today_high = round2(todayHigh);
  detail.today_low = round2(todayLow);
  detail.prev_high = round2(prevHighMax);
  detail.prev_low = round2(prevLowMax);

  if (!isFinite(turnover) || turnover <= (cfg && cfg.TURNOVER_MIN != null ? cfg.TURNOVER_MIN : CFG.TURNOVER_MIN)) {
    detail.reasons.push('换手率未高于阈值');
    return { score: 0, detail };
  }

  const highBreak = todayHigh > prevHighMax;
  const lowBreak = todayLow > prevLowMax;
  detail.high_break = highBreak;
  detail.low_break = lowBreak;
  if (!highBreak) detail.reasons.push('当日最高价未高于前2日最高价');
  if (!lowBreak) detail.reasons.push('当日最低价未高于前2日最低价');

  detail.matched = highBreak && lowBreak;

  // 排序分: 换手率占 60 分(15% 及以上封顶), 高低价突破幅度占 40 分
  let score = 0;
  if (detail.matched) {
    score += Math.min(60, turnover * 4);
    const highPct = prevHighMax > 0 ? (todayHigh / prevHighMax - 1) * 100 : 0;
    const lowPct = prevLowMax > 0 ? (todayLow / prevLowMax - 1) * 100 : 0;
    score += Math.min(40, Math.max(0, highPct + lowPct) * 4);
    score = Math.min(100, Math.round(score));
  }
  return { score, detail };
}

// ============ 数据层(桥优先, 浏览器 fetch 兜底) ============

let callbackSeq = 0;

/** 检测是否有原生桥(App 环境) */
function hasBridge() {
  return typeof window !== 'undefined' && typeof window.NativeData !== 'undefined';
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

/** 粗筛: 遍历代码空间, 拿全市场活跃股, 保留换手率 > 阈值的候选 */
async function coarseFilter(progressCb) {
  const codespace = buildCodeSpace();
  const all = [];
  const CHUNK = 60;
  let done = 0;
  for (let i = 0; i < codespace.length; i += CHUNK) {
    const chunk = codespace.slice(i, i + CHUNK);
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
    await sleep(80);
  }
  const filtered = all.filter(s => s.turnover != null && s.turnover > CFG.TURNOVER_MIN);
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

/** 精筛: 对换手率候选逐只拉 K 线, 判定当日最高/最低价是否同时突破前 2 日 */
async function fineScan(filtered, progressCb) {
  const codes = filtered.map(s => s.code);
  const stockMap = new Map(filtered.map(s => [s.code, s]));
  const results = [];
  let idx = 0;
  const queue = [...codes];

  async function worker() {
    while (queue.length > 0) {
      const code = queue.shift();
      const stock = stockMap.get(code);
      const data = await fetchKline(code, CFG.DAYS);
      idx++;
      if (progressCb) progressCb(idx, codes.length);
      if (!data) continue;
      const { score, detail } = analyzeTurnoverBreakout(stock, data, CFG);
      if (detail.matched) {
        results.push({
          code,
          name: stock ? stock.name : code,
          price: stock ? stock.price : null,
          turnover: stock ? stock.turnover : null,
          score,
          dates: data.dates,
          kline: data,
          ...detail,
        });
      }
      await sleep(30);
    }
  }

  const workers = [];
  const wc = Math.min(CFG.CONCURRENCY, Math.max(1, codes.length));
  for (let k = 0; k < wc; k++) workers.push(worker());
  await Promise.all(workers);

  results.sort((a, b) => (b.score - a.score) || ((b.turnover || 0) - (a.turnover || 0)));
  return results;
}

async function fetchKline(code, days) {
  let data = null;
  if (hasBridge()) {
    const raw = await bridgeFetchSina(code, days);
    if (Array.isArray(raw) && raw.length >= 3) {
      data = {
        dates: raw.map(k => k.day),
        opens: raw.map(k => parseFloat(k.open)),
        highs: raw.map(k => parseFloat(k.high)),
        lows: raw.map(k => parseFloat(k.low)),
        closes: raw.map(k => parseFloat(k.close)),
        volumes: raw.map(k => parseFloat(k.volume)),
      };
    }
  }
  // 浏览器兜底: 新浪 K 线无 CORS, 基本会失败; 无桥环境下只能跑粗筛
  return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ 导出(通达信自选清单) ============

/** 生成通达信可导入文本: 每行一个股票代码(带 sh/sz 前缀), 可附名称 */
function exportTdxText(results, withName) {
  return results.map(r => {
    const sym = tdxSymbol(r.code);
    return withName ? sym + '\t' + (r.name || '') : sym;
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
      await navigator.share({ title: '换手突破选股结果', text });
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

// 暴露给 H5 / 调试 / 测试
if (typeof window !== 'undefined') {
  window.VolMatcher = {
    CFG,
    analyze: analyzeTurnoverBreakout,
    analyzeTurnoverBreakout,
    parseQuotes,
    isAllowedBoard,
    coarseFilter,
    fineScan,
    buildCodeSpace,
    tdxSymbol,
    exportTdxText,
    exportCodesText,
    shareOrCopy,
  };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CFG,
    analyze: analyzeTurnoverBreakout,
    analyzeTurnoverBreakout,
    parseQuotes,
    isAllowedBoard,
    coarseFilter,
    fineScan,
    buildCodeSpace,
    tdxSymbol,
    exportTdxText,
    exportCodesText,
  };
}
