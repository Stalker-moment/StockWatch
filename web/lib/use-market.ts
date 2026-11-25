"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ihsg,
  indexHistory,
  indexQuote as bundledIndexQuote,
  marketSnapshot,
  periodRanges,
  periods,
  rupiah,
  stocks as bundledStocks,
  wib,
  wibDateOf,
  type Candle,
  type HistoryBar,
  type IntradayAverage,
  type LiveQuote,
  type MarketSnapshot,
  type Quote,
  type Stock,
  type TradesPayload,
} from "./market";
import { parseStockbitHtml } from "./stockbit-parser";
import { maxAlerts, playAlertBeep, readAlerts, saveAlerts, type PriceAlert } from "./watchlist";

type Row = [number, number, number, number, number, number | null];
type StaticStockHistory = { code: string; source: string; daily: Row[]; week: Row[]; intraday: Row[] };

export type ApiMode = "detecting" | "next" | "cpp" | "remote" | "static";

export type LiveQuoteEntry = {
  data: LiveQuote;
  error: string;
  move: number | null;
  flashUntil: number;
};

export type MarketStatusBadge = {
  label: "BUKA" | "ISTIRAHAT" | "TUTUP";
  tone: "open" | "break" | "closed";
  timeLeft: string;
};

export type CompareResultRow = LiveQuote | { code: string; error: string };

export type MergedDetail = {
  price: number | null;
  previous: number | null;
  change: number | null;
  delta: number | null;
  pulse: number | null;
  tradeDate: string;
  dayLabel: string;
  liveSource: string | null;
  marketTime: number | null;
  fetchedAt: number | null;
  cached: boolean;
  open: number | null;
  high: number | null;
  low: number | null;
  ohlcSource: string;
  volume: number | null;
  value: number | null;
  average: number | null;
  estimatedAverage: boolean;
  averageThrough: number | null;
  earlierAverage: number | null;
  earlierDate: string;
  ara: number | null;
  arb: number | null;
  board: string;
  bid: number | null;
  offer: number | null;
  frequency: number | null;
  cap: number | null;
  per: number | null;
  pbr: number | null;
};

type ApiBackend = { apiBase: string | null; mode: Exclude<ApiMode, "detecting"> };

type LiveHistoryApiPayload = {
  code: string;
  range: string;
  interval: string;
  source: string;
  bars: HistoryBar[];
  session?: HistoryBar | null;
  intraday?: IntradayAverage | null;
};

type DirectoryApiRow = {
  code: string;
  name?: string;
  sector?: string;
  date?: string;
  price?: number | null;
  previous?: number | null;
  changePercent?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  volume?: number | null;
  value?: number | null;
  frequency?: number | null;
  cap?: number | null;
  per?: number | null;
  pbr?: number | null;
};

type DirectoryApiPayload = {
  source?: string;
  date?: string;
  fetchedAt?: number;
  stale?: boolean;
  offline?: boolean;
  stocks?: DirectoryApiRow[];
};

const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const configuredApi = (process.env.NEXT_PUBLIC_API_URL ?? "").trim().replace(/\/+$/, "");
const secondsPerDay = 86400;
const tradeDateFormat = new Intl.DateTimeFormat("sv-SE", {
  timeZone: wib,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

let backendPromise: Promise<ApiBackend> | null = null;
let directStockbitBlockedUntil = 0;

export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState !== "hidden");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return visible;
}

async function probeHealth(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: boolean };
    return body?.ok === true;
  } catch {
    return false;
  }
}

export function discoverBackend(force = false): Promise<ApiBackend> {
  if (!force && backendPromise) return backendPromise;
  const run = (async (): Promise<ApiBackend> => {
    if (configuredApi) {
      if (await probeHealth(configuredApi + "/health", 2500)) {
        return { apiBase: configuredApi, mode: "remote" };
      }
    }
    if (await probeHealth(base + "/api/health", 2500)) {
      return { apiBase: base + "/api", mode: "next" };
    }
    if (typeof window !== "undefined") {
      if (await probeHealth("http://127.0.0.1:8787/health", 1200)) {
        return { apiBase: "http://127.0.0.1:8787", mode: "cpp" };
      }
    }
    return { apiBase: null, mode: "static" };
  })();
  backendPromise = run;
  return run;
}

async function apiGet<T>(apiBase: string, path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(apiBase + path, { cache: "no-store", signal });
  let body: { ok?: boolean; data?: T; message?: string } | null = null;
  try {
    body = (await response.json()) as { ok?: boolean; data?: T; message?: string };
  } catch {
    // Respons non-JSON.
  }
  if (!response.ok || !body?.ok || body.data === undefined) {
    throw new Error(body?.message || `HTTP ${response.status}`);
  }
  return body.data;
}

