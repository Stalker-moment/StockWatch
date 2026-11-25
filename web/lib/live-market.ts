import catalogData from "../../data/idx-catalog.json";
import indexSnapshotData from "../../data/ihsg.json";
import savedQuotesData from "../public/market/quotes.json";
import {
  IHSG_CODE,
  IHSG_NAME,
  IHSG_SYMBOL,
  finiteNumber,
  parseStockbitHtml,
  positiveNumber,
  type LiveQuote,
} from "./stockbit-parser";

export class MarketError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ChartPeriodSpec = {
  range: string;
  label: string;
  interval: string;
  secondsPerBar: number;
};

export const CHART_PERIODS: readonly ChartPeriodSpec[] = [
  { range: "1d", label: "1D", interval: "1m", secondsPerBar: 60 },
  { range: "5d", label: "5D", interval: "15m", secondsPerBar: 900 },
  { range: "1mo", label: "1M", interval: "1d", secondsPerBar: 86400 },
  { range: "3mo", label: "3M", interval: "1d", secondsPerBar: 86400 },
  { range: "6mo", label: "6M", interval: "1d", secondsPerBar: 86400 },
  { range: "ytd", label: "YTD", interval: "1d", secondsPerBar: 86400 },
  { range: "1y", label: "1Y", interval: "1d", secondsPerBar: 86400 },
  { range: "5y", label: "5Y", interval: "1wk", secondsPerBar: 7 * 86400 },
];

export type DirectoryRow = {
  code: string;
  name: string;
  sector: string;
  price: number | null;
  previous: number | null;
  changePercent: number | null;
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  value: number | null;
  cap: number | null;
  per: number | null;
  pbr: number | null;
  frequency: number | null;
};

export type DirectoryPayload = {
  source: string;
  date: string;
  fetchedAt: number;
  offline: boolean;
  stale: boolean;
  stocks: DirectoryRow[];
};

export type HistoryBar = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
};

export type IntradayAverage = {
  date: string;
  average: number;
  through: number;
};

export type HistoryPayload = {
  code: string;
  range: string;
  interval: string;
  source: string;
  bars: HistoryBar[];
  session?: HistoryBar | null;
  intraday?: IntradayAverage | null;
  price: number | null;
  marketTime: number | null;
  changePercent: number | null;
  snapshot?: boolean;
  demo?: boolean;
};

export type TradeRow = {
  time: string;
  price: number;
  shares: number;
  side: "BUY" | "SELL" | "--";
  board: string;
  buyer: string;
  seller: string;
};

export type TradesPayload = {
  code: string;
  date: string;
  source: string;
  fetchedAt: number;
  trades: TradeRow[];
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 StockWatch/1.0";

const wibDateFormat = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Jakarta",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function wibDate(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return "";
  return wibDateFormat.format(unixSeconds * 1000);
}

export function stockCode(value: string): string {
  let code = value.trim().toUpperCase();
  if (code.length > 3 && code.endsWith(".JK")) code = code.slice(0, -3);
  if (!/^[A-Z]{4}$/.test(code)) {
    throw new MarketError(400, "Kode saham IDX harus berisi 4 huruf, misalnya BBCA");
  }
  return code;
}

export function instrumentCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (code === IHSG_CODE || code === IHSG_SYMBOL || code === "JKSE" || code === "COMPOSITE") {
    return IHSG_CODE;
  }
  return stockCode(code);
}

type CacheEntry<T> = { value: T; fetchedAt: number };

// Persist caches across Next.js dev HMR reloads.
const globalState = globalThis as unknown as {
  __stockwatchMarketState?: {
    directory: DirectoryPayload | null;
    nextDirectoryFetch: number;
    directoryInFlight: Promise<DirectoryPayload> | null;
    quotes: Map<string, CacheEntry<LiveQuote>>;
    quoteInFlight: Map<string, Promise<LiveQuote>>;
    stockbitBackoffUntil: number;
    stockbitNextSlot: number;
    histories: Map<string, CacheEntry<HistoryPayload>>;
    historyInFlight: Map<string, Promise<HistoryPayload>>;
    sessionStats: Map<string, CacheEntry<{ date: string; ohlc: HistoryBar | null; intraday: IntradayAverage | null }>>;
    tradePages: Map<string, CacheEntry<TradesPayload>>;
    retryTradesUntil: number;
    tradesStatus: number;
    tradesError: string;
    savedIndex: { quote: LiveQuote; history: Record<string, HistoryPayload> } | null;
  };
};

