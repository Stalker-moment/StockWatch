export const IHSG_CODE = "IHSG";
export const IHSG_SYMBOL = "^JKSE";
export const IHSG_NAME = "Indeks Harga Saham Gabungan";

export type LiveQuote = {
  code: string;
  symbol: string;
  name: string;
  kind?: "index";
  currency: string;
  price: number;
  previous: number | null;
  change: number | null;
  changePercent: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  volume: number | null;
  value?: number | null;
  bid?: number | null;
  offer?: number | null;
  ara?: number | null;
  arb?: number | null;
  board?: string;
  marketTime: number | null;
  date: string;
  timePrecision?: string;
  marketOpen?: boolean | null;
  marketStatus?: string;
  marketTimeLeft?: string;
  source: string;
  fetchedAt?: number;
  snapshot?: boolean;
  demo?: boolean;
};

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function positiveNumber(value: unknown): number | null {
  const n = finiteNumber(value);
  return n !== null && n > 0 ? n : null;
}

function stockbitTime(row: Record<string, unknown>): { date: string; timestamp: number | null } {
  const rawDate = typeof row.date === "string" ? row.date.trim() : "";
  const match = rawDate.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!match) return { date: "", timestamp: null };
  const day = Number(match[1]);
  const monthIdx = months.indexOf(match[2].toLowerCase());
  const year = Number(match[3]);
  if (monthIdx < 0 || day < 1 || day > 31 || year < 1970 || year > 2100) {
    return { date: "", timestamp: null };
  }
  const check = new Date(Date.UTC(year, monthIdx, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== monthIdx || check.getUTCDate() !== day) {
    return { date: "", timestamp: null };
  }
  const isoDate = `${year}-${String(monthIdx + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  const rawTime = typeof row.time === "string" ? row.time.trim() : "";
  const clock = rawTime.includes(" ") ? rawTime.slice(rawTime.lastIndexOf(" ") + 1) : rawTime;
  const clockMatch = clock.match(/^(\d{1,2}):(\d{2})$/);
  if (!clockMatch) return { date: isoDate, timestamp: null };
  const hour = Number(clockMatch[1]);
  const minute = Number(clockMatch[2]);
  if (hour < 0 || hour >= 24 || minute < 0 || minute >= 60) {
    return { date: isoDate, timestamp: null };
  }
  const utcSeconds = Math.floor(Date.UTC(year, monthIdx, day, hour, minute) / 1000) - 7 * 3600;
  return { date: isoDate, timestamp: utcSeconds };
}

function stockbitBoard(row: Record<string, unknown>): string {
  if (Array.isArray(row.notation)) {
    for (const item of row.notation) {
      if (item && typeof item === "object" && (item as Record<string, unknown>).notation_code === "X") {
        return "Papan Pemantauan Khusus";
      }
    }
  }
  if (Array.isArray(row.catalogs)) {
    for (const item of row.catalogs) {
      if (
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).company_type === "listing-board"
      ) {
        const sym = (item as Record<string, unknown>).company_symbol;
        if (typeof sym === "string") return sym;
      }
    }
  }
  return "";
}

function priceTick(price: number): number {
  if (price < 200) return 1;
  if (price < 500) return 2;
  if (price < 2000) return 5;
  if (price < 5000) return 10;
  return 25;
}

function addPriceLimits(quote: LiveQuote, row: Record<string, unknown>) {
  const board = stockbitBoard(row);
  if (!board) return;
  quote.board = board;

  const corp = row.corp_action;
  if (corp && typeof corp === "object" && (corp as Record<string, unknown>).active === true) return;

  const previous = quote.previous;
  if (
    previous === null ||
    previous < 1 ||
    previous > 100_000_000 ||
    Math.floor(previous) !== previous
  ) {
    return;
  }

  const monitored = board === "Papan Pemantauan Khusus";
  const special = monitored || board === "Papan Akselerasi";
  const regular =
    board === "Papan Utama" ||
    board === "Papan Pengembangan" ||
    board === "Papan Ekonomi Baru";

  // Kep-00158/BEI/10-2026 menetapkan ARB sementara sampai 31 Desember 2026.
  if ((!special && !regular) || quote.date < "2026-10-20" || quote.date > "2026-12-31") return;

  const base = Math.trunc(previous);
  const rise = special ? 10 : base <= 200 ? 35 : base <= 5000 ? 25 : 20;
  const fall = special ? 10 : 7;
  const ceiling = base <= 10 ? base + 1 : Math.floor((base * (100 + rise)) / 100);
  const floor = Math.max(
    1,
    base <= 10 || (regular && base <= 14)
      ? base - 1
      : Math.floor((base * (100 - fall) + 99) / 100),
  );
  const upperTick = priceTick(ceiling);
  const lowerTick = priceTick(floor);
  quote.ara = Math.floor(ceiling / upperTick) * upperTick;
  quote.arb = Math.floor((floor + lowerTick - 1) / lowerTick) * lowerTick;
}

export function parseStockbitHtml(html: string, code: string): LiveQuote | null {
  let marker = html.indexOf('id="__NEXT_DATA__"');
  if (marker < 0) marker = html.indexOf("id='__NEXT_DATA__'");
  if (marker < 0) return null;

  const script = html.lastIndexOf("<script", marker);
  const begin = html.indexOf(">", marker);
  if (script < 0 || begin < 0 || html.indexOf(">", script) !== begin) return null;
  const end = html.indexOf("</script", begin + 1);
  if (end < 0) return null;

  let body: unknown;
  try {
    body = JSON.parse(html.slice(begin + 1, end));
  } catch {
    return null;
  }

  const row = (body as { props?: { pageProps?: { company?: Record<string, unknown> } } })
    ?.props?.pageProps?.company;
  if (!row || typeof row !== "object") return null;
  if (row.symbol !== code || row.exchange !== "IDX") return null;

  const price = positiveNumber(row.price) ?? positiveNumber(row.lastprice);
  if (price === null) return null;

  const previous = positiveNumber(row.previous);
  let change = finiteNumber(row.change);
  let changePercent = finiteNumber(row.percentage);
  if (previous !== null) {
    change = price - previous;
    changePercent = (change / previous) * 100;
  }

  const clock = stockbitTime(row);
  let marketOpen: boolean | null = null;
  let marketStatus = "";
  let marketTimeLeft = "";
  if (row.market_hour && typeof row.market_hour === "object") {
    const mh = row.market_hour as Record<string, unknown>;
    if (typeof mh.status === "string" && mh.status.length > 0) {
      marketStatus = mh.status;
      marketOpen = mh.status === "open";
    }
    if (typeof mh.formatted_time_left === "string") {
      marketTimeLeft = mh.formatted_time_left;
    }
  }

  const isIndex = code === IHSG_CODE;
  const quote: LiveQuote = {
    code,
    symbol: isIndex ? IHSG_SYMBOL : code + ".JK",
    name: isIndex ? IHSG_NAME : typeof row.name === "string" && row.name ? row.name : code,
    ...(isIndex ? { kind: "index" as const } : {}),
    currency: "IDR",
    price,
    previous,
    change,
    changePercent,
    volume: isIndex ? null : finiteNumber(row.volume),
    marketTime: clock.timestamp,
    date: clock.date,
    timePrecision: "minute",
    marketOpen,
    marketStatus,
    marketTimeLeft,
    source: "Stockbit",
    demo: false,
  };

  if (!isIndex && row.orderbook && typeof row.orderbook === "object") {
    const book = row.orderbook as Record<string, unknown>;
    for (const side of ["bid", "offer"] as const) {
      const level = book[side];
      if (!level || typeof level !== "object") continue;
      const levelPrice = positiveNumber((level as Record<string, unknown>).price);
      if (levelPrice !== null) quote[side] = levelPrice;
    }
  }

  if (!isIndex) addPriceLimits(quote, row);
  return quote;
}