async function fetchStockbitDirect(code: string, signal?: AbortSignal): Promise<LiveQuote | null> {
  if (Date.now() < directStockbitBlockedUntil) return null;
  try {
    const response = await fetch("https://stockbit.com/symbol/" + encodeURIComponent(code), {
      mode: "cors",
      credentials: "omit",
      signal,
    });
    if (response.status === 403 || response.status === 429) {
      directStockbitBlockedUntil = Date.now() + 90_000;
      return null;
    }
    if (!response.ok) return null;
    const parsed = parseStockbitHtml(await response.text(), code);
    if (!parsed) return null;
    return { ...parsed, fetchedAt: Math.floor(Date.now() / 1000) };
  } catch {
    directStockbitBlockedUntil = Date.now() + 90_000;
    return null;
  }
}

export function quoteSessionDate(quote: LiveQuote | null | undefined): string {
  if (!quote) return "";
  if (quote.date) return quote.date;
  return quote.marketTime ? wibDateOf(quote.marketTime) : "";
}

export function marketStatusOf(
  indexEntry: LiveQuoteEntry | undefined,
  selectedEntry: LiveQuoteEntry | undefined,
): MarketStatusBadge | null {
  const inspect = (quote: LiveQuote | undefined): MarketStatusBadge | null => {
    if (!quote) return null;
    const status = (quote.marketStatus || "").toLowerCase();
    const rawLeft = (quote.marketTimeLeft || "").trim();
    const shortLeft =
      rawLeft && !/^0 jam 0 menit 0 detik$/i.test(rawLeft)
        ? rawLeft.replace(/(\d+)\s*jam\s*/i, "$1j ").replace(/(\d+)\s*menit\s*/i, "$1m ").replace(/(\d+)\s*detik/i, "$1d").replace(/^0j\s*/, "").trim()
        : "";
    if (status === "open") return { label: "BUKA", tone: "open", timeLeft: shortLeft };
    if (status === "break") return { label: "ISTIRAHAT", tone: "break", timeLeft: shortLeft };
    if (status === "closed" || status === "close") return { label: "TUTUP", tone: "closed", timeLeft: shortLeft };
    if (typeof quote.marketOpen === "boolean") {
      return quote.marketOpen
        ? { label: "BUKA", tone: "open", timeLeft: "" }
        : { label: "TUTUP", tone: "closed", timeLeft: "" };
    }
    return null;
  };
  return inspect(indexEntry?.data) ?? inspect(selectedEntry?.data);
}

function toMarketSnapshot(data: DirectoryApiPayload, previous: MarketSnapshot): MarketSnapshot {
  const rows = Array.isArray(data.stocks) ? data.stocks : [];
  const quotes: Quote[] = rows.map((row) => {
    const volume = typeof row.volume === "number" && Number.isFinite(row.volume) ? row.volume : null;
    const value = typeof row.value === "number" && Number.isFinite(row.value) ? row.value : null;
    return {
      code: row.code,
      name: row.name || row.code,
      sector: row.sector || "",
      date: row.date || "",
      price: typeof row.price === "number" && Number.isFinite(row.price) ? row.price : null,
      previous: typeof row.previous === "number" && Number.isFinite(row.previous) ? row.previous : null,
      change: typeof row.changePercent === "number" && Number.isFinite(row.changePercent) ? row.changePercent : null,
      open: typeof row.open === "number" && Number.isFinite(row.open) ? row.open : null,
      high: typeof row.high === "number" && Number.isFinite(row.high) ? row.high : null,
      low: typeof row.low === "number" && Number.isFinite(row.low) ? row.low : null,
      volume,
      value,
      frequency: typeof row.frequency === "number" && Number.isFinite(row.frequency) ? row.frequency : null,
      cap: typeof row.cap === "number" && Number.isFinite(row.cap) ? row.cap : null,
      per: typeof row.per === "number" && Number.isFinite(row.per) ? row.per : null,
      pbr: typeof row.pbr === "number" && Number.isFinite(row.pbr) ? row.pbr : null,
      average: volume && value && volume > 0 && value > 0 ? value / volume : null,
      ara: null,
      arb: null,
      bid: null,
      offer: null,
    };
  });
  return {
    source: data.source || previous.source || "Pasardana",
    date: data.date || previous.date,
    fetchedAt: data.fetchedAt || Math.floor(Date.now() / 1000),
    quotes: quotes.length ? quotes : previous.quotes,
    charts: previous.charts,
    stale: Boolean(data.stale),
    offline: Boolean(data.offline),
  };
}