const state = (globalState.__stockwatchMarketState ??= {
  directory: null,
  nextDirectoryFetch: 0,
  directoryInFlight: null,
  quotes: new Map(),
  quoteInFlight: new Map(),
  stockbitBackoffUntil: 0,
  stockbitNextSlot: 0,
  histories: new Map(),
  historyInFlight: new Map(),
  sessionStats: new Map(),
  tradePages: new Map(),
  retryTradesUntil: 0,
  tradesStatus: 502,
  tradesError: "",
  savedIndex: null,
});

function trimMap<K, V>(map: Map<K, V>, max: number) {
  if (map.size <= max) return;
  const first = map.keys().next().value;
  if (first !== undefined) map.delete(first);
}

async function loadSavedIndex(): Promise<{ quote: LiveQuote; history: Record<string, HistoryPayload> }> {
  if (state.savedIndex) return state.savedIndex;
  const parsed = indexSnapshotData as unknown as {
    quote: LiveQuote;
    history: Record<string, HistoryPayload>;
  };
  state.savedIndex = parsed;
  return parsed;
}

async function loadFallbackDirectory(): Promise<DirectoryPayload> {
  const saved = savedQuotesData as {
    source?: string;
    date?: string;
    fetchedAt?: number;
    quotes?: Array<Record<string, unknown>>;
  };
  if (Array.isArray(saved.quotes) && saved.quotes.length >= 500) {
    return {
      source: saved.source || "Pasardana",
      date: saved.date || "",
      fetchedAt: saved.fetchedAt || Math.floor(Date.now() / 1000),
      offline: false,
      stale: true,
      stocks: saved.quotes.map((item) => ({
        code: String(item.code ?? ""),
        name: String(item.name ?? item.code ?? ""),
        sector: String(item.sector ?? ""),
        price: positiveNumber(item.price),
        previous: positiveNumber(item.previous),
        changePercent: finiteNumber(item.change),
        date: String(item.date ?? ""),
        open: positiveNumber(item.open),
        high: positiveNumber(item.high),
        low: positiveNumber(item.low),
        volume: finiteNumber(item.volume),
        value: finiteNumber(item.value),
        cap: positiveNumber(item.cap),
        per: finiteNumber(item.per),
        pbr: finiteNumber(item.pbr),
        frequency: finiteNumber(item.frequency),
      })),
    };
  }

  const catalog = catalogData as {
    source?: string;
    date?: string;
    stocks: Array<{ code: string; name: string; sector?: string }>;
  };
  return {
    source: catalog.source || "Katalog IDX",
    date: catalog.date || "",
    fetchedAt: Math.floor(Date.now() / 1000),
    offline: true,
    stale: true,
    stocks: catalog.stocks.map((item) => ({
      code: item.code,
      name: item.name,
      sector: item.sector ?? "",
      price: null,
      previous: null,
      changePercent: null,
      date: "",
      open: null,
      high: null,
      low: null,
      volume: null,
      value: null,
      cap: null,
      per: null,
      pbr: null,
      frequency: null,
    })),
  };
}

