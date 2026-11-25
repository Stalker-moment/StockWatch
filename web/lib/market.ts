import catalog from "../../data/idx-catalog.json";
import indexSnapshot from "../../data/ihsg.json";
import marketData from "../public/market/quotes.json";
import type { LiveQuote } from "./stockbit-parser";

export type { LiveQuote };

export const stocks = catalog.stocks;
export type Stock = (typeof stocks)[number];

export type Quote = {
  code: string; name: string; sector: string; date: string;
  price: number | null; previous: number | null; change: number | null;
  open: number | null; high: number | null; low: number | null;
  volume: number | null; value: number | null; frequency: number | null;
  cap: number | null; per: number | null; pbr: number | null;
  average: number | null; ara: number | null; arb: number | null;
  bid: number | null; offer: number | null;
};

export type MarketSnapshot = {
  source: string;
  date: string;
  fetchedAt: number;
  quotes: Quote[];
  charts: Record<string, string>;
  stale?: boolean;
  offline?: boolean;
};

export type HistoryBar = { t: number; o: number; h: number; l: number; c: number; v: number | null };
export type IntradayAverage = { date: string; average: number; through: number };
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

export const marketSnapshot: MarketSnapshot = marketData;

export function summarize(snapshot: MarketSnapshot) {
  let up = 0, down = 0, flat = 0, value = 0;
  for (const q of snapshot.quotes) {
    if (q.date !== snapshot.date || q.price === null || q.change === null) continue;
    if (q.change > 0) ++up;
    else if (q.change < 0) ++down;
    else ++flat;
    value += q.value ?? 0;
  }
  return { up, down, flat, value };
}

export function compareMetric(a: number | null | undefined, b: number | null | undefined, ascending = false) {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  return ascending ? a - b : b - a;
}

export const initialWatchlist = ["BBRI", "TLKM", "AMMN"];
export const wib = "Asia/Jakarta";
export const ihsg: Stock = { code: indexSnapshot.quote.code, name: indexSnapshot.quote.name, sector: "Indeks IDX" };
export const indexQuote: LiveQuote = indexSnapshot.quote as LiveQuote;
export const periodRanges = ["1d", "5d", "1mo", "3mo", "6mo", "ytd", "1y", "5y"] as const;

export function matchesIndex(query: string) {
  const aliases = "ihsg ^jkse jkse idx composite indeks harga saham gabungan";
  return query.toLowerCase().trim().split(/\s+/).every((term) => aliases.includes(term));
}

const indexTimeFormatter = new Intl.DateTimeFormat("id-ID", {
  timeZone: wib, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const quoteTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: wib, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const clockTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: wib, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const hmTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: wib, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const isoDateFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: wib, year: "numeric", month: "2-digit", day: "2-digit",
});

export function formatIndexTime(unixSeconds: number | null | undefined) {
  if (!unixSeconds) return "--";
  return indexTimeFormatter.format(unixSeconds * 1000).replace(".", ":");
}

export function formatQuoteTime(unixSeconds: number | null | undefined) {
  if (!unixSeconds) return "";
  return quoteTimeFormatter.format(unixSeconds * 1000).replace(",", "");
}

export function formatClockWib(unixSeconds: number | null | undefined) {
  if (!unixSeconds) return "--:--:--";
  return clockTimeFormatter.format(unixSeconds * 1000);
}

export function formatHmWib(unixSeconds: number | null | undefined) {
  if (!unixSeconds) return "--:--";
  return hmTimeFormatter.format(unixSeconds * 1000);
}

export function wibDateOf(unixSeconds: number | null | undefined) {
  if (!unixSeconds || unixSeconds <= 0) return "";
  return isoDateFormatter.format(unixSeconds * 1000);
}

export const indexTime = formatIndexTime(indexQuote.marketTime);

export const periods = [
  { label: "1D", interval: "1 menit", count: 76 },
  { label: "5D", interval: "15 menit", count: 75 },
  { label: "1M", interval: "1 hari", count: 23 },
  { label: "3M", interval: "1 hari", count: 65 },
  { label: "6M", interval: "1 hari", count: 128 },
  { label: "YTD", interval: "1 hari", count: 217 },
  { label: "1Y", interval: "1 hari", count: 250 },
  { label: "5Y", interval: "1 minggu", count: 260 },
] as const;

export const integer = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function rupiah(value: number | null | undefined) {
  return value == null ? "--" : "Rp" + integer.format(value);
}

export function points(value: number | null | undefined) {
  return value == null ? "--" : decimal.format(value);
}

export function indexMetricsOf(quote: LiveQuote) {
  return [
    ["Buka", quote.open ?? null],
    ["High", quote.high ?? null],
    ["Low", quote.low ?? null],
    ["Prev", quote.previous ?? null],
  ] as const;
}

export const indexMetrics = indexMetricsOf(indexQuote);

export function percent(value: number | null | undefined) {
  if (value == null) return "--";
  return (value > 0 ? "+" : "") + decimal.format(value) + "%";
}

export function compact(value: number | null | undefined) {
  if (value == null) return "--";
  const units = [[1e12, "T"], [1e9, "M"], [1e6, "jt"], [1e3, "rb"]] as const;
  const unit = units.find(([factor]) => Math.abs(value) >= factor);
  if (!unit) return integer.format(value);
  return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 }).format(value / unit[0]) + unit[1];
}

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export function indexHistory(period: number): Candle[] {
  return indexSnapshot.history[periodRanges[period]].bars.map(({ t, o, h, l, c, v }) =>
    ({ time: t * 1000, open: o, high: h, low: l, close: c, volume: v ?? 0 }));
}

export function groupBars(bars: Candle[], limit: number): Candle[] {
  const count = Math.min(bars.length, Math.max(1, limit));
  if (count === bars.length) return bars;
  return Array.from({ length: count }, (_, index) => {
    const from = Math.floor(index * bars.length / count);
    const to = Math.floor((index + 1) * bars.length / count);
    const group = bars.slice(from, to);
    return {
      time: group[0].time,
      open: group[0].open,
      close: group[group.length - 1].close,
      low: Math.min(...group.map((bar) => bar.low)),
      high: Math.max(...group.map((bar) => bar.high)),
      volume: group.reduce((sum, bar) => sum + bar.volume, 0),
    };
  });
}

const intradayTime = new Intl.DateTimeFormat("id-ID", { timeZone: wib, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const tradingDate = new Intl.DateTimeFormat("en-GB", { timeZone: wib, day: "2-digit", month: "short" });
const month = new Intl.DateTimeFormat("id-ID", { timeZone: wib, month: "short", year: "2-digit" });

export function chartTime(time: number, period: number) {
  if (period === 0) return intradayTime.format(time).replace(".", ":");
  if (period >= 4) return month.format(time);
  return tradingDate.format(time);
}
