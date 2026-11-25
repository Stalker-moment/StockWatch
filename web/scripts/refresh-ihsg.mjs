import { readFile, rename, unlink, writeFile } from "node:fs/promises";

const file = new URL("../../data/ihsg.json", import.meta.url);
const pending = new URL("../../data/ihsg.json.tmp", import.meta.url);
const periods = { "1d": "1m", "5d": "15m", "1mo": "1d", "3mo": "1d", "6mo": "1d", ytd: "1d", "1y": "1d", "5y": "1wk" };
const symbol = "^JKSE";
const tz = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" });
const date = (time) => tz.format(time * 1000);
const valid = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

async function chart(range, interval) {
  for (const prefix of ["query1", "query2"]) {
    try {
      const path = "/v8/finance/chart/" + encodeURIComponent(symbol) + "?range=" + range + "&interval=" + interval;
      const response = await fetch("https://" + prefix + ".finance.yahoo.com" + path, {
        signal: AbortSignal.timeout(8500), headers: { "User-Agent": "Mozilla/5.0 StockWatch/1.0" },
      });
      if (!response.ok) continue;
      const result = (await response.json()).chart?.result?.[0];
      if (result?.meta?.symbol === symbol && result.meta.instrumentType === "INDEX") return result;
    } catch {
      // Tersedia dua endpoint Yahoo Finance.
    }
  }
  throw new Error("Yahoo Finance tidak menyediakan IHSG untuk " + range + " / " + interval);
}

function bars(result, interval) {
  const marks = result.timestamp ?? [];
  const series = result.indicators?.quote?.[0];
  let last = 0;
  return marks.flatMap((t, i) => {
    const o = series?.open?.[i], h = series?.high?.[i], l = series?.low?.[i], c = series?.close?.[i];
    const v = series?.volume?.[i];
    const seconds = interval === "1m" ? 60 : interval === "15m" ? 900 : 0;
    const weeklyTail = interval === "1wk" && t === result.meta.regularMarketTime && last > 0 && t - last < 432000;
    if (!Number.isInteger(t) || t <= last || (seconds && t % seconds) || weeklyTail ||
        ![o, h, l, c].every(valid) || o < l || o > h || c < l || c > h) return [];
    last = t;
    return [{ t, o, h, l, c, v: valid(v) ? v : null }];
  });
}

try {
  const daily = await chart("1d", "1d");
  const m = daily.meta;
  const price = m.regularMarketPrice;
  const previous = m.previousClose ?? m.chartPreviousClose;
  const marketTime = m.regularMarketTime;
  if (![price, previous, marketTime].every(valid)) throw new Error("Kuotasi IHSG tidak lengkap.");
  const latest = bars(daily, "1d").at(-1);
  const sameSession = latest && date(latest.t) === date(marketTime) ? latest : null;
  const fetchedAt = Math.floor(Date.now() / 1000);
  const quote = {
    code: "IHSG", symbol, name: "Indeks Harga Saham Gabungan", kind: "index", currency: "IDR",
    price, previous, change: price - previous, changePercent: (price / previous - 1) * 100,
    open: sameSession?.o ?? null,
    high: m.regularMarketDayHigh ?? sameSession?.h ?? null,
    low: m.regularMarketDayLow ?? sameSession?.l ?? null,
    volume: null, marketTime, date: date(marketTime), source: "Yahoo Finance", fetchedAt, demo: false,
  };
  const history = {};
  for (const [range, interval] of Object.entries(periods)) {
    const result = await chart(range, interval);
    const series = bars(result, interval);
    if (!series.length) throw new Error("Riwayat IHSG kosong untuk " + range);
    history[range] = { code: "IHSG", range, interval, source: "Yahoo Finance", bars: series,
      marketTime: result.meta.regularMarketTime, fetchedAt };
  }
  const out = { quote, history };
  await writeFile(pending, JSON.stringify(out) + "\n", "utf8");
  await rename(pending, file);
  console.log("Snapshot IHSG " + quote.date + ", " + Object.keys(history).length + " periode.");
} catch (error) {
  await unlink(pending).catch(() => {});
  if (!process.argv.includes("--fallback")) throw error;
  const previous = JSON.parse(await readFile(file, "utf8"));
  if (!valid(previous.quote?.price) || !Object.keys(periods).every((range) => previous.history?.[range]?.bars?.length)) throw error;
  console.warn("Snapshot IHSG " + previous.quote.date + " dipakai kembali. " + error.message);
}