async function fetchPasardanaDirectory(): Promise<DirectoryPayload> {
  const response = await fetch(
    "https://pasardana.id/api/StockSearchResult/GetAll?pageBegin=1&pageLength=1500&sortField=Code&sortOrder=ASC",
    {
      signal: AbortSignal.timeout(9000),
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      cache: "no-store",
    },
  );
  if (!response.ok) throw new Error("Pasardana HTTP " + response.status);
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new Error("Format direktori saham berubah");

  const byCode = new Map<string, DirectoryRow>();
  let latest = "";
  for (const raw of payload) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const rawCode = typeof item.Code === "string" ? item.Code.trim().toUpperCase() : "";
    if (!/^[A-Z]{4}$/.test(rawCode)) continue;

    const date = typeof item.LastDate === "string" ? item.LastDate.slice(0, 10) : "";
    const name = typeof item.Name === "string" && item.Name ? item.Name : rawCode;
    const sector = typeof item.NewSectorName === "string" ? item.NewSectorName : "";
    const price = positiveNumber(item.Last);
    const previous = positiveNumber(item.PrevClosingPrice);
    let changePercent: number | null = null;
    if (price !== null && previous !== null) {
      changePercent = (price / previous - 1) * 100;
    } else if (price !== null) {
      const oneDay = finiteNumber(item.OneDay);
      if (oneDay !== null) changePercent = oneDay * 100;
    }
    if (price !== null && date > latest) latest = date;

    byCode.set(rawCode, {
      code: rawCode,
      name,
      sector,
      price,
      previous,
      changePercent,
      date,
      open: positiveNumber(item.AdjustedOpenPrice),
      high: positiveNumber(item.AdjustedHighPrice),
      low: positiveNumber(item.AdjustedLowPrice),
      volume: finiteNumber(item.Volume),
      value: finiteNumber(item.Value),
      cap: positiveNumber(item.Capitalization),
      per: finiteNumber(item.Per),
      pbr: finiteNumber(item.Pbr),
      frequency: finiteNumber(item.Frequency),
    });
  }

  if (byCode.size < 500 || !latest) throw new Error("Direktori saham tidak lengkap");
  const stocks = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
  return {
    source: "Pasardana",
    date: latest,
    fetchedAt: Math.floor(Date.now() / 1000),
    offline: false,
    stale: false,
    stocks,
  };
}

export async function getDirectory(): Promise<DirectoryPayload> {
  const now = Date.now();
  if (state.directory && now < state.nextDirectoryFetch) return state.directory;
  if (state.directoryInFlight) return state.directoryInFlight;

  const task = (async () => {
    try {
      const fresh = await fetchPasardanaDirectory();
      state.directory = fresh;
      state.nextDirectoryFetch = Date.now() + 60_000;
      return fresh;
    } catch {
      if (!state.directory) {
        state.directory = await loadFallbackDirectory();
      } else {
        state.directory = { ...state.directory, stale: true };
      }
      state.nextDirectoryFetch = Date.now() + 45_000;
      return state.directory;
    } finally {
      state.directoryInFlight = null;
    }
  })();

  state.directoryInFlight = task;
  return task;
}

type YahooChartResult = {
  meta: Record<string, unknown>;
  timestamp?: unknown[];
  indicators?: {
    quote?: Array<{
      open?: unknown[];
      high?: unknown[];
      low?: unknown[];
      close?: unknown[];
      volume?: unknown[];
    }>;
  };
};

async function yahooChart(
  symbol: string,
  range: string,
  interval = "1d",
  tryMirror = true,
): Promise<YahooChartResult> {
  const mirrors = tryMirror
    ? ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]
    : ["query1.finance.yahoo.com"];
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  let notFound = 0;

  for (const host of mirrors) {
    try {
      const response = await fetch(`https://${host}${path}`, {
        signal: AbortSignal.timeout(7000),
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        cache: "no-store",
      });
      if (response.status === 404) {
        notFound++;
        continue;
      }
      if (!response.ok) continue;
      const payload = (await response.json()) as { chart?: { result?: YahooChartResult[] } };
      const chart = payload?.chart?.result?.[0];
      const meta = chart?.meta;
      if (meta && meta.symbol === symbol && (meta.currency === "IDR" || symbol === IHSG_SYMBOL)) {
        return chart;
      }
    } catch {
      // Coba mirror berikutnya.
    }
  }

  if (notFound === mirrors.length) {
    throw new MarketError(404, "Kode saham tidak ditemukan oleh penyedia");
  }
  throw new MarketError(502, "Yahoo Finance belum menyediakan data saat ini");
}

