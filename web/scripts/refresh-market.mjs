import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";

const folder = new URL("../public/market/", import.meta.url);
const quoteFile = new URL("quotes.json", folder);
const fallback = process.argv.includes("--fallback");
const baseCharts = ["AADI","AALI","ABBA","ABDA","ABMM","ACES","ACRO","ACST","ADCP","ADES","ADHI","ADMF","ADMG",
  "ADMR","ADRO","AMMN","ANTM","ASII","BBCA","BBNI","BBRI","BMRI","BREN","BRIS","GOTO","ICBP","INDF","PTBA","TLKM","UNVR"];

const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const positive = (value) => number(value) !== null && value > 0 ? value : null;
const field = (item, name) => positive(item[name]);
const dateFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" });
const date = (time) => dateFormat.format(time * 1000);

async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(9000), headers: { "User-Agent": "Mozilla/5.0 StockWatch/1.0" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function write(uri, value) {
  const temp = new URL(uri.href + ".tmp");
  try {
    await writeFile(temp, JSON.stringify(value) + "\n", "utf8");
    await rename(temp, uri);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

async function yahoo(code, range, interval) {
  const symbol = code + ".JK";
  for (const host of ["query1", "query2"]) {
    try {
      const url = "https://" + host + ".finance.yahoo.com/v8/finance/chart/" + symbol + "?range=" + range + "&interval=" + interval;
      const result = (await get(url)).chart?.result?.[0];
      if (result?.meta?.symbol !== symbol) continue;
      const series = result.indicators?.quote?.[0];
      const marks = result.timestamp ?? [];
      let last = 0;
      return marks.flatMap((t, i) => {
        const o = series?.open?.[i], h = series?.high?.[i], l = series?.low?.[i], c = series?.close?.[i];
        const v = number(series?.volume?.[i]);
        if (!Number.isInteger(t) || t <= last || ![o,h,l,c].every(positive) || o < l || o > h || c < l || c > h) return [];
        if (interval !== "1d" && t % (interval === "1m" ? 60 : 900)) return [];
        last = t;
        return [[t,o,h,l,c,v]];
      });
    } catch {
      // Coba mirror cadangan Yahoo.
    }
  }
  return [];
}

await mkdir(folder, { recursive: true });
let directory;
try {
  const raw = await get("https://pasardana.id/api/StockSearchResult/GetAll?pageBegin=1&pageLength=1500&sortField=Code&sortOrder=ASC");
  const rows = new Map();
  for (const item of raw) {
    if (typeof item.Code !== "string" || !/^[A-Z]{4}$/.test(item.Code)) continue;
    const price = field(item, "Last"), previous = field(item, "PrevClosingPrice");
    const volume = number(item.Volume), value = number(item.Value);
    const change = price && previous ? (price / previous - 1) * 100
      : price && number(item.OneDay) !== null ? item.OneDay * 100 : null;
    rows.set(item.Code, {
      code: item.Code, name: item.Name || item.Code, sector: item.NewSectorName || "",
      date: String(item.LastDate ?? "").slice(0, 10), price, previous, change,
      open: field(item,"AdjustedOpenPrice"), high: field(item,"AdjustedHighPrice"), low: field(item,"AdjustedLowPrice"),
      volume, value, frequency: number(item.Frequency), cap: field(item,"Capitalization"),
      per: number(item.Per), pbr: number(item.Pbr),
      average: volume > 0 && value > 0 ? value / volume : null,
      ara: null, arb: null, bid: null, offer: null,
    });
  }
  const quotes = [...rows.values()];
  const marketDate = quotes.reduce((last, row) => row.price && row.date > last ? row.date : last, "");
  if (quotes.length < 500 || !/^\d{4}-\d{2}-\d{2}$/.test(marketDate)) throw new Error("Snapshot tidak lengkap");
  directory = { source: "Pasardana", date: marketDate, fetchedAt: Math.floor(Date.now()/1000), quotes, charts: {} };
} catch (error) {
  if (!fallback) throw error;
  directory = JSON.parse(await readFile(quoteFile,"utf8"));
  console.warn("Memakai snapshot pasar " + directory.date + ". " + error.message);
}
const chartFiles = directory.charts ?? {};
try {
  Object.assign(chartFiles, JSON.parse(await readFile(quoteFile,"utf8")).charts ?? {});
} catch {
  // Belum ada snapshot sebelumnya.
}
const requested = process.argv.slice(2).map((arg) => arg.toUpperCase()).filter((code) => /^[A-Z]{4}$/.test(code));
const wanted = new Set([...baseCharts, ...Object.keys(chartFiles), ...requested]);
if (!process.argv.includes("--quotes-only")) {
  const work = [...wanted].filter((code) => directory.quotes.some((q) => q.code === code));
  let next = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < work.length) {
      const code = work[next++];
      const daily = await yahoo(code,"5y","1d");
      const week = await yahoo(code,"5d","15m");
      const intraday = await yahoo(code,"1d","1m");
      const prevUri = new URL(code+".json",folder);
      let previous = {};
      try { previous = JSON.parse(await readFile(prevUri,"utf8")); } catch { /* Belum ada data. */ }
      const value = {
        code, source:"Yahoo Finance", daily:daily.length ? daily : previous.daily ?? [],
        week:week.length ? week : previous.week ?? [], intraday:intraday.length ? intraday : previous.intraday ?? [],
      };
      if (!value.daily.length && !value.week.length && !value.intraday.length) continue;
      await write(prevUri,value);
      chartFiles[code] = value.daily.length ? date(value.daily.at(-1)[0]) : date((value.intraday.at(-1) ?? value.week.at(-1))[0]);
    }
  }));
}
directory.charts = chartFiles;
await write(quoteFile,directory);
console.log("Pasardana " + directory.date + " · " + directory.quotes.length + " emiten · " + Object.keys(chartFiles).length + " riwayat.");