export function useMarketQuotes(paused: boolean) {
  const pageVisible = usePageVisible();
  const effectivePaused = paused || !pageVisible;
  const [snapshot, setSnapshot] = useState<MarketSnapshot>(marketSnapshot);
  const [checked, setChecked] = useState(marketSnapshot.fetchedAt * 1000);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<ApiMode>("detecting");

  const refresh = useCallback(async (forceRediscover = false) => {
    try {
      const backend = await discoverBackend(forceRediscover);
      setMode(backend.mode);
      if (backend.apiBase) {
        const data = await apiGet<DirectoryApiPayload>(backend.apiBase, "/stocks/directory");
        setSnapshot((current) => toMarketSnapshot(data, current));
        setError(data.stale ? "Memakai cache pasar" : "");
      } else {
        const result = await fetch(base + "/market/quotes.json", { cache: "no-cache" });
        if (!result.ok) throw new Error();
        const next: MarketSnapshot = await result.json();
        if (!Array.isArray(next.quotes) || !next.date || !next.fetchedAt || !next.charts) throw new Error();
        setSnapshot((current) => (next.fetchedAt >= current.fetchedAt ? next : current));
        setError("");
      }
    } catch {
      setError("Snapshot sebelumnya tersimpan");
    } finally {
      setChecked(Date.now());
    }
  }, []);

  const isLive = mode === "next" || mode === "cpp" || mode === "remote";
  const autoSeconds = isLive ? 30 : 60;

  useEffect(() => {
    if (effectivePaused) return;
    void refresh(false);
    const interval = window.setInterval(() => void refresh(false), autoSeconds * 1000);
    return () => window.clearInterval(interval);
  }, [effectivePaused, refresh, autoSeconds]);

  const prices = useMemo(
    () => new Map(snapshot.quotes.map((quote) => [quote.code, quote])),
    [snapshot],
  );
  const stockList: Stock[] = useMemo(() => {
    if (snapshot.quotes.length < 500) return bundledStocks;
    return snapshot.quotes.map((quote) => ({
      code: quote.code,
      name: quote.name,
      sector: quote.sector,
    }));
  }, [snapshot]);
  const sectors = useMemo(() => {
    const set = new Set<string>();
    for (const item of stockList) {
      if (item.sector) set.add(item.sector);
    }
    return [...set].sort((a, b) => a.localeCompare(b, "id-ID"));
  }, [stockList]);

  return {
    snapshot,
    checked,
    prices,
    stockList,
    sectors,
    error,
    mode,
    isLive,
    autoSeconds,
    pageVisible,
    refresh,
  };
}

function mergeIncomingQuote(
  previous: LiveQuoteEntry | undefined,
  incoming: LiveQuote,
  nowMs: number,
): LiveQuoteEntry {
  if (previous) {
    const prev = previous.data;
    const prevTime = prev.marketTime ?? 0;
    const nextTime = incoming.marketTime ?? 0;
    const prevDate = quoteSessionDate(prev);
    const nextDate = quoteSessionDate(incoming);
    if (
      (nextTime > 0 && prevTime > 0 && nextTime < prevTime) ||
      (prev.source === "Stockbit" && incoming.source !== "Stockbit" && !nextTime && nextDate <= prevDate)
    ) {
      return { ...previous, error: "Kuotasi pengganti lebih lama" };
    }
    const sameFetch =
      incoming.source === prev.source &&
      (incoming.fetchedAt ?? 0) === (prev.fetchedAt ?? 0) &&
      (incoming.fetchedAt ?? 0) > 0;
    if (!sameFetch) {
      let move: number | null = null;
      let flashUntil = 0;
      if (incoming.source === prev.source && nextDate === prevDate) {
        move = incoming.price - prev.price;
        if (move !== 0) flashUntil = nowMs + 4000;
      }
      return { data: incoming, error: "", move, flashUntil };
    }
    return { ...previous, data: incoming, error: "" };
  }
  return { data: incoming, error: "", move: null, flashUntil: 0 };
}