function chartBars(chart: YahooChartResult, secondsPerBar: number): HistoryBar[] {
  const times = chart.timestamp;
  const series = chart.indicators?.quote?.[0];
  if (!Array.isArray(times) || !series) return [];
  const opens = series.open ?? [];
  const highs = series.high ?? [];
  const lows = series.low ?? [];
  const closes = series.close ?? [];
  const volumes = series.volume ?? [];
  const count = Math.min(times.length, opens.length, highs.length, lows.length, closes.length, volumes.length);
  const marketTime = finiteNumber(chart.meta?.regularMarketTime) ?? 0;
  const intraday = secondsPerBar < 86400;

  const bars: HistoryBar[] = [];
  let last = 0;
  for (let i = 0; i < count; i++) {
    const t = times[i];
    const o = finiteNumber(opens[i]);
    const h = finiteNumber(highs[i]);
    const l = finiteNumber(lows[i]);
    const c = finiteNumber(closes[i]);
    if (typeof t !== "number" || !Number.isInteger(t) || o === null || h === null || l === null || c === null) {
      continue;
    }
    const weeklyTail = secondsPerBar > 86400 && t === marketTime && last > 0 && t - last < 5 * 86400;
    if (t <= last || weeklyTail || (intraday && t % secondsPerBar !== 0)) continue;
    if (l <= 0 || o < l || o > h || c < l || c > h) continue;
    const v = finiteNumber(volumes[i]);
    bars.push({ t, o, h, l, c, v });
    last = t;
  }
  return bars;
}

async function fetchStockbitQuote(code: string): Promise<LiveQuote | null> {
  const now = Date.now();
  if (now < state.stockbitBackoffUntil) return null;

  const slot = Math.max(now, state.stockbitNextSlot);
  const waitMs = slot - now;
  if (waitMs > 3000) return null;
  state.stockbitNextSlot = slot + 500;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (Date.now() < state.stockbitBackoffUntil) return null;
  }

  try {
    const response = await fetch(`https://stockbit.com/symbol/${encodeURIComponent(code)}`, {
      signal: AbortSignal.timeout(7000),
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      cache: "no-store",
    });
    if (response.status === 403 || response.status === 429) {
      state.stockbitBackoffUntil = Date.now() + 90_000;
      return null;
    }
    if (!response.ok) return null;
    const html = await response.text();
    return parseStockbitHtml(html, code);
  } catch {
    return null;
  }
}

async function fetchYahooQuote(code: string): Promise<LiveQuote> {
  const isIndex = code === IHSG_CODE;
  const symbol = isIndex ? IHSG_SYMBOL : code + ".JK";
  const chart = await yahooChart(symbol, "1d", "1d");
  const meta = chart.meta;
  const price = positiveNumber(meta.regularMarketPrice);
  if (price === null) throw new MarketError(502, "Harga tidak tersedia dari penyedia saat ini");

  const previous = positiveNumber(meta.previousClose) ?? positiveNumber(meta.chartPreviousClose);
  const marketTime = positiveNumber(meta.regularMarketTime);
  const date = marketTime ? wibDate(marketTime) : "";
  const rawName =
    (typeof meta.longName === "string" && meta.longName) ||
    (typeof meta.shortName === "string" && meta.shortName) ||
    code;

  const quote: LiveQuote = {
    code,
    symbol,
    name: isIndex ? IHSG_NAME : rawName,
    ...(isIndex ? { kind: "index" as const } : {}),
    currency: "IDR",
    price,
    previous,
    change: previous !== null ? price - previous : null,
    changePercent: previous !== null ? (price / previous - 1) * 100 : null,
    volume: isIndex ? null : finiteNumber(meta.regularMarketVolume),
    marketTime,
    date,
    source: "Yahoo Finance",
    demo: false,
  };

  if (date) {
    const times = chart.timestamp;
    const day = chart.indicators?.quote?.[0];
    if (
      Array.isArray(times) &&
      times.length > 0 &&
      typeof times[times.length - 1] === "number" &&
      wibDate(times[times.length - 1] as number) === date &&
      day
    ) {
      for (const key of ["open", "high", "low"] as const) {
        const arr = day[key];
        if (Array.isArray(arr) && arr.length === times.length) {
          const val = positiveNumber(arr[arr.length - 1]);
          if (val !== null) quote[key] = val;
        }
      }
    }
    const dayHigh = positiveNumber(meta.regularMarketDayHigh);
    const dayLow = positiveNumber(meta.regularMarketDayLow);
    if (dayHigh !== null) quote.high = dayHigh;
    if (dayLow !== null) quote.low = dayLow;
  }

  return quote;
}

