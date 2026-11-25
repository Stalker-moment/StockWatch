"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import ClassicChart, { type ClassicIndicator } from "./classic-chart";
import {
  mergeStockDetail,
  quoteSessionDate,
  resolveIndexMetrics,
  useLiveQuotes,
  useMarketQuotes,
  usePriceAlerts,
  useRunningTrades,
  useStockHistory,
  type LiveQuoteEntry,
} from "../lib/use-market";
import ClassicMenu from "./classic-menu";
import ClassicTouchKeys, { backspaceKey, editWithKey, enterKey, escapeKey, keyboardKey, type TouchKey } from "./classic-touch-keys";
import {
  compact,
  compareMetric,
  formatClockWib,
  formatHmWib,
  formatIndexTime,
  formatQuoteTime,
  ihsg,
  initialWatchlist,
  integer,
  matchesIndex,
  percent,
  periods,
  points,
  rupiah,
  summarize,
  wib,
  type LiveQuote,
  type MarketSnapshot,
  type Quote,
  type Stock,
} from "../lib/market";
import { readWatchlist, saveWatchlist, type PriceAlert } from "../lib/watchlist";

type View = "market" | "watchlist" | "detail" | "trades";
const tabs: { view: View; key: string; name: string }[] = [
  { view: "market", key: "1", name: "Pasar" }, { view: "watchlist", key: "2", name: "Watchlist" },
  { view: "detail", key: "3", name: "Detail" }, { view: "trades", key: "4", name: "Running Trade" },
];
const orders = ["Kode", "Naik", "Turun", "Nilai"];
const indicatorCycle: ClassicIndicator[] = ["none", "ma5", "ma20", "prev"];
const indicatorLabels: Record<ClassicIndicator, string> = { none: "Off", ma5: "MA5", ma20: "MA20", prev: "PREV" };
const dateFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: wib, year: "numeric", month: "2-digit", day: "2-digit" });
const clockFormat = new Intl.DateTimeFormat("en-GB", { timeZone: wib, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const averageFormat = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lotsFormat = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
const upKey: TouchKey = { value: "arrowup", text: "↑", label: "Emiten sebelumnya" };
const downKey: TouchKey = { value: "arrowdown", text: "↓", label: "Emiten berikutnya" };
const findKey: TouchKey = { value: "/", text: "/", label: "Cari emiten" };
const periodKey: TouchKey = { value: "p", text: "P", label: "Buka pilihan periode", caption: "Periode" };

function tone(change: number | null | undefined) {
  if (change == null) return "cmd-muted";
  return change > 0 ? "cmd-green" : change < 0 ? "cmd-red" : "cmd-muted";
}

function Rule({ children }: { children: string }) {
  return <h2 className="cmd-rule"><span>{children}</span></h2>;
}

function Detail({
  stock,
  data,
  snapshot,
  liveEntry,
  stockAlerts,
  period,
  indicator,
  columns,
  height,
  paused,
  refreshTick,
  nowMs,
  onPeriod,
  onToggleIndicator,
}: {
  stock: Stock;
  data: Quote | undefined;
  snapshot: MarketSnapshot;
  liveEntry: LiveQuoteEntry | undefined;
  stockAlerts: PriceAlert[];
  period: number;
  indicator: ClassicIndicator;
  columns: number;
  height: number;
  paused: boolean;
  refreshTick: number;
  nowMs: number;
  onPeriod: (value: number) => void;
  onToggleIndicator: () => void;
}) {
  const { bars, source, session, intraday, lastDate, message } = useStockHistory(
    stock.code,
    period,
    snapshot,
    paused,
    refreshTick,
  );
  const merged = mergeStockDetail({
    row: data,
    snapshot,
    liveEntry,
    historySession: session,
    historyIntraday: intraday,
    historySource: source,
    nowMs,
  });

  const range = periods[period];
  const interval = range.interval === "1 hari" ? "HARIAN" : range.interval === "1 minggu" ? "MINGGUAN" : range.interval.toUpperCase() + " WIB";
  const quoteStamp = merged.liveSource
    ? (merged.cached ? "CACHE " : "") +
      merged.liveSource +
      (merged.marketTime ? " " + formatQuoteTime(merged.marketTime) + " WIB" : merged.dayLabel ? " " + merged.dayLabel : "") +
      (merged.fetchedAt && !merged.cached ? " | Ambil " + formatClockWib(merged.fetchedAt) : "")
    : merged.price !== null
      ? "Snapshot " + snapshot.source + (merged.dayLabel ? " " + merged.dayLabel : "")
      : "Kuotasi belum tersedia";

  const sessionLine =
    "Sesi " +
    (merged.dayLabel || "--") +
    (merged.ohlcSource ? " | OHLC " + merged.ohlcSource : "") +
    (merged.estimatedAverage && merged.averageThrough
      ? " | AVG~ Yahoo 1m " + formatHmWib(merged.averageThrough)
      : merged.average !== null
        ? " | AVG " + snapshot.source
        : "");

  const extraLines =
    1 +
    (merged.ara !== null || merged.arb !== null || merged.board ? 1 : 0) +
    (merged.earlierAverage !== null && merged.earlierDate.length === 10 ? 1 : 0) +
    (stockAlerts.length > 0 ? 1 : 0);

  return (
    <div className="cmd-detail">
      <div className="cmd-line cmd-cyan">{stock.code} {stock.sector && " / " + stock.sector}</div>
      <div className={"cmd-line " + tone(merged.pulse ?? merged.change)}>
        <b>{rupiah(merged.price)}</b>   {percent(merged.change)}
        {merged.delta !== null && merged.delta !== 0 && ("   " + (merged.delta > 0 ? "+" : "−") + rupiah(Math.abs(merged.delta)))}
        {merged.pulse !== null && (merged.pulse > 0 ? "  ↑" : "  ↓")}
      </div>
      <div className={"cmd-line " + (merged.cached ? "cmd-amber" : merged.liveSource ? "cmd-teal" : "cmd-muted")}>
        {quoteStamp}
      </div>
      <div className="cmd-line cmd-company">{stock.name}</div>
      <div className="cmd-metric cmd-line">
        <span>BUKA {rupiah(merged.open)}</span>
        <span>HIGH {rupiah(merged.high)}</span>
        <span>LOW {rupiah(merged.low)}</span>
      </div>
      <div className="cmd-metric cmd-line cmd-amber">
        <span>ARA* {rupiah(merged.ara)}</span>
        <span>ARB* {rupiah(merged.arb)}</span>
        <span>PREV {rupiah(merged.previous)}</span>
      </div>
      <div className="cmd-metric cmd-line cmd-muted">
        <span>{merged.estimatedAverage ? "AVG~ " : "AVG "}{merged.average === null ? "--" : "Rp" + averageFormat.format(merged.average)}</span>
        <span>VOL {compact(merged.volume)}</span>
        <span>NILAI {compact(merged.value)}</span>
      </div>
      <div className="cmd-metric cmd-line cmd-muted">
        <span>BID {rupiah(merged.bid)}</span>
        <span>OFFER {rupiah(merged.offer)}</span>
        <span>FREQ {compact(merged.frequency)}</span>
      </div>
      <div className="cmd-line cmd-teal">{sessionLine}</div>
      {(merged.ara !== null || merged.arb !== null) ? (
        <div className="cmd-line cmd-amber">* Estimasi BEI dari PREV{merged.board ? " | " + merged.board : ""}</div>
      ) : merged.board ? (
        <div className="cmd-line cmd-muted">{merged.board} | Batas harga belum tersedia</div>
      ) : null}
      {merged.earlierAverage !== null && merged.earlierDate.length === 10 && (
        <div className="cmd-line cmd-muted">
          AVG {merged.earlierDate.slice(8, 10)}/{merged.earlierDate.slice(5, 7)} Rp{averageFormat.format(merged.earlierAverage)} | {snapshot.source}
        </div>
      )}
      <div className="cmd-metric cmd-line cmd-muted">
        <span>KAP {compact(merged.cap)}</span>
        <span>PER {merged.per === null ? "--" : points(merged.per) + "x"}</span>
        <span>PBV {merged.pbr === null ? "--" : points(merged.pbr) + "x"}</span>
      </div>
      {stockAlerts.length > 0 && (
        <div className="cmd-line cmd-amber">
          Alert {stockAlerts.map((a) => `${a.above ? "≥" : "≤"}${rupiah(a.target)}${a.triggered ? "*" : ""}`).join(", ")}
        </div>
      )}
      <div className="cmd-periods" role="group" aria-label="Periode grafik">
        {periods.map((item, index) => <button key={item.label} type="button" aria-pressed={index === period}
          onClick={() => onPeriod(index)}>{item.label}</button>)}
        <button type="button" className="cmd-ind-btn" aria-pressed={indicator !== "none"} onClick={onToggleIndicator}>
          T:{indicatorLabels[indicator]}
        </button>
      </div>
      <div className="cmd-line cmd-teal">
        OHLC {interval}{indicator !== "none" ? ` [${indicatorLabels[indicator]}]` : ""}{source && "   " + source}{lastDate && " | " + lastDate}
      </div>
      {bars.length ? (
        <ClassicChart
          bars={bars}
          columns={columns}
          rows={Math.max(5, height - 11 - extraLines)}
          period={period}
          code={stock.code}
          indicator={indicator}
          previous={merged.previous}
        />
      ) : (
        <div className="cmd-muted" role="status">{message}</div>
      )}
    </div>
  );
}

function IndexDetail({
  quote,
  entry,
  snapshot,
  period,
  indicator,
  columns,
  height,
  paused,
  refreshTick,
  nowMs,
  onPeriod,
  onToggleIndicator,
}: {
  quote: LiveQuote;
  entry: LiveQuoteEntry | undefined;
  snapshot: MarketSnapshot;
  period: number;
  indicator: ClassicIndicator;
  columns: number;
  height: number;
  paused: boolean;
  refreshTick: number;
  nowMs: number;
  onPeriod: (value: number) => void;
  onToggleIndicator: () => void;
}) {
  const { bars, source, session, lastDate, message } = useStockHistory(ihsg.code, period, snapshot, paused, refreshTick);
  const pulse = entry && entry.move && entry.move !== 0 && nowMs > 0 && nowMs < entry.flashUntil ? entry.move : null;
  const cached = Boolean(entry?.error);
  const metrics = resolveIndexMetrics(quote, session);
  const stamp =
    (cached ? "CACHE " : "") +
    quote.source +
    (quote.marketTime ? " | " + formatIndexTime(quote.marketTime) + " WIB" : quote.date ? " | " + quote.date : "") +
    (quote.fetchedAt && !cached ? " | Ambil " + formatClockWib(quote.fetchedAt) : "");

  return (
    <div className="cmd-detail">
      <div className="cmd-line cmd-cyan">IHSG / IDX Composite</div>
      <div className={"cmd-line " + tone(pulse ?? quote.changePercent)}>
        <b>{points(quote.price)} poin</b>   {percent(quote.changePercent)}
        {quote.change != null && quote.change !== 0 && ("   " + (quote.change > 0 ? "+" : "−") + points(Math.abs(quote.change)))}
        {pulse !== null && (pulse > 0 ? "  ↑" : "  ↓")}
      </div>
      <div className={"cmd-line " + (cached ? "cmd-amber" : "cmd-teal")}>{stamp}</div>
      <div className="cmd-line cmd-company">{ihsg.name}</div>
      <div className="cmd-index-metrics">
        {metrics.map(([label, value]) => <span key={label}>{label.toUpperCase()} {points(value)}</span>)}
      </div>
      <div className="cmd-periods" role="group" aria-label="Periode grafik">
        {periods.map((item, i) => <button type="button" key={item.label} aria-pressed={i === period}
          onClick={() => onPeriod(i)}>{item.label}</button>)}
        <button type="button" className="cmd-ind-btn" aria-pressed={indicator !== "none"} onClick={onToggleIndicator}>
          T:{indicatorLabels[indicator]}
        </button>
      </div>
      <div className="cmd-line cmd-teal">
        OHLC {periods[period].interval.toUpperCase()}{indicator !== "none" ? ` [${indicatorLabels[indicator]}]` : ""} | {source || "Yahoo Finance"}{lastDate ? " | " + lastDate : ""}
      </div>
      {bars.length ? (
        <ClassicChart
          bars={bars}
          columns={columns}
          rows={Math.max(5, height - 9)}
          period={period}
          code={ihsg.code}
          indicator={indicator}
          previous={quote.previous}
        />
      ) : (
        <div className="cmd-muted" role="status">{message}</div>
      )}
    </div>
  );
}

function TradeTape({
  stock,
  paused,
  refreshTick,
}: {
  stock: Stock | undefined;
  paused: boolean;
  refreshTick: number;
}) {
  const isIndex = stock?.code === ihsg.code;
  const { data, error, loading } = useRunningTrades(stock?.code ?? null, Boolean(stock && !isIndex), paused, refreshTick);

  if (!stock) return <div className="cmd-line cmd-indent cmd-muted">Pilih saham untuk melihat transaksi.</div>;
  if (isIndex) return <div className="cmd-line cmd-indent">Pilih emiten untuk melihat transaksi saham.</div>;

  return (
    <>
      <div className="cmd-line cmd-indent cmd-cyan">
        {stock.code}  |  INVEZGO{data ? "  |  " + data.date + "  |  Ambil " + formatClockWib(data.fetchedAt) + " WIB" : ""}
      </div>
      {error && (
        <div className="cmd-line cmd-indent cmd-amber">
          {error}{data ? "  |  CACHE" : ""}
        </div>
      )}
      {!data ? (
        !error && <div className="cmd-line cmd-indent cmd-muted">{paused ? "Pembaruan transaksi dijeda." : loading ? "Memuat transaksi…" : "Memuat transaksi…"}</div>
      ) : !data.trades.length ? (
        <div className="cmd-line cmd-indent cmd-muted">Belum ada transaksi untuk tanggal ini.</div>
      ) : (
        <>
          <div className="cmd-tape cmd-tape-head cmd-line">
            <span>WAKTU WIB</span><span>HARGA</span><span>LOT</span><span>SIDE</span><span>PASAR</span><span>BUYER</span><span>SELLER</span>
          </div>
          {data.trades.map((trade, idx) => {
            const lots = trade.shares / 100;
            const sideTone = trade.side === "BUY" ? "cmd-green" : trade.side === "SELL" ? "cmd-red" : "cmd-muted";
            return (
              <div key={`${trade.time}-${idx}`} className={"cmd-tape cmd-line" + (idx % 2 ? " cmd-tape-alt" : "")}>
                <span>{trade.time}</span>
                <span>{rupiah(trade.price)}</span>
                <span>{lotsFormat.format(lots)}</span>
                <span className={sideTone}>{trade.side}</span>
                <span className="cmd-muted">{trade.board || "--"}</span>
                <span className="cmd-muted">{trade.buyer || "--"}</span>
                <span className="cmd-muted">{trade.seller || "--"}</span>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

export default function ClassicTerminal() {
  const [view, setView] = useState<View>("market");
  const [board, setBoard] = useState<"market" | "watchlist">("market");
  const [period, setPeriod] = useState(2);
  const [indicatorIdx, setIndicatorIdx] = useState(0);
  const [order, setOrder] = useState(0);
  const [sector, setSector] = useState("");
  const [chosen, setChosen] = useState("AADI");
  const [first, setFirst] = useState(0);
  const [query, setQuery] = useState("");
  const [committed, setCommitted] = useState("");
  const [origin, setOrigin] = useState("");
  const [searching, setSearching] = useState(false);
  const [editingAlert, setEditingAlert] = useState(false);
  const [alertInput, setAlertInput] = useState("");
  const [picking, setPicking] = useState(false);
  const [moreKeys, setMoreKeys] = useState(false);
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<"dashboard" | "menu" | "closed">("dashboard");
  const [paused, setPaused] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [now, setNow] = useState(0);
  const [dimensions, setDimensions] = useState({ cols: 100, rows: 40 });
  const [watchlist, setWatchlist] = useState(initialWatchlist);
  const screen = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const alertField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const initial = Date.now();
    setNow(initial);
    setWatchlist(readWatchlist());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!screen.current || !ruler.current || !body.current) return;
    const node = screen.current;
    const measure = () => {
      if (!ruler.current || !body.current) return;
      const size = ruler.current.getBoundingClientRect();
      const cols = Math.floor((node.clientWidth - 16) / (size.width / 10));
      const rows = Math.floor(body.current.clientHeight / size.height);
      setDimensions((value) => value.cols === cols && value.rows === rows ? value : { cols, rows });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(body.current);
    observer.observe(ruler.current);
    measure();
    return () => observer.disconnect();
  }, [mode]);

  useEffect(() => { if (searching) input.current?.focus(); }, [searching]);
  useEffect(() => { if (editingAlert) alertField.current?.focus(); }, [editingAlert]);

  const inactive = paused || mode === "closed";
  const { snapshot, prices, stockList, sectors, checked, refresh, error, mode: apiMode, autoSeconds } = useMarketQuotes(inactive);
  const summary = useMemo(() => summarize(snapshot), [snapshot]);
  const shownView = searching ? "market" : view;
  const activeBoard = searching ? "market" : board;
  const searchText = (searching ? query : activeBoard === "market" ? committed : "").trim().toLowerCase();
  const visible = useMemo(() => {
    const terms = searchText.replace(/\.jk$/, "").split(/\s+/).filter(Boolean);
    const matches = stockList.filter((stock) =>
      (activeBoard === "market" || watchlist.includes(stock.code)) &&
      (activeBoard !== "market" || !sector || stock.sector === sector) &&
      terms.every((term) => (stock.code + " " + stock.name + " " + (stock.sector ?? "")).toLowerCase().includes(term)));
    matches.sort((a, b) => {
      if (searchText && (searching || order === 0)) {
        const rank = (item: Stock) => item.code.toLowerCase() === searchText.replace(/\.jk$/, "") ? 0 :
          item.code.toLowerCase().startsWith(searchText) ? 1 : item.name.toLowerCase().startsWith(searchText) ? 2 : 3;
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
      }
      const firstRow = prices.get(a.code), secondRow = prices.get(b.code);
      return (order === 1 || order === 2 ? compareMetric(firstRow?.change, secondRow?.change, order === 2) :
        order === 3 ? compareMetric(firstRow?.value, secondRow?.value) : 0) || a.code.localeCompare(b.code);
    });
    if (activeBoard === "market" && !sector && matchesIndex(searchText)) matches.unshift(ihsg);
    return matches;
  }, [searchText, activeBoard, sector, order, prices, searching, stockList, watchlist]);
  const index = Math.max(0, visible.findIndex((item) => item.code === chosen));
  const stock = visible[index];
  const isIndex = stock?.code === ihsg.code;
  const current = stock ? prices.get(stock.code) : undefined;
  const batchCodes = useMemo(() => (activeBoard === "watchlist" ? watchlist : []), [activeBoard, watchlist]);

  const { liveQuotes, indexEntry, liveIndexQuote, marketStatus, fetchOneQuote, fetchCompare } = useLiveQuotes(
    !searching && stock ? stock.code : null,
    inactive,
    refreshTick,
    batchCodes,
  );
  const { alerts, banner: alertBanner, dismissBanner, addAlert, removeAlert, removeAlertsForCode } = usePriceAlerts(
    liveQuotes,
    prices,
  );

  const indicator = indicatorCycle[indicatorIdx];
  const split = dimensions.cols >= 104;
  const detailHeight = split || shownView === "detail" ? Math.max(17, dimensions.rows - 1) : 22;
  const leftColumns = split ? Math.floor(dimensions.cols * .55) : dimensions.cols;
  const rightColumns = split && shownView !== "detail" ? dimensions.cols - leftColumns - 3 : dimensions.cols;
  const pageSize = split ? Math.max(3, dimensions.rows - 2) : Math.max(5, Math.min(12, Math.floor(dimensions.rows / 3)));
  const start = Math.max(0, Math.min(Math.max(first, index - pageSize + 1), index, visible.length - 1));
  const items = visible.slice(start, start + pageSize);
  const remainder = now ? Math.min(autoSeconds, Math.max(0, Math.ceil((checked + autoSeconds * 1000 - now) / 1000))) : autoSeconds;
  const todayWib = now ? dateFormat.format(now) : "";
  const apiBadge =
    apiMode === "cpp"
      ? "API C++ lokal (Stockbit / Yahoo / Pasardana)"
      : apiMode === "next" || apiMode === "remote"
        ? "Live API (Stockbit / Yahoo / Pasardana)"
        : "Versi web terminal C++ (mode snapshot)";
  const stockAlerts = useMemo(
    () => (stock ? alerts.filter((a) => a.code === stock.code) : []),
    [alerts, stock],
  );

  function changeView(next: View) {
    setSearching(false);
    setEditingAlert(false);
    setPicking(false);
    if (next === "market" || next === "watchlist") {
      const target = next;
      if (board !== target) {
        setFirst(0);
        setChosen("");
      }
      setBoard(target);
    }
    setView(next);
    screen.current?.focus({ preventScroll: true });
  }

  function openIndex() {
    setCommitted("");
    setSector("");
    setBoard("market");
    setChosen(ihsg.code);
    setFirst(0);
    changeView("detail");
  }

  function cycleSector() {
    if (!sectors.length) {
      setSector("");
      return;
    }
    setSector((prev) => {
      if (!prev) return sectors[0];
      const idx = sectors.indexOf(prev);
      return idx < 0 || idx + 1 >= sectors.length ? "" : sectors[idx + 1];
    });
    setFirst(0);
    setChosen("");
  }

  function cycleIndicator() {
    setIndicatorIdx((value) => (value + 1) % indicatorCycle.length);
  }

  function beginSearch() {
    setOrigin(stock?.code ?? "");
    setQuery("");
    setFirst(0);
    setNotice("");
    setEditingAlert(false);
    setSearching(true);
  }

  function finishSearch(save: boolean) {
    if (save) {
      setCommitted(query.trim());
      setBoard("market");
      setView("market");
      setChosen(stock?.code ?? "");
    } else setChosen(origin);
    setSearching(false);
  }

  function beginAlert() {
    if (!stock || isIndex) {
      setNotice("Price alert tersedia untuk emiten saham");
      return;
    }
    setSearching(false);
    setPicking(false);
    setAlertInput("");
    setNotice("");
    setEditingAlert(true);
  }

  function submitAlert() {
    setEditingAlert(false);
    if (!stock || isIndex) return;
    let raw = alertInput.trim();
    setAlertInput("");
    if (!raw) {
      setNotice(removeAlertsForCode(stock.code));
      return;
    }
    let above: boolean | null = null;
    if (raw.startsWith(">") || raw.startsWith("<")) {
      above = raw[0] === ">";
      raw = raw.slice(1).replace(/^=/, "").trim();
    }
    const target = Number(raw.replace(",", "."));
    if (!Number.isFinite(target) || target <= 0 || target > 1_000_000_000) {
      setNotice("Format alert tidak valid (contoh >6000 atau <5500)");
      return;
    }
    const currentPrice = liveQuotes[stock.code]?.data.price ?? current?.price ?? null;
    const isAbove = above ?? (currentPrice === null || target >= currentPrice);
    setNotice(addAlert(stock.code, target, isAbove));
    screen.current?.focus({ preventScroll: true });
  }

  function move(offset: number) {
    if (!visible.length) return;
    const next = Math.max(0, Math.min(visible.length - 1, index + offset));
    setChosen(visible[next].code);
    if (next < start) setFirst(next);
    else if (next >= start + pageSize) setFirst(next - pageSize + 1);
    setNotice("");
  }

  function toggleWatch(code: string) {
    if (code === ihsg.code) return "IHSG selalu ada di tab Pasar";
    const exists = watchlist.includes(code);
    if (!exists && watchlist.length >= 8) return "Watchlist penuh (maksimal 8 saham)";
    const values = exists ? watchlist.filter((value) => value !== code) : [...watchlist, code];
    setWatchlist(values);
    saveWatchlist(values);
    return exists ? code + " keluar dari watchlist" : code + " masuk watchlist";
  }

  function reload() {
    setPaused(false);
    setRefreshTick((value) => value + 1);
    void refresh(true);
  }

  function choosePeriod(value: number) {
    if (shownView === "trades") changeView("detail");
    setPeriod(value);
    setPicking(false);
  }

  function handleKey(key: string) {
    if (editingAlert) {
      if (key === "escape") { setEditingAlert(false); setAlertInput(""); return true; }
      return false;
    }
    if (key === "arrowup" || key === "arrowdown") move(key === "arrowup" ? -1 : 1);
    else if (key === "pageup" || key === "pagedown") move(key === "pageup" ? -pageSize : pageSize);
    else if (key === "home" || key === "end") move(key === "home" ? -visible.length : visible.length);
    else if (searching) {
      if (key === "enter" || key === "escape") finishSearch(key === "enter");
      else return false;
    } else if (picking) {
      if (/^[1-8]$/.test(key)) choosePeriod(Number(key) - 1);
      else if (key === "p" || key === "escape") setPicking(false);
      else return false;
    } else {
      const tab = tabs.find((tab) => tab.key === key);
      if (tab) changeView(tab.view);
      else if (key === "w") changeView("watchlist");
      else if (key === "i") openIndex();
      else if (key === "/") beginSearch();
      else if (key === "f") { if (board === "market") cycleSector(); }
      else if (key === "t") cycleIndicator();
      else if (key === "l") beginAlert();
      else if (key === "s") { setOrder((value) => (value + 1) % orders.length); setFirst(0); setChosen(""); }
      else if (key === "a") { if (stock) setNotice(toggleWatch(stock.code)); }
      else if (key === "p") setPicking(true);
      else if (key === "h") choosePeriod((period + 1) % periods.length);
      else if (key === "r") reload();
      else if (key === " ") setPaused((value) => !value);
      else if (key === "m") setMode("menu");
      else if (key === "q") setMode("closed");
      else if (key === "enter") changeView(view === "detail" || view === "trades" ? board : "detail");
      else if (key === "escape") {
        if (alertBanner) dismissBanner();
        else if (view === "detail" || view === "trades") changeView(board);
        else if (board === "market" && (committed || sector)) { setCommitted(""); setSector(""); setFirst(0); setChosen(""); }
        else setMode("closed");
      } else return false;
    }
    return true;
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (mode !== "dashboard" || event.defaultPrevented || event.isComposing || event.altKey || event.metaKey || event.ctrlKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && target !== input.current && target !== alertField.current && target.closest("input,textarea,select,[contenteditable]")) return;
      if ((event.key === " " || event.key === "Enter") && target?.closest("a,button")) return;
      if (handleKey(event.key.toLowerCase())) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function updateQuery(value: string) {
    setQuery(value);
    setFirst(0);
    setChosen("");
  }

  function touchKey(key: string) {
    if (key === "more") setMoreKeys((value) => !value);
    else if (key === "keyboard") (editingAlert ? alertField.current : input.current)?.focus();
    else if (key === "backspace" && searching) editWithKey(input.current, query, key, updateQuery);
    else if (key === "backspace" && editingAlert) editWithKey(alertField.current, alertInput, key, setAlertInput);
    else if (key === "enter" && editingAlert) submitAlert();
    else if (key === "/" && !searching && !picking && !editingAlert) {
      flushSync(beginSearch);
      input.current?.focus();
    } else if (key === "l" && !searching && !picking && !editingAlert) {
      flushSync(beginAlert);
      alertField.current?.focus();
    } else handleKey(key);
  }

  const touchRows: TouchKey[][] = searching || editingAlert ? [
    [escapeKey, upKey, downKey, backspaceKey, keyboardKey, enterKey],
  ] : picking ? [
    periods.slice(0, 6).map((item, index) => ({ value: String(index + 1), text: String(index + 1),
      label: "Periode " + item.label, caption: item.label })),
    [
      ...periods.slice(6).map((item, index) => ({ value: String(index + 7), text: String(index + 7),
        label: "Periode " + item.label, caption: item.label })),
      escapeKey,
    ],
  ] : [
    [escapeKey, findKey, upKey, downKey, enterKey, { value: "more", text: "…", label: "Tombol tambahan", pressed: moreKeys }],
    [
      ...tabs.map((tab) => ({ value: tab.key, text: tab.key, label: "Buka " + tab.name,
        caption: tab.view === "trades" ? "Trade" : tab.view === "watchlist" ? "Watch" : tab.name, pressed: view === tab.view })),
      periodKey, { value: "m", text: "M", label: "Buka menu terminal", caption: "Menu" },
    ],
    ...(moreKeys ? [[
      { value: "home", text: "Home", label: "Emiten pertama" },
      { value: "pageup", text: "PgUp", label: "Halaman emiten sebelumnya" },
      { value: "pagedown", text: "PgDn", label: "Halaman emiten berikutnya" },
      { value: "end", text: "End", label: "Emiten terakhir" },
      { value: "f", text: "F", label: "Filter sektor", caption: "Sektor" },
      { value: "s", text: "S", label: "Ubah urutan", caption: "Urut" },
    ], [
      { value: "a", text: "A", label: "Ubah watchlist", caption: "Watch" },
      { value: "t", text: "T", label: "Indikator grafik", caption: indicatorLabels[indicator] },
      { value: "l", text: "L", label: "Atur price alert", caption: "Alert" },
      { value: "i", text: "I", label: "Buka IHSG", caption: "IHSG" },
      { value: "r", text: "R", label: "Muat ulang data", caption: "Muat" },
      { value: " ", text: "Space", label: paused ? "Lanjutkan pembaruan" : "Jeda pembaruan", caption: paused ? "Lanjut" : "Jeda", pressed: paused },
    ]] : []),
  ];

  function hint(key: string, text: string, label?: string) {
    return <button type="button" onClick={() => handleKey(key)} aria-label={label ?? text}><b>{label ?? key.toUpperCase()}</b> {text}</button>;
  }

  return (
    <main className="cmd-shell" ref={screen} tabIndex={-1} aria-label="Terminal asli StockWatch">
      <span aria-hidden="true" className="cmd-ruler" ref={ruler}>0000000000</span>
      <header className="cmd-title">
        <h1>STOCKWATCH</h1>
        <span>
          {marketStatus && (
            <em className={"cmd-market-badge " + (marketStatus.tone === "open" ? "cmd-green" : marketStatus.tone === "break" ? "cmd-amber" : "cmd-muted")}>
              [{marketStatus.label}{marketStatus.timeLeft ? " " + marketStatus.timeLeft : ""}]
            </em>
          )}
          <b>IDX {now ? dateFormat.format(now) : "----/--/--"}</b><i> | </i>{now ? clockFormat.format(now) : "--:--:--"} WIB
        </span>
      </header>
      <p className="cmd-about cmd-muted">{apiBadge}</p>
      {mode === "menu" ? (
        <ClassicMenu
          source={snapshot.source}
          prices={prices}
          liveQuotes={liveQuotes}
          indexQuote={liveIndexQuote}
          stockList={stockList}
          watchlist={watchlist}
          alerts={alerts}
          fetchOneQuote={fetchOneQuote}
          fetchCompare={fetchCompare}
          onWatch={toggleWatch}
          onAddAlert={addAlert}
          onRemoveAlert={removeAlert}
          onReturn={() => setMode("dashboard")}
          onQuit={() => setMode("closed")}
        />
      ) : mode === "closed" ? (
        <div className="cmd-closed"><p>Sesi terminal selesai.</p><button type="button" onClick={() => {
          setMode("dashboard"); changeView("market"); setPaused(false);
        }}>Buka kembali terminal</button></div>
      ) : <>
        <div className="cmd-summary cmd-line">
          <button type="button" className="cmd-index-shortcut" onClick={openIndex}>
            IHSG {points(liveIndexQuote.price)} <span className={tone(liveIndexQuote.changePercent)}>{percent(liveIndexQuote.changePercent)}</span>
          </button>
          <strong>{integer.format(stockList.length)} emiten</strong><span className="cmd-muted"> | </span>
          <strong className="cmd-green">{summary.up} naik</strong><strong className="cmd-red">{summary.down} turun</strong>
          <strong className="cmd-muted">{summary.flat} tetap</strong>
          <span className="cmd-muted cmd-summary-value"> | Nilai Rp{compact(summary.value)}</span>
          <span className={todayWib && snapshot.date === todayWib ? "cmd-teal" : "cmd-amber"}>
            {snapshot.source} {snapshot.date}
          </span>
        </div>
        {searching ? (
          <form className="cmd-search cmd-line" onSubmit={(event) => { event.preventDefault(); finishSearch(true); }}>
            <label htmlFor="cmd-filter">CARI EMITEN &gt;</label>
            <input id="cmd-filter" ref={input} value={query} maxLength={50} autoComplete="off" spellCheck={false}
              onChange={(event) => updateQuery(event.target.value)} />
            <button type="submit">Enter</button><button type="button" onClick={() => finishSearch(false)}>Esc</button>
          </form>
        ) : editingAlert ? (
          <form className="cmd-search cmd-line" onSubmit={(event) => { event.preventDefault(); submitAlert(); }}>
            <label htmlFor="cmd-alert-input">ALERT {stock?.code} (&gt;harga / &lt;harga, kosong=hapus) &gt;</label>
            <input id="cmd-alert-input" ref={alertField} value={alertInput} maxLength={24} autoComplete="off" spellCheck={false}
              onChange={(event) => setAlertInput(event.target.value)} />
            <button type="submit">Enter</button><button type="button" onClick={() => { setEditingAlert(false); setAlertInput(""); }}>Esc</button>
          </form>
        ) : picking ? (
          <div className="cmd-picker cmd-line" aria-label="Pilih periode grafik">
            {periods.map((item, i) => <button key={item.label} type="button" onClick={() => choosePeriod(i)}>{i + 1}:{item.label}</button>)}
            <button type="button" onClick={() => setPicking(false)}>Esc</button>
          </div>
        ) : (
          <nav className="cmd-tabs cmd-line" aria-label="Tampilan terminal asli">
            {tabs.map((tab) => <button key={tab.key} type="button" aria-pressed={view === tab.view}
              onClick={() => changeView(tab.view)}>{tab.key} {tab.name}</button>)}
            <button className="cmd-find" type="button" onClick={() => touchKey("/")}>/ {committed && board === "market" ? committed : "Cari emiten"}</button>
            <button className="cmd-find" type="button" onClick={() => handleKey("s")}>S:{orders[order]}</button>
            {board === "market" && (
              <button className="cmd-find" type="button" onClick={cycleSector}>F:{sector ? sector.slice(0, 12) : "Semua"}</button>
            )}
          </nav>
        )}
        <div className={"cmd-body" + ((shownView === "market" || shownView === "watchlist") && split ? " cmd-split" : "")} ref={body}>
          {shownView === "trades" ? (
            <section>
              <Rule>RUNNING TRADE</Rule>
              <TradeTape stock={stock} paused={inactive} refreshTick={refreshTick} />
            </section>
          ) : (
            <>
              {shownView !== "detail" && (
                <section className="cmd-board">
                  <Rule>{shownView === "watchlist" ? "WATCHLIST" : sector ? "EMITEN · " + sector.toUpperCase() : "DAFTAR EMITEN"}</Rule>
                  <div className="cmd-board-row cmd-line cmd-board-head" aria-hidden="true"
                    data-names={leftColumns >= 47} data-value={leftColumns >= 60}>
                    <span>KODE</span><span>EMITEN</span><span>HARGA</span><span>HARI INI</span><span>NILAI</span>
                  </div>
                  {items.map((item) => {
                    const data = prices.get(item.code);
                    const indexItem = item.code === ihsg.code;
                    const active = stock?.code === item.code;
                    const liveEntry = indexItem
                      ? indexEntry
                      : (activeBoard === "watchlist" || (active && !searching))
                        ? liveQuotes[item.code]
                        : undefined;
                    const fresh = liveEntry?.data ?? (indexItem ? liveIndexQuote : undefined);
                    const rowPrice = fresh ? fresh.price : data?.price ?? null;
                    const daily = fresh ? fresh.changePercent : data?.change ?? null;
                    const outdated = !fresh && Boolean(data && snapshot.date && data.date !== snapshot.date);
                    const freshDate = quoteSessionDate(fresh);
                    const otherSession = Boolean(fresh && data && freshDate && freshDate !== data.date);
                    const pulse = liveEntry && liveEntry.move && now > 0 && now < liveEntry.flashUntil ? liveEntry.move : null;
                    const priceTone = pulse !== null ? tone(pulse) : outdated ? "cmd-muted" : "";
                    return (
                      <button type="button" className="cmd-board-row cmd-line" key={item.code} aria-pressed={active}
                        data-names={leftColumns >= 47} data-value={leftColumns >= 60}
                        onClick={() => { setChosen(item.code); screen.current?.focus({ preventScroll: true }); }}
                        onDoubleClick={() => changeView("detail")}>
                        <span className="cmd-code"><i aria-hidden="true">{active ? ">" : " "}{watchlist.includes(item.code) ? "*" : " "}</i>{item.code}</span>
                        <span className="cmd-muted" title={item.name}>{item.name}</span>
                        <span className={priceTone}>{indexItem ? points(rowPrice) : rupiah(rowPrice)}</span>
                        <strong className={tone(daily)}>{percent(daily)}</strong>
                        {outdated && data?.price ? (
                          <strong className="cmd-amber">SESI LAMA</strong>
                        ) : (
                          <strong className="cmd-muted">{data && !otherSession ? compact(data.value) : "--"}</strong>
                        )}
                      </button>
                    );
                  })}
                  {!items.length && <div className="cmd-line cmd-indent cmd-muted">{shownView === "watchlist" && !searching ?
                    "Watchlist kosong. Tekan A pada saham pilihan." : "Tidak ada emiten yang cocok."}</div>}
                </section>
              )}
              <section className="cmd-detail-pane">
                <Rule>{shownView === "detail" ? "GRAFIK DAN KUOTASI" : "DETAIL SAHAM"}</Rule>
                {isIndex ? (
                  <IndexDetail
                    quote={liveIndexQuote}
                    entry={indexEntry}
                    snapshot={snapshot}
                    period={period}
                    indicator={indicator}
                    columns={rightColumns}
                    height={detailHeight}
                    paused={inactive}
                    refreshTick={refreshTick}
                    nowMs={now}
                    onPeriod={choosePeriod}
                    onToggleIndicator={cycleIndicator}
                  />
                ) : stock ? (
                  <Detail
                    stock={stock}
                    data={current}
                    snapshot={snapshot}
                    liveEntry={liveQuotes[stock.code]}
                    stockAlerts={stockAlerts}
                    period={period}
                    indicator={indicator}
                    columns={rightColumns}
                    height={detailHeight}
                    paused={inactive}
                    refreshTick={refreshTick}
                    nowMs={now}
                    onPeriod={choosePeriod}
                    onToggleIndicator={cycleIndicator}
                  />
                ) : (
                  <div className="cmd-line cmd-indent cmd-muted">Pilih saham untuk melihat detail.</div>
                )}
              </section>
            </>
          )}
        </div>
        <div className={"cmd-status cmd-line " + (alertBanner ? "cmd-amber" : "cmd-muted")}>
          <span>{shownView === "trades" ? "Trade " + (stock?.code ?? "") :
            shownView === "detail" ? "Fokus " + (stock?.code ?? "") : (items.length ? start + 1 : 0) + "–" + (start + items.length) + "/" + visible.length}</span>
          <span> | </span><span>{paused ? "JEDA" : "AUTO " + remainder + "s"}</span>
          <span> {alertBanner || notice || error || (snapshot.source + " | Cek " + clockFormat.format(checked) + " WIB")}</span>
        </div>
        <footer className="cmd-controls" aria-label="Pintasan terminal">
          {hint("arrowup", "Pilih", "↑")}{hint("arrowdown", "Pilih", "↓")}
          {hint("/", "Cari")}{hint("f", "Sektor")}{hint("i", "IHSG")}{hint("s", "Urut")}{hint("a", "Watch")}
          {hint("t", "Ind")}{hint("l", "Alert")}{hint("p", "Periode")}{hint("r", "Muat")}
          {hint(" ", paused ? "Lanjut" : "Jeda", "Space")}{hint("m", "Menu")}{hint("q", "Keluar")}
        </footer>
        <ClassicTouchKeys rows={touchRows} onKey={touchKey} />
      </>}
    </main>
  );
}