export function useLiveQuotes(
  selectedCode: string | null,
  paused: boolean,
  refreshTick: number,
  batchCodes: string[] = [],
) {
  const pageVisible = usePageVisible();
  const effectivePaused = paused || !pageVisible;
  const [entries, setEntries] = useState<Record<string, LiveQuoteEntry>>({});
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const fetchQuoteFor = useCallback(async (code: string, signal?: AbortSignal): Promise<LiveQuote | null> => {
    const backend = await discoverBackend();
    if (backend.apiBase) {
      return apiGet<LiveQuote>(backend.apiBase, "/stocks/" + encodeURIComponent(code), signal);
    }
    return fetchStockbitDirect(code, signal);
  }, []);

  const commitQuote = useCallback((code: string, quote: LiveQuote | null, errMessage: string) => {
    const nowMs = Date.now();
    setEntries((prev) => {
      const existing = prev[code];
      if (!quote || quote.price <= 0 || quote.code !== code) {
        if (!existing) return prev;
        return { ...prev, [code]: { ...existing, error: errMessage || "Kuotasi tidak lengkap" } };
      }
      const next = { ...prev };
      const keys = Object.keys(next);
      if (keys.length >= 64 && !next[code]) {
        delete next[keys[0]];
      }
      next[code] = mergeIncomingQuote(existing, quote, nowMs);
      return next;
    });
  }, []);

  const fetchCompare = useCallback(
    async (rawCodes: string[], signal?: AbortSignal): Promise<CompareResultRow[]> => {
      const clean = [...new Set(rawCodes.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{4}$/.test(c)))].slice(0, 8);
      if (!clean.length) return [];
      const backend = await discoverBackend();
      if (backend.apiBase) {
        const rows = await apiGet<CompareResultRow[]>(
          backend.apiBase,
          "/stocks/compare?codes=" + encodeURIComponent(clean.join(",")),
          signal,
        );
        for (const row of rows) {
          if (!("error" in row)) commitQuote(row.code, row, "");
        }
        return rows;
      }
      const results = await Promise.all(
        clean.map(async (code): Promise<CompareResultRow> => {
          const quote = await fetchStockbitDirect(code, signal);
          if (quote) {
            commitQuote(code, quote, "");
            return quote;
          }
          return { code, error: "Kuotasi live tidak tersedia di mode statis" };
        }),
      );
      return results;
    },
    [commitQuote],
  );

  // Poll IHSG automatically every 8s when focused (15s in background, 30s when closed/break).
  const indexFocused = selectedCode === ihsg.code;
  useEffect(() => {
    if (effectivePaused) return;
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    const run = async () => {
      controller?.abort();
      controller = new AbortController();
      let marketOpen: boolean | null | undefined;
      try {
        const data = await fetchQuoteFor(ihsg.code, controller.signal);
        if (!active) return;
        if (data) {
          marketOpen = data.marketOpen;
          commitQuote(ihsg.code, data, "");
        }
      } catch (err) {
        if (!active || controller.signal.aborted) return;
        commitQuote(ihsg.code, null, err instanceof Error ? err.message : "Gagal memuat IHSG");
      }
      if (!active) return;
      const delay = marketOpen === false ? 30_000 : indexFocused ? 8_000 : 15_000;
      timer = window.setTimeout(() => void run(), delay);
    };

    void run();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [effectivePaused, refreshTick, indexFocused, fetchQuoteFor, commitQuote]);

  // Poll the currently selected stock every 8s (30s when closed/break) with 250ms debounce.
  useEffect(() => {
    if (effectivePaused || !selectedCode || selectedCode === ihsg.code) return;
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    const run = async () => {
      controller?.abort();
      controller = new AbortController();
      let marketOpen: boolean | null | undefined;
      try {
        const data = await fetchQuoteFor(selectedCode, controller.signal);
        if (!active) return;
        if (data) {
          marketOpen = data.marketOpen;
          commitQuote(selectedCode, data, "");
        }
      } catch (err) {
        if (!active || controller.signal.aborted) return;
        commitQuote(selectedCode, null, err instanceof Error ? err.message : "Gagal memuat kuotasi");
      }
      if (!active) return;
      const delay = marketOpen === false ? 30_000 : 8_000;
      timer = window.setTimeout(() => void run(), delay);
    };

    const existing = entriesRef.current[selectedCode];
    const recentlyFetched =
      refreshTick === 0 &&
      existing?.data.fetchedAt &&
      Date.now() - existing.data.fetchedAt * 1000 < 5_000;
    timer = window.setTimeout(() => void run(), recentlyFetched ? 4_000 : 250);

    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [selectedCode, effectivePaused, refreshTick, fetchQuoteFor, commitQuote]);

  // Batch poll Watchlist / Portfolio / Compare stocks every 15s (30s when closed/break).
  const batchKey = useMemo(
    () => [...new Set(batchCodes.filter((c) => /^[A-Z]{4}$/.test(c)))].slice(0, 8).sort().join(","),
    [batchCodes],
  );
  useEffect(() => {
    if (effectivePaused || !batchKey) return;
    const list = batchKey.split(",");
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    const run = async () => {
      controller?.abort();
      controller = new AbortController();
      let marketOpen: boolean | null | undefined;
      try {
        const rows = await fetchCompare(list, controller.signal);
        if (!active) return;
        for (const row of rows) {
          if (!("error" in row) && typeof row.marketOpen === "boolean") {
            marketOpen = row.marketOpen;
            break;
          }
        }
      } catch {
        // Tetap tampilkan kuotasi sebelumnya bila batch gagal.
      }
      if (!active) return;
      timer = window.setTimeout(() => void run(), marketOpen === false ? 30_000 : 15_000);
    };

    timer = window.setTimeout(() => void run(), 350);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [batchKey, effectivePaused, refreshTick, fetchCompare]);

  const fetchOneQuote = useCallback(
    async (code: string): Promise<LiveQuote | null> => {
      try {
        const data = await fetchQuoteFor(code);
        if (data) commitQuote(code, data, "");
        return data;
      } catch {
        return entriesRef.current[code]?.data ?? null;
      }
    },
    [fetchQuoteFor, commitQuote],
  );

  const indexEntry = entries[ihsg.code];
  const liveIndexQuote = indexEntry?.data ?? bundledIndexQuote;
  const marketStatus = marketStatusOf(indexEntry, selectedCode ? entries[selectedCode] : undefined);

  return {
    liveQuotes: entries,
    indexEntry,
    liveIndexQuote,
    marketStatus,
    pageVisible,
    fetchOneQuote,
    fetchCompare,
  };
}

export function usePriceAlerts(
  liveQuotes: Record<string, LiveQuoteEntry>,
  prices: Map<string, Quote>,
) {
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [banner, setBanner] = useState("");

  useEffect(() => {
    setAlerts(readAlerts());
  }, []);

  useEffect(() => {
    if (!alerts.length) return;
    let triggeredNotice = "";
    let changed = false;
    const next = alerts.map((alert) => {
      if (alert.triggered) return alert;
      const price = liveQuotes[alert.code]?.data.price ?? prices.get(alert.code)?.price ?? null;
      if (price === null) return alert;
      const hit = alert.above ? price >= alert.target : price <= alert.target;
      if (!hit) return alert;
      changed = true;
      triggeredNotice = `ALERT ${alert.code} ${alert.above ? "≥" : "≤"} ${rupiah(alert.target)} (kini ${rupiah(price)})`;
      return { ...alert, triggered: true };
    });
    if (changed) {
      setAlerts(next);
      saveAlerts(next);
      setBanner(triggeredNotice);
      playAlertBeep();
    }
  }, [alerts, liveQuotes, prices]);

  const addAlert = useCallback((code: string, target: number, above: boolean): string => {
    if (!/^[A-Z]{4}$/.test(code)) return "Price alert hanya untuk emiten saham";
    if (!Number.isFinite(target) || target <= 0 || target > 1_000_000_000) return "Target harga tidak valid";
    let result = "";
    setAlerts((prev) => {
      if (prev.length >= maxAlerts) {
        result = `Alert penuh (maksimal ${maxAlerts})`;
        return prev;
      }
      const next: PriceAlert[] = [
        ...prev,
        { id: `${code}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, code, target, above, triggered: false },
      ];
      saveAlerts(next);
      result = `Alert disimpan: ${code} ${above ? "≥" : "≤"} ${rupiah(target)}`;
      return next;
    });
    return result;
  }, []);

  const removeAlert = useCallback((id: string) => {
    setAlerts((prev) => {
      const next = prev.filter((item) => item.id !== id);
      saveAlerts(next);
      return next;
    });
  }, []);

  const removeAlertsForCode = useCallback((code: string): string => {
    let removed = 0;
    setAlerts((prev) => {
      const next = prev.filter((item) => item.code !== code);
      removed = prev.length - next.length;
      if (removed > 0) saveAlerts(next);
      return next;
    });
    return removed > 0 ? `Alert ${code} dihapus` : `Tidak ada alert untuk ${code}`;
  }, []);

  const resetAlert = useCallback((id: string) => {
    setAlerts((prev) => {
      const next = prev.map((item) => (item.id === id ? { ...item, triggered: false } : item));
      saveAlerts(next);
      return next;
    });
  }, []);

  return {
    alerts,
    banner,
    dismissBanner: () => setBanner(""),
    addAlert,
    removeAlert,
    removeAlertsForCode,
    resetAlert,
  };
}

function cutDaily(daily: Row[], period: number) {
  const last = daily.at(-1);
  if (!last) return [];
  const date = new Date(last[0] * 1000 + 7 * 3600000);
  if (period === 5) return daily.filter(([time]) => time * 1000 >= Date.UTC(date.getUTCFullYear(), 0, 1) - 7 * 3600000);
  if (period === 7) {
    const groups = new Map<number, Row>();
    for (const [t, o, h, l, c, v] of daily) {
      const day = Math.floor((t + 7 * 3600) / secondsPerDay);
      const week = day - (day + 3) % 7;
      const existing = groups.get(week);
      if (existing) {
        existing[2] = Math.max(existing[2], h);
        existing[3] = Math.min(existing[3], l);
        existing[4] = c;
        if (v !== null) existing[5] = (existing[5] ?? 0) + v;
      } else groups.set(week, [t, o, h, l, c, v]);
    }
    return [...groups.values()];
  }
  const months = period === 2 ? 1 : period === 3 ? 3 : period === 4 ? 6 : 12;
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, monthEnd));
  return daily.filter(([time]) => time * 1000 >= date.getTime() - 7 * 3600000);
}

type CachedHistory = {
  bars: Candle[];
  source: string;
  session: HistoryBar | null;
  intraday: IntradayAverage | null;
  fetchedAt: number;
};

const clientHistoryCache = new Map<string, CachedHistory>();

export function useStockHistory(
  code: string,
  period: number,
  snapshot: MarketSnapshot,
  paused = false,
  refreshTick = 0,
) {
  const pageVisible = usePageVisible();
  const effectivePaused = paused || !pageVisible;
  const range = periodRanges[period];
  const isIndex = code === ihsg.code;
  const cacheKey = code + ":" + range;
  const hasStaticChart = isIndex || !!snapshot.charts[code];
  const version = snapshot.fetchedAt;

  const [state, setState] = useState<{
    key: string;
    loading: boolean;
    bars: Candle[];
    source: string;
    session: HistoryBar | null;
    intraday: IntradayAverage | null;
    error: string;
  }>(() => {
    const cached = clientHistoryCache.get(cacheKey);
    if (cached) {
      return {
        key: cacheKey,
        loading: false,
        bars: cached.bars,
        source: cached.source,
        session: cached.session,
        intraday: cached.intraday,
        error: "",
      };
    }
    if (isIndex) {
      return {
        key: cacheKey,
        loading: false,
        bars: indexHistory(period),
        source: "Yahoo Finance (snapshot)",
        session: null,
        intraday: null,
        error: "",
      };
    }
    return {
      key: cacheKey,
      loading: true,
      bars: [],
      source: "",
      session: null,
      intraday: null,
      error: "",
    };
  });

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    const loadStatic = async (sig: AbortSignal) => {
      if (isIndex) {
        const bars = indexHistory(period);
        setState({
          key: cacheKey,
          loading: false,
          bars,
          source: "Yahoo Finance (snapshot)",
          session: null,
          intraday: null,
          error: "",
        });
        return;
      }
      if (!hasStaticChart) {
        setState({
          key: cacheKey,
          loading: false,
          bars: [],
          source: "",
          session: null,
          intraday: null,
          error: "Riwayat emiten ini belum tersedia di mode statis.",
        });
        return;
      }
      const response = await fetch(
        base + "/market/" + encodeURIComponent(code) + ".json?v=" + version,
        { signal: sig },
      );
      if (!response.ok) throw new Error("Riwayat gagal dimuat.");
      const data = (await response.json()) as StaticStockHistory;
      if (data.code !== code) throw new Error("Riwayat gagal dimuat.");
      const rows = period === 0 ? data.intraday : period === 1 ? data.week : cutDaily(data.daily, period);
      const bars: Candle[] = rows.map(([time, open, high, low, close, volume]) => ({
        time: time * 1000,
        open,
        high,
        low,
        close,
        volume: volume ?? 0,
      }));
      if (!active) return;
      setState({
        key: cacheKey,
        loading: false,
        bars,
        source: data.source || "Yahoo Finance",
        session: null,
        intraday: null,
        error: "",
      });
    };

    const loadLive = async (force = false) => {
      const cached = clientHistoryCache.get(cacheKey);
      if (!force && cached && Date.now() - cached.fetchedAt < 60_000) {
        if (!active) return;
        setState({
          key: cacheKey,
          loading: false,
          bars: cached.bars,
          source: cached.source,
          session: cached.session,
          intraday: cached.intraday,
          error: "",
        });
        if (!effectivePaused) {
          const wait = Math.max(5_000, 60_000 - (Date.now() - cached.fetchedAt));
          timer = window.setTimeout(() => void loadLive(true), wait);
        }
        return;
      }

      controller?.abort();
      controller = new AbortController();
      const sig = controller.signal;

      if (!cached) {
        setState((prev) =>
          prev.key === cacheKey
            ? { ...prev, loading: true }
            : isIndex
              ? {
                  key: cacheKey,
                  loading: true,
                  bars: indexHistory(period),
                  source: "Yahoo Finance (snapshot)",
                  session: null,
                  intraday: null,
                  error: "",
                }
              : {
                  key: cacheKey,
                  loading: true,
                  bars: [],
                  source: "",
                  session: null,
                  intraday: null,
                  error: "",
                },
        );
      }

      try {
        const backend = await discoverBackend();
        if (!active) return;
        if (!backend.apiBase) {
          await loadStatic(sig);
          return;
        }
        const payload = await apiGet<LiveHistoryApiPayload>(
          backend.apiBase,
          `/stocks/${encodeURIComponent(code)}/history?range=${encodeURIComponent(range)}`,
          sig,
        );
        if (!active) return;
        const bars: Candle[] = payload.bars.map((bar) => ({
          time: bar.t * 1000,
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
          volume: bar.v ?? 0,
        }));
        const entry: CachedHistory = {
          bars,
          source: payload.source || "Yahoo Finance",
          session: payload.session ?? null,
          intraday: payload.intraday ?? null,
          fetchedAt: Date.now(),
        };
        if (clientHistoryCache.size >= 64 && !clientHistoryCache.has(cacheKey)) {
          const oldest = clientHistoryCache.keys().next().value;
          if (oldest !== undefined) clientHistoryCache.delete(oldest);
        }
        clientHistoryCache.set(cacheKey, entry);
        setState({
          key: cacheKey,
          loading: false,
          bars,
          source: entry.source,
          session: entry.session,
          intraday: entry.intraday,
          error: "",
        });
      } catch (err) {
        if (!active || sig.aborted) return;
        if (cached) {
          setState({
            key: cacheKey,
            loading: false,
            bars: cached.bars,
            source: cached.source + " / cache",
            session: cached.session,
            intraday: cached.intraday,
            error: err instanceof Error ? err.message : "Gagal memuat riwayat",
          });
        } else if (hasStaticChart) {
          try {
            await loadStatic(sig);
          } catch {
            if (!active) return;
            setState({
              key: cacheKey,
              loading: false,
              bars: [],
              source: "",
              session: null,
              intraday: null,
              error: err instanceof Error ? err.message : "Riwayat gagal dimuat.",
            });
          }
        } else {
          setState({
            key: cacheKey,
            loading: false,
            bars: [],
            source: "",
            session: null,
            intraday: null,
            error: err instanceof Error ? err.message : "Riwayat gagal dimuat.",
          });
        }
      }

      if (active && !effectivePaused) {
        timer = window.setTimeout(() => void loadLive(true), 60_000);
      }
    };

    const cached = clientHistoryCache.get(cacheKey);
    const delay = refreshTick > 0 || cached ? 0 : 250;
    timer = window.setTimeout(() => void loadLive(refreshTick > 0), delay);

    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [code, period, range, cacheKey, hasStaticChart, isIndex, version, effectivePaused, refreshTick]);

  const current = state.key === cacheKey ? state : null;
  const bars = current?.bars ?? [];
  const last = bars.at(-1);
  return {
    bars,
    source: current?.source ?? "",
    session: current?.session ?? null,
    intraday: current?.intraday ?? null,
    lastDate: last ? tradeDateFormat.format(last.time) : null,
    message:
      !current || current.loading
        ? "Memuat grafik…"
        : current.error && !bars.length
          ? current.error
          : bars.length
            ? ""
            : "Riwayat tidak tersedia untuk " + periods[period].label + ".",
  };
}

export function useRunningTrades(
  code: string | null,
  enabled: boolean,
  paused: boolean,
  refreshTick: number,
) {
  const pageVisible = usePageVisible();
  const effectivePaused = paused || !pageVisible;
  const [state, setState] = useState<{
    code: string;
    data: TradesPayload | null;
    error: string;
    loading: boolean;
  }>({ code: "", data: null, error: "", loading: false });

  useEffect(() => {
    if (!enabled || !code || code === ihsg.code) return;
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    const run = async () => {
      controller?.abort();
      controller = new AbortController();
      const sig = controller.signal;
      setState((prev) =>
        prev.code === code
          ? { ...prev, loading: true }
          : { code, data: null, error: "", loading: true },
      );

      let failed = false;
      try {
        const backend = await discoverBackend();
        if (!active) return;
        if (!backend.apiBase) {
          setState({
            code,
            data: null,
            error: "Running Trade memerlukan server API aktif dan INVEZGO_API_KEY.",
            loading: false,
          });
          return;
        }
        const data = await apiGet<TradesPayload>(
          backend.apiBase,
          `/stocks/${encodeURIComponent(code)}/trades`,
          sig,
        );
        if (!active) return;
        setState({ code, data, error: "", loading: false });
      } catch (err) {
        if (!active || sig.aborted) return;
        failed = true;
        const message = err instanceof Error ? err.message : "Gagal memuat Running Trade";
        setState((prev) => ({
          code,
          data: prev.code === code ? prev.data : null,
          error: message,
          loading: false,
        }));
      }

      if (active && !effectivePaused) {
        timer = window.setTimeout(() => void run(), failed ? 25_000 : 10_000);
      }
    };

    timer = window.setTimeout(() => void run(), refreshTick > 0 ? 0 : 250);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [code, enabled, effectivePaused, refreshTick]);

  const current = code && state.code === code ? state : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? "",
    loading: current?.loading ?? false,
  };
}

export function mergeStockDetail(params: {
  row: Quote | undefined;
  snapshot: MarketSnapshot;
  liveEntry: LiveQuoteEntry | undefined;
  historySession: HistoryBar | null;
  historyIntraday: IntradayAverage | null;
  historySource: string;
  nowMs: number;
}): MergedDetail {
  const { row, snapshot, liveEntry, historySession, historyIntraday, historySource, nowMs } = params;
  const live = liveEntry?.data ?? null;
  const price = live?.price ?? row?.price ?? null;
  const change = live?.changePercent ?? row?.change ?? null;
  const liveDate = quoteSessionDate(live);
  const tradeDate = live ? liveDate : row?.date ?? "";
  const dayLabel = tradeDate.length === 10 ? tradeDate.slice(8, 10) + "/" + tradeDate.slice(5, 7) : "";
  const sameSession = Boolean(row && tradeDate && row.date === tradeDate);
  const snapshotField = <K extends keyof Quote>(key: K): number | null => {
    if (!sameSession || !row) return null;
    const val = row[key];
    return typeof val === "number" && Number.isFinite(val) ? val : null;
  };

  let previous = live?.previous ?? snapshotField("previous");
  if (previous === null && !live && row) previous = row.previous;
  const delta =
    live?.change != null
      ? live.change
      : price !== null && previous !== null
        ? price - previous
        : null;

  const pulse =
    liveEntry && liveEntry.move && liveEntry.move !== 0 && nowMs > 0 && nowMs < liveEntry.flashUntil
      ? liveEntry.move
      : null;

  const dailyBar =
    historySession && tradeDate && wibDateOf(historySession.t) === tradeDate ? historySession : null;

  let open: number | null = live?.open ?? null;
  let high: number | null = live?.high ?? null;
  let low: number | null = live?.low ?? null;
  let ohlcSource = live && (open !== null || high !== null || low !== null) ? live.source : "";

  if (open === null && high === null && low === null) {
    open = snapshotField("open");
    high = snapshotField("high");
    low = snapshotField("low");
    if (open !== null || high !== null || low !== null) ohlcSource = snapshot.source;
  }
  if (open === null && high === null && low === null && dailyBar) {
    open = dailyBar.o;
    high = dailyBar.h;
    low = dailyBar.l;
    ohlcSource = historySource.replace(/ \/ cache$/, "");
  }

  const volume = (live ? live.volume : snapshotField("volume")) ?? snapshotField("volume");
  const tradedValue = live?.value ?? null;
  const snapshotValue = snapshotField("value");
  const value = tradedValue ?? snapshotValue;

  let average: number | null =
    tradedValue && live?.volume && tradedValue > 0 && live.volume > 0
      ? tradedValue / live.volume
      : snapshotValue && snapshotField("volume") && snapshotValue > 0 && (snapshotField("volume") ?? 0) > 0
        ? snapshotValue / (snapshotField("volume") as number)
        : null;
  let estimatedAverage = false;
  let averageThrough: number | null = null;
  if (average === null && historyIntraday && historyIntraday.date === tradeDate) {
    average = historyIntraday.average;
    estimatedAverage = true;
    averageThrough = historyIntraday.through;
  }

  const earlierAverage =
    row && !sameSession && average === null && row.value && row.volume && row.value > 0 && row.volume > 0
      ? row.value / row.volume
      : null;

  return {
    price,
    previous,
    change,
    delta,
    pulse,
    tradeDate,
    dayLabel,
    liveSource: live ? live.source : null,
    marketTime: live?.marketTime ?? null,
    fetchedAt: live?.fetchedAt ?? null,
    cached: Boolean(liveEntry?.error),
    open,
    high,
    low,
    ohlcSource,
    volume,
    value,
    average,
    estimatedAverage,
    averageThrough,
    earlierAverage,
    earlierDate: row?.date ?? "",
    ara: live?.ara ?? null,
    arb: live?.arb ?? null,
    board: live?.board ?? "",
    bid: live?.bid ?? null,
    offer: live?.offer ?? null,
    frequency: snapshotField("frequency") ?? (!live ? (row?.frequency ?? null) : null),
    cap: row?.cap ?? null,
    per: row?.per ?? null,
    pbr: row?.pbr ?? null,
  };
}

export function resolveIndexMetrics(
  quote: LiveQuote,
  historySession: HistoryBar | null,
): readonly (readonly [string, number | null])[] {
  const tradeDate = quoteSessionDate(quote);
  const sameDayBar =
    historySession && (!tradeDate || wibDateOf(historySession.t) === tradeDate) ? historySession : null;
  const open = quote.open ?? sameDayBar?.o ?? null;
  let high = quote.high ?? sameDayBar?.h ?? null;
  let low = quote.low ?? sameDayBar?.l ?? null;
  if (high !== null && quote.price > high) high = quote.price;
  if (low !== null && quote.price < low) low = quote.price;
  return [
    ["Buka", open],
    ["High", high],
    ["Low", low],
    ["Prev", quote.previous ?? null],
  ] as const;
}