export async function getQuote(symbol: string): Promise<LiveQuote> {
  const code = instrumentCode(symbol);
  const isIndex = code === IHSG_CODE;

  const cached = state.quotes.get(code);
  if (cached) {
    const ttl = cached.value.source === "Stockbit" ? 6_000 : 12_000;
    if (Date.now() - cached.fetchedAt < ttl) return cached.value;
  }

  const pending = state.quoteInFlight.get(code);
  if (pending) return pending;

  const task = (async () => {
    try {
      let result: LiveQuote | null = await fetchStockbitQuote(code);
      if (!result) {
        try {
          result = await fetchYahooQuote(code);
        } catch (err) {
          if (isIndex) {
            const saved = await loadSavedIndex();
            return {
              ...saved.quote,
              source: (saved.quote.source || "Yahoo Finance") + " (snapshot)",
              snapshot: true,
              demo: false,
            };
          } else {
            const directory = await getDirectory();
            const row = directory.stocks.find((item) => item.code === code && item.price !== null);
            if (row && row.price !== null) {
              result = {
                code: row.code,
                symbol: row.code + ".JK",
                name: row.name,
                currency: "IDR",
                price: row.price,
                previous: row.previous,
                change: row.previous !== null ? row.price - row.previous : null,
                changePercent: row.changePercent,
                open: row.open,
                high: row.high,
                low: row.low,
                volume: row.volume,
                value: row.value,
                marketTime: null,
                date: row.date,
                source: directory.source || "Pasardana",
                demo: false,
              };
            }
            if (!result) throw err;
          }
        }
      }

      const stamped: LiveQuote = { ...result, fetchedAt: Math.floor(Date.now() / 1000) };
      trimMap(state.quotes, 128);
      state.quotes.set(code, { value: stamped, fetchedAt: Date.now() });
      return stamped;
    } finally {
      state.quoteInFlight.delete(code);
    }
  })();

  state.quoteInFlight.set(code, task);
  return task;
}

async function optionalBars(code: string, interval: "1m" | "1d"): Promise<HistoryBar[]> {
  try {
    const symbol = code === IHSG_CODE ? IHSG_SYMBOL : code + ".JK";
    const source = await yahooChart(symbol, "1d", interval, false);
    return chartBars(source, interval === "1m" ? 60 : 86400);
  } catch {
    return [];
  }
}

function intradayAverage(minutes: HistoryBar[], date: string): IntradayAverage | null {
  let volume = 0;
  let weighted = 0;
  let through = 0;
  for (const bar of minutes) {
    const shares = bar.v ?? 0;
    if (shares <= 0 || wibDate(bar.t) !== date) continue;
    volume += shares;
    weighted += ((bar.h + bar.l + bar.c) / 3) * shares;
    through = bar.t;
  }
  if (volume > 0 && Number.isFinite(weighted)) {
    return { date, average: weighted / volume, through };
  }
  return null;
}

async function historySession(
  code: string,
  period: ChartPeriodSpec,
  bars: HistoryBar[],
  date: string,
): Promise<{ date: string; ohlc: HistoryBar | null; intraday: IntradayAverage | null }> {
  const session: { date: string; ohlc: HistoryBar | null; intraday: IntradayAverage | null } = {
    date,
    ohlc: null,
    intraday: null,
  };
  if (!date) return session;

  if (period.interval === "1d") {
    const last = bars[bars.length - 1];
    if (last && wibDate(last.t) === date) session.ohlc = last;
    session.intraday = intradayAverage(await optionalBars(code, "1m"), date);
  } else if (period.interval === "1m") {
    const daily = await optionalBars(code, "1d");
    const last = daily[daily.length - 1];
    if (last && wibDate(last.t) === date) session.ohlc = last;
    session.intraday = intradayAverage(bars, date);
  } else {
    const [daily, minutes] = await Promise.all([optionalBars(code, "1d"), optionalBars(code, "1m")]);
    const last = daily[daily.length - 1];
    if (last && wibDate(last.t) === date) session.ohlc = last;
    session.intraday = intradayAverage(minutes, date);
  }
  return session;
}

export async function getHistory(symbol: string, range: string): Promise<HistoryPayload> {
  const code = instrumentCode(symbol);
  const isIndex = code === IHSG_CODE;
  const period = CHART_PERIODS.find((item) => item.range === range);
  if (!period) {
    throw new MarketError(400, "Rentang tersedia: 1d, 5d, 1mo, 3mo, 6mo, ytd, 1y, 5y");
  }

  const key = code + ":" + range;
  const cached = state.histories.get(key);
  if (cached && Date.now() - cached.fetchedAt < 60_000) return cached.value;

  const pending = state.historyInFlight.get(key);
  if (pending) return pending;

  const task = (async () => {
    try {
      let chart: YahooChartResult;
      let bars: HistoryBar[];
      try {
        chart = await yahooChart(isIndex ? IHSG_SYMBOL : code + ".JK", period.range, period.interval);
        bars = chartBars(chart, period.secondsPerBar);
        if (!bars.length) throw new MarketError(502, "Belum ada candle untuk periode ini");
      } catch (err) {
        if (isIndex) {
          const saved = await loadSavedIndex();
          const fallback = saved.history[range];
          if (fallback) {
            return {
              ...fallback,
              source: (fallback.source || "Yahoo Finance") + " (snapshot)",
              snapshot: true,
              demo: false,
            };
          }
        }
        throw err;
      }

      const meta = chart.meta;
      const price = positiveNumber(meta.regularMarketPrice);
      const marketTime = positiveNumber(meta.regularMarketTime);
      const date = marketTime ? wibDate(marketTime) : "";

      let session: { ohlc: HistoryBar | null; intraday: IntradayAverage | null } = {
        ohlc: null,
        intraday: null,
      };
      if (date) {
        const stored = state.sessionStats.get(code);
        if (stored && stored.value.date === date && Date.now() - stored.fetchedAt < 60_000) {
          session = stored.value;
        } else if (isIndex) {
          let ohlc: HistoryBar | null = null;
          if (period.interval === "1d") {
            const last = bars[bars.length - 1];
            if (last && wibDate(last.t) === date) ohlc = last;
          } else {
            const daily = await optionalBars(code, "1d");
            const last = daily[daily.length - 1];
            if (last && wibDate(last.t) === date) ohlc = last;
          }
          const computed = { date, ohlc, intraday: null };
          trimMap(state.sessionStats, 128);
          state.sessionStats.set(code, { value: computed, fetchedAt: Date.now() });
          session = computed;
        } else {
          const computed = await historySession(code, period, bars, date);
          trimMap(state.sessionStats, 128);
          state.sessionStats.set(code, { value: computed, fetchedAt: Date.now() });
          session = computed;
        }
      }

      const result: HistoryPayload = {
        code,
        range: period.range,
        interval: period.interval,
        source: "Yahoo Finance",
        bars,
        session: session.ohlc,
        intraday: session.intraday,
        price,
        marketTime,
        changePercent: finiteNumber(meta.regularMarketChangePercent),
      };
      trimMap(state.histories, 200);
      state.histories.set(key, { value: result, fetchedAt: Date.now() });
      return result;
    } finally {
      state.historyInFlight.delete(key);
    }
  })();

  state.historyInFlight.set(key, task);
  return task;
}

function validTradeTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value);
}

export async function getTrades(symbol: string): Promise<TradesPayload> {
  const code = instrumentCode(symbol);
  if (code === IHSG_CODE) throw new MarketError(400, "Running Trade tersedia untuk saham");

  const token = (process.env.INVEZGO_API_KEY ?? "").trim();
  if (!token) throw new MarketError(503, "Running Trade perlu INVEZGO_API_KEY");
  if (token.length > 512 || /[\x00-\x20\x7f]/.test(token)) {
    throw new MarketError(503, "Format INVEZGO_API_KEY tidak valid");
  }

  const date = wibDate(Math.floor(Date.now() / 1000));
  const key = code + ":" + date;
  const now = Date.now();
  const cached = state.tradePages.get(key);
  if (cached && now - cached.fetchedAt < 10_000) return cached.value;
  if (now < state.retryTradesUntil) throw new MarketError(state.tradesStatus, state.tradesError);

  let response: Response;
  try {
    response = await fetch(
      `https://api.invezgo.com/analysis/running-trade/${encodeURIComponent(code)}?date=${date}&limit=100&sort=DESC`,
      {
        signal: AbortSignal.timeout(7000),
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      },
    );
  } catch {
    throw new MarketError(502, "Invezgo tidak dapat dihubungi");
  }

  if (!response.ok) {
    if (response.status === 401) state.tradesError = "API key Invezgo ditolak";
    else if (response.status === 402 || response.status === 403) {
      state.tradesError = "Akses atau kuota Running Trade Invezgo belum tersedia";
    } else if (response.status === 429) {
      state.tradesError = "Batas permintaan Invezgo tercapai";
    } else {
      throw new MarketError(502, "Data Running Trade belum tersedia dari Invezgo");
    }
    state.tradesStatus = response.status;
    const retryAfter = Number(response.headers.get("retry-after") ?? "0");
    const waitSeconds = response.status === 429 ? Math.max(60, Number.isFinite(retryAfter) ? retryAfter : 60) : 60;
    state.retryTradesUntil = Date.now() + waitSeconds * 1000;
    throw new MarketError(state.tradesStatus, state.tradesError);
  }

  try {
    const payload = (await response.json()) as { data?: unknown };
    if (!Array.isArray(payload.data)) throw new Error("Format transaksi berubah");
    const trades: TradeRow[] = [];
    for (const raw of payload.data) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const time = typeof item.time === "string" ? item.time : "";
      const price = positiveNumber(item.price);
      const shares = positiveNumber(item.volume);
      if (!validTradeTime(time) || price === null || shares === null) continue;
      const side = item.type === "BUY" || item.type === "SELL" ? item.type : "--";
      trades.push({
        time,
        price,
        shares,
        side,
        board: typeof item.board === "string" ? item.board : "",
        buyer: typeof item.buyer === "string" ? item.buyer : "",
        seller: typeof item.seller === "string" ? item.seller : "",
      });
    }
    if (payload.data.length > 0 && trades.length === 0) throw new Error("Format transaksi berubah");
    trades.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
    const result: TradesPayload = {
      code,
      date,
      source: "Invezgo",
      fetchedAt: Math.floor(Date.now() / 1000),
      trades,
    };
    trimMap(state.tradePages, 64);
    state.tradePages.set(key, { value: result, fetchedAt: Date.now() });
    return result;
  } catch {
    throw new MarketError(502, "Format Running Trade Invezgo berubah");
  }
}

export type CompareItem = LiveQuote | { code: string; error: string };

export async function getCompare(input: string): Promise<CompareItem[]> {
  if (!input || input.length > 100 || input.endsWith(",")) {
    throw new MarketError(400, "Masukkan 1 sampai 8 kode saham dipisahkan koma");
  }
  const codes: string[] = [];
  for (const part of input.split(",")) {
    const code = stockCode(part);
    if (!codes.includes(code)) codes.push(code);
  }
  if (!codes.length || codes.length > 8) {
    throw new MarketError(400, "Maksimal 8 kode saham per permintaan");
  }

  const rows: CompareItem[] = await Promise.all(
    codes.map(async (code): Promise<CompareItem> => {
      try {
        return await getQuote(code);
      } catch (error) {
        return {
          code,
          error: error instanceof Error ? error.message : "Kuotasi tidak tersedia",
        };
      }
    }),
  );

  rows.sort((a, b) => {
    const aPct = "changePercent" in a && typeof a.changePercent === "number" ? a.changePercent : null;
    const bPct = "changePercent" in b && typeof b.changePercent === "number" ? b.changePercent : null;
    if (aPct === null && bPct === null) return 0;
    if (aPct === null) return 1;
    if (bPct === null) return -1;
    return bPct - aPct;
  });
  return rows;
}
