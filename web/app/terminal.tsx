"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Candles, { type ChartIndicators } from "./candles";
import PortfolioPanel from "./portfolio-panel";
import ComparePanel from "./compare-panel";
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
import {
  readPositions,
  readWatchlist,
  savePositions,
  saveWatchlist,
  type Position,
  type PriceAlert,
} from "../lib/watchlist";
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

type View = "market" | "watchlist" | "detail" | "trades" | "portfolio" | "compare";
type Order = "value" | "code" | "up" | "down";
const views: { value: View; label: string; key: string }[] = [
  { value: "market", label: "Pasar", key: "1" },
  { value: "watchlist", label: "Watchlist", key: "2" },
  { value: "detail", label: "Detail", key: "3" },
  { value: "trades", label: "Transaksi", key: "4" },
  { value: "portfolio", label: "Portofolio", key: "5" },
  { value: "compare", label: "Bandingkan", key: "6" },
];
const pageSize = 15;
const clockFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: wib, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const dateFormatter = new Intl.DateTimeFormat("id-ID", {
  timeZone: wib, day: "2-digit", month: "short", year: "numeric",
});
const lotsFormatter = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });

function movement(value: number | null | undefined) {
  if (value == null) return "neutral";
  return value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
}

function Detail({
  stock,
  data,
  snapshot,
  liveEntry,
  stockAlerts,
  period,
  indicators,
  watch,
  paused,
  refreshTick,
  nowMs,
  onWatch,
  onPeriod,
  onToggleIndicator,
  onAddAlert,
  onRemoveAlert,
  onResetAlert,
}: {
  stock: Stock;
  data: Quote | undefined;
  snapshot: MarketSnapshot;
  liveEntry: LiveQuoteEntry | undefined;
  stockAlerts: PriceAlert[];
  period: number;
  indicators: ChartIndicators;
  watch: boolean;
  paused: boolean;
  refreshTick: number;
  nowMs: number;
  onWatch: () => void;
  onPeriod: (value: number) => void;
  onToggleIndicator: (key: keyof ChartIndicators) => void;
  onAddAlert: (code: string, target: number, above: boolean) => string;
  onRemoveAlert: (id: string) => void;
  onResetAlert: (id: string) => void;
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

  const [alertAbove, setAlertAbove] = useState(true);
  const [alertTarget, setAlertTarget] = useState("");
  const [alertMessage, setAlertMessage] = useState("");

  function submitAlert(event: React.FormEvent) {
    event.preventDefault();
    const target = Number(alertTarget.replace(",", "."));
    if (!Number.isFinite(target) || target <= 0) {
      setAlertMessage("Masukkan target harga valid.");
      return;
    }
    const msg = onAddAlert(stock.code, target, alertAbove);
    setAlertMessage(msg);
    setAlertTarget("");
  }

  const fields = [
    { label: "BUKA", value: rupiah(merged.open) },
    { label: "TERTINGGI", value: rupiah(merged.high), tone: "positive" },
    { label: "TERENDAH", value: rupiah(merged.low), tone: "negative" },
    { label: "PREV", value: rupiah(merged.previous) },
    { label: "ARA*", value: rupiah(merged.ara), tone: "positive" },
    { label: "ARB*", value: rupiah(merged.arb), tone: "negative" },
    { label: merged.estimatedAverage ? "AVG~" : "AVG", value: rupiah(merged.average) },
    { label: "VOLUME", value: compact(merged.volume) },
    { label: "BID", value: rupiah(merged.bid) },
    { label: "OFFER", value: rupiah(merged.offer) },
    { label: "NILAI", value: merged.value === null ? "--" : "Rp" + compact(merged.value) },
    { label: "FREKUENSI", value: merged.frequency === null ? "--" : integer.format(merged.frequency) },
  ];

  const metaParts = [
    merged.liveSource
      ? (merged.cached ? "Cache " : "") +
        merged.liveSource +
        (merged.marketTime ? " · " + formatQuoteTime(merged.marketTime) + " WIB" : merged.tradeDate ? " · Sesi " + merged.tradeDate : "") +
        (merged.fetchedAt && !merged.cached ? " · Ambil " + formatClockWib(merged.fetchedAt) : "")
      : snapshot.source + (merged.tradeDate ? " · Sesi " + merged.tradeDate : ""),
    merged.board || "",
    merged.estimatedAverage && merged.averageThrough ? "AVG~ Yahoo 1m " + formatHmWib(merged.averageThrough) : "",
  ].filter(Boolean);

  return (
    <section className="panel detail-panel" aria-labelledby="detail-title">
      <div className="panel-heading">
        <h2 id="detail-title">Detail emiten</h2>
        {merged.ohlcSource && <span className="panel-meta">OHLC {merged.ohlcSource}</span>}
      </div>
      <div className="instrument">
        <div className="instrument-title">
          <div>
            <div className="instrument-id">
              <h3>{stock.code}</h3>
              {stock.sector && <span className="sector-chip">{stock.sector}</span>}
            </div>
            <p>{stock.name}</p>
          </div>
          <button type="button" className={"watch-button" + (watch ? " saved" : "")} onClick={onWatch}
            aria-pressed={watch} aria-label={watch ? "Hapus " + stock.code + " dari watchlist" : "Tambah " + stock.code + " ke watchlist"}>
            <span aria-hidden="true">{watch ? "★" : "☆"}</span> <span>Watchlist</span>
          </button>
        </div>
        <div className="price-line">
          <strong className={"instrument-price" + (merged.pulse !== null ? " " + movement(merged.pulse) : "")}>
            {rupiah(merged.price)}
          </strong>
          <span className={"movement " + movement(merged.change)}>
            <span aria-hidden="true">{merged.delta === null ? "–" : merged.delta > 0 ? "▴" : merged.delta < 0 ? "▾" : "–"}</span> {percent(merged.change)}
          </span>
          {merged.delta !== null && <span className={"price-delta " + movement(merged.change)}>
            {merged.delta < 0 ? "−" : merged.delta > 0 ? "+" : ""}{rupiah(Math.abs(merged.delta))}
          </span>}
        </div>
        <p className="panel-meta">{metaParts.join(" · ")}</p>
      </div>
      <dl className="quote-grid">
        {fields.map((field) => (
          <div key={field.label} className="quote-metric">
            <dt>{field.label}</dt>
            <dd className={field.tone}>{field.value}</dd>
          </div>
        ))}
      </dl>

      <div className="alert-box">
        <form className="alert-form" onSubmit={submitAlert}>
          <span className="panel-meta">Price Alert</span>
          <select
            value={alertAbove ? "gte" : "lte"}
            onChange={(e) => setAlertAbove(e.target.value === "gte")}
            aria-label="Kondisi price alert"
          >
            <option value="gte">≥ Naik ke</option>
            <option value="lte">≤ Turun ke</option>
          </select>
          <input
            type="number"
            min={1}
            placeholder={merged.price ? String(merged.price) : "Harga Rp"}
            value={alertTarget}
            onChange={(e) => setAlertTarget(e.target.value)}
            aria-label="Target harga alert"
          />
          <button type="submit" className="mini-button">Pasang</button>
        </form>
        {alertMessage && <span className="panel-meta">{alertMessage}</span>}
        {stockAlerts.length > 0 && (
          <div className="alert-chips">
            {stockAlerts.map((item) => (
              <span key={item.id} className={"alert-chip" + (item.triggered ? " triggered" : "")}>
                {item.above ? "≥" : "≤"} {rupiah(item.target)} {item.triggered ? "(Terpicu)" : ""}
                {item.triggered && (
                  <button type="button" onClick={() => onResetAlert(item.id)} title="Aktifkan lagi">↺</button>
                )}
                <button type="button" onClick={() => onRemoveAlert(item.id)} title="Hapus alert">×</button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="chart-heading">
        <h3>Grafik harga</h3>
        <div className="periods" role="group" aria-label="Periode grafik">
          {periods.map(({ label }, index) => (
            <button type="button" key={label} aria-pressed={period === index}
              onClick={() => onPeriod(index)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="indicator-bar" role="group" aria-label="Indikator teknikal grafik">
        <span className="panel-meta">Indikator:</span>
        {(["ma5", "ma20", "prev", "avg"] as const).map((key) => (
          <button
            key={key}
            type="button"
            className="indicator-pill"
            data-indicator={key}
            aria-pressed={indicators[key]}
            onClick={() => onToggleIndicator(key)}
          >
            {key.toUpperCase()}
          </button>
        ))}
      </div>
      {bars.length ? <>
        <div className="chart-source">{source}{lastDate ? " · " + lastDate : ""}</div>
        <Candles
          key={stock.code + ":" + period}
          code={stock.code}
          period={period}
          bars={bars}
          previous={merged.previous}
          average={merged.average}
          indicators={indicators}
        />
      </> : <p className="chart-empty" role="status">{message}</p>}
    </section>
  );
}

function IndexDetail({
  quote,
  entry,
  snapshot,
  period,
  indicators,
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
  indicators: ChartIndicators;
  paused: boolean;
  refreshTick: number;
  nowMs: number;
  onPeriod: (value: number) => void;
  onToggleIndicator: (key: keyof ChartIndicators) => void;
}) {
  const { bars, source, session, lastDate, message } = useStockHistory(ihsg.code, period, snapshot, paused, refreshTick);
  const pulse = entry && entry.move && entry.move !== 0 && nowMs > 0 && nowMs < entry.flashUntil ? entry.move : null;
  const cached = Boolean(entry?.error);
  const metrics = resolveIndexMetrics(quote, session);
  const stamp =
    (cached ? "Cache " : "") +
    quote.source +
    (quote.marketTime ? " · " + formatIndexTime(quote.marketTime) + " WIB" : quote.date ? " · " + quote.date : "") +
    (quote.fetchedAt && !cached ? " · Ambil " + formatClockWib(quote.fetchedAt) : "");

  return (
    <section className="panel detail-panel" aria-labelledby="index-title">
      <div className="panel-heading"><h2 id="index-title">IHSG</h2><span className="panel-meta">IDX Composite</span></div>
      <div className="instrument">
        <p>{ihsg.name}</p>
        <div className="price-line">
          <strong className={"instrument-price" + (pulse !== null ? " " + movement(pulse) : "")}>
            {points(quote.price)}
          </strong><span className="muted">poin</span>
          <span className={"movement " + movement(quote.changePercent)}>{percent(quote.changePercent)}</span>
          {quote.change != null && quote.change !== 0 && (
            <span className={"price-delta " + movement(quote.changePercent)}>
              {quote.change < 0 ? "−" : "+"}{points(Math.abs(quote.change))}
            </span>
          )}
        </div>
        <p className="panel-meta">{stamp}</p>
      </div>
      <dl className="quote-grid">{metrics.map(([label, value]) => <div className="quote-metric" key={label}>
        <dt>{label}</dt><dd>{points(value)}</dd>
      </div>)}</dl>
      <div className="chart-heading">
        <h3>Grafik indeks</h3>
        <div className="periods" role="group" aria-label="Periode grafik">
          {periods.map(({ label }, i) => <button type="button" key={label} aria-pressed={i === period}
            onClick={() => onPeriod(i)}>{label}</button>)}
        </div>
      </div>
      <div className="indicator-bar" role="group" aria-label="Indikator teknikal grafik">
        <span className="panel-meta">Indikator:</span>
        {(["ma5", "ma20", "prev"] as const).map((key) => (
          <button
            key={key}
            type="button"
            className="indicator-pill"
            data-indicator={key}
            aria-pressed={indicators[key]}
            onClick={() => onToggleIndicator(key)}
          >
            {key.toUpperCase()}
          </button>
        ))}
      </div>
      {bars.length ? <>
        <div className="chart-source">{source || "Yahoo Finance"}{lastDate ? " · " + lastDate : ""}</div>
        <Candles
          key={ihsg.code + ":" + period}
          code={ihsg.code}
          bars={bars}
          period={period}
          previous={quote.previous}
          indicators={indicators}
        />
      </> : <p className="chart-empty" role="status">{message}</p>}
    </section>
  );
}

function TradePanel({
  stock,
  isIndex,
  paused,
  refreshTick,
}: {
  stock: Stock;
  isIndex: boolean;
  paused: boolean;
  refreshTick: number;
}) {
  const { data, error, loading } = useRunningTrades(stock.code, !isIndex, paused, refreshTick);

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Transaksi · {stock.code}</h2>
        <span className="panel-meta">
          {data ? `Invezgo · ${data.date} · Ambil ${formatClockWib(data.fetchedAt)} WIB` : "Invezgo Running Trade"}
        </span>
      </div>
      {isIndex ? (
        <p className="tape-label">Pilih emiten untuk melihat transaksi saham.</p>
      ) : (
        <>
          {error && <p className="tape-label">{error}{data ? " · Menampilkan cache terakhir" : ""}</p>}
          {!data ? (
            !error && <p className="tape-label">{paused ? "Pembaruan transaksi dijeda." : loading ? "Memuat transaksi…" : "Memuat transaksi…"}</p>
          ) : !data.trades.length ? (
            <p className="tape-label">Belum ada transaksi untuk tanggal ini.</p>
          ) : (
            <div className="table-scroll">
              <table className="trade-table">
                <thead>
                  <tr>
                    <th scope="col">Waktu WIB</th>
                    <th scope="col">Side</th>
                    <th scope="col">Harga</th>
                    <th scope="col">Lot</th>
                    <th scope="col">Buyer</th>
                    <th scope="col">Seller</th>
                    <th scope="col">Pasar</th>
                  </tr>
                </thead>
                <tbody>
                  {data.trades.map((trade, idx) => (
                    <tr key={`${trade.time}-${idx}`}>
                      <td>{trade.time}</td>
                      <td className={trade.side === "BUY" ? "positive" : trade.side === "SELL" ? "negative" : "neutral"}>{trade.side}</td>
                      <td>{rupiah(trade.price)}</td>
                      <td>{lotsFormatter.format(trade.shares / 100)}</td>
                      <td className="muted">{trade.buyer || "--"}</td>
                      <td className="muted">{trade.seller || "--"}</td>
                      <td className="muted">{trade.board || "--"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default function Terminal() {
  const [view, setView] = useState<View>("market");
  const [selected, setSelected] = useState("BBCA");
  const [watchlist, setWatchlist] = useState(initialWatchlist);
  const [positions, setPositions] = useState<Position[]>([]);
  const [compareCodes, setCompareCodes] = useState<string[]>(["BBCA", "BBRI", "BMRI", "TLKM"]);
  const [query, setQuery] = useState("");
  const [sector, setSector] = useState("");
  const [sort, setSort] = useState<Order>("value");
  const [page, setPage] = useState(0);
  const [period, setPeriod] = useState(2);
  const [indicators, setIndicators] = useState<ChartIndicators>({
    ma5: false,
    ma20: false,
    prev: false,
    avg: false,
  });
  const [paused, setPaused] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [clock, setClock] = useState<Date | null>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const marketPanel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const refreshClock = () => setClock(new Date());
    refreshClock();
    const timer = window.setInterval(refreshClock, 1000);
    setWatchlist(readWatchlist());
    setPositions(readPositions());
    return () => window.clearInterval(timer);
  }, []);

  const { snapshot, prices, stockList, sectors, refresh, error, mode: apiMode, isLive, pageVisible } = useMarketQuotes(paused);
  const summary = useMemo(() => summarize(snapshot), [snapshot]);

  const normalized = query.trim().toLocaleLowerCase("id-ID");
  const filtered = useMemo(() => {
    const list = stockList.filter((stock) =>
      (view !== "watchlist" || watchlist.includes(stock.code)) &&
      (view !== "market" || !sector || stock.sector === sector) &&
      (!normalized || (stock.code + " " + stock.name + " " + stock.sector).toLocaleLowerCase("id-ID").includes(normalized)));
    const rank = (code: string) => code.toLowerCase() === normalized ? 0 : code.toLowerCase().startsWith(normalized) ? 1 : 2;
    list.sort((a, b) => {
      if (normalized && rank(a.code) !== rank(b.code)) return rank(a.code) - rank(b.code);
      const aQuote = prices.get(a.code);
      const bQuote = prices.get(b.code);
      const order = sort === "value" ? compareMetric(aQuote?.value, bQuote?.value)
        : sort === "up" || sort === "down" ? compareMetric(aQuote?.change, bQuote?.change, sort === "down") : 0;
      return order || a.code.localeCompare(b.code);
    });
    if (view !== "watchlist" && !sector && matchesIndex(normalized)) list.unshift(ihsg);
    return list;
  }, [normalized, prices, sector, sort, stockList, view, watchlist]);

  const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
  const activePage = Math.min(page, lastPage);
  const visible = filtered.slice(activePage * pageSize, (activePage + 1) * pageSize);
  const isIndex = selected === ihsg.code;
  const stock = isIndex ? ihsg : stockList.find((item) => item.code === selected) ?? stockList[0];
  const selectedQuote = prices.get(stock.code);
  const isSaved = watchlist.includes(stock.code);
  const showList = view === "market" || view === "watchlist";
  const nowMs = clock ? clock.getTime() : 0;

  const batchCodes = useMemo(() => {
    if (view === "watchlist") return watchlist;
    if (view === "portfolio") return positions.map((p) => p.code);
    if (view === "compare") return compareCodes;
    return [];
  }, [view, watchlist, positions, compareCodes]);

  const { liveQuotes, indexEntry, liveIndexQuote, marketStatus } = useLiveQuotes(
    stock.code,
    paused,
    refreshTick,
    batchCodes,
  );
  const { alerts, banner: alertBanner, dismissBanner, addAlert, removeAlert, resetAlert } = usePriceAlerts(
    liveQuotes,
    prices,
  );
  const stockAlerts = useMemo(() => alerts.filter((a) => a.code === stock.code), [alerts, stock.code]);

  function changeView(next: View) {
    setView(next);
    setPage(0);
    setQuery("");
  }

  function toggleWatch(code: string) {
    if (code === ihsg.code) return;
    const updated = watchlist.includes(code)
      ? watchlist.filter((item) => item !== code)
      : watchlist.length >= 8
        ? watchlist
        : [...watchlist, code];
    setWatchlist(updated);
    saveWatchlist(updated);
  }

  function updatePositions(next: Position[]) {
    setPositions(next);
    savePositions(next);
  }

  function toggleIndicator(key: keyof ChartIndicators) {
    setIndicators((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function openIndex() {
    setSelected(ihsg.code);
    changeView("detail");
  }

  function choose(code: string) {
    setSelected(code);
    if (window.matchMedia("(max-width: 760px)").matches) changeView("detail");
  }

  function openStockDetail(code: string) {
    setSelected(code);
    changeView("detail");
  }

  function changePage(next: number) {
    setPage(Math.max(0, Math.min(next, lastPage)));
    marketPanel.current?.scrollTo({ top: 0 });
  }

  function changeSearch(text: string) {
    setQuery(text);
    setPage(0);
    if (!showList) setView("market");
  }

  function reloadAll() {
    setPaused(false);
    setRefreshTick((value) => value + 1);
    void refresh(true);
  }

  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target;
      if (target === searchField.current) {
        if (event.key === "Escape") {
          changeSearch("");
          searchField.current?.blur();
          event.preventDefault();
        } else if (event.key === "Enter" && filtered[0]) {
          choose(filtered[0].code);
          searchField.current?.blur();
          event.preventDefault();
        }
        return;
      }
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input,select,textarea"))) return;
      const key = event.key.toLowerCase();
      const tab = views.find((item) => item.key === key);
      if (tab) changeView(tab.value);
      else if (key === "/") searchField.current?.focus();
      else if (key === "i") openIndex();
      else if (key === "h") setPeriod((value) => (value + 1) % periods.length);
      else if (key === "a") toggleWatch(stock.code);
      else if (key === "r") reloadAll();
      else if (key === " " && !((target instanceof HTMLElement) && target.closest("button,a"))) setPaused((value) => !value);
      else if (key === "arrowup" || key === "arrowdown") {
        const current = filtered.findIndex((item) => item.code === stock.code);
        const next = current < 0 ? activePage * pageSize
          : Math.max(0, Math.min(filtered.length - 1, current + (key === "arrowdown" ? 1 : -1)));
        if (filtered[next]) {
          setSelected(filtered[next].code);
          if (Math.floor(next / pageSize) !== activePage) changePage(Math.floor(next / pageSize));
        }
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  });

  const currentDate = clock ? dateFormatter.format(clock).toUpperCase() : "—";
  const currentTime = clock ? clockFormatter.format(clock) : "--:--:--";
  const modeLabel =
    apiMode === "cpp"
      ? "API C++ lokal · Stockbit / Yahoo / " + snapshot.source + " " + snapshot.date
      : isLive
        ? "Live API · Stockbit / Yahoo / " + snapshot.source + " " + snapshot.date
        : "Versi web terminal C++ · " + snapshot.source + " " + snapshot.date;

  return (
    <main className="terminal summary-page">
      <header className="summary-heading">
        <div>
          <h1>Pasar IDX</h1>
          <p>{modeLabel}</p>
        </div>
        <div className="summary-heading-actions">
          {marketStatus && (
            <span className={"market-badge market-badge-" + marketStatus.tone}>
              {marketStatus.label}{marketStatus.timeLeft ? " · " + marketStatus.timeLeft : ""}
            </span>
          )}
          <time className="summary-clock" aria-label="Tanggal dan jam WIB">
            <span>{currentDate}</span> <strong>{currentTime} WIB</strong>
          </time>
          <button type="button" className="summary-button" aria-pressed={paused}
            onClick={() => setPaused((value) => !value)}>{paused ? "Lanjutkan" : "Jeda"}</button>
          <button type="button" className="summary-button" onClick={reloadAll}>Muat ulang</button>
        </div>
      </header>
      <div className="toolbar">
        <nav className="views" aria-label="Tampilan terminal">
          {views.map((tab) => (
            <button type="button" key={tab.value} aria-pressed={view === tab.value} onClick={() => changeView(tab.value)}>
              {tab.label}
              {tab.value === "watchlist" && <span className="watch-count">{watchlist.length}</span>}
              {tab.value === "portfolio" && positions.length > 0 && <span className="watch-count">{positions.length}</span>}
            </button>
          ))}
        </nav>
        <div className="search">
          <span className="search-icon" aria-hidden="true" />
          <input ref={searchField} value={query} onChange={(event) => changeSearch(event.target.value)}
            placeholder="Cari kode, emiten, atau sektor" aria-label="Cari kode, emiten, atau sektor" />
          {query && <button type="button" onClick={() => changeSearch("")} aria-label="Hapus pencarian">×</button>}
          <kbd>/</kbd>
        </div>
      </div>

      {alertBanner && (
        <div className="alert-banner" role="alert">
          <span>{alertBanner}</span>
          <button type="button" className="mini-button" onClick={dismissBanner}>Tutup</button>
        </div>
      )}

      <div className="market-strip" aria-label="Ringkasan pasar dan IHSG">
        <button
          type="button"
          className="ihsg-shortcut"
          onClick={openIndex}
          title={liveIndexQuote.source + " · " + formatIndexTime(liveIndexQuote.marketTime) + " WIB"}
        >
          IHSG <b>{points(liveIndexQuote.price)}</b>{" "}
          <b className={movement(liveIndexQuote.changePercent)}>{percent(liveIndexQuote.changePercent)}</b>
        </button>
        <span><b>{integer.format(stockList.length)}</b> emiten</span>
        <span><b className="positive">{summary.up}</b> naik</span>
        <span><b className="negative">{summary.down}</b> turun</span>
        <span><b>{summary.flat}</b> tetap</span>
        <span><b>Rp{compact(summary.value)}</b> nilai transaksi</span>
      </div>

      {view === "trades" ? (
        <TradePanel stock={stock} isIndex={isIndex} paused={paused} refreshTick={refreshTick} />
      ) : view === "portfolio" ? (
        <PortfolioPanel
          positions={positions}
          stockList={stockList}
          prices={prices}
          liveQuotes={liveQuotes}
          onSave={updatePositions}
          onSelectStock={openStockDetail}
        />
      ) : view === "compare" ? (
        <ComparePanel
          codes={compareCodes}
          stockList={stockList}
          prices={prices}
          liveQuotes={liveQuotes}
          onChangeCodes={setCompareCodes}
          onSelectStock={openStockDetail}
        />
      ) : (
        <div className={"workspace" + (showList ? "" : " workspace-detail")}>
          {showList && (
            <section className="panel market-panel" data-full-page={visible.length === pageSize} aria-labelledby="market-title">
              <div className="panel-heading">
                <h2 id="market-title">{view === "watchlist" ? "Watchlist (Live)" : "Daftar emiten"}</h2>
                <div className="heading-controls">
                  {view === "market" && sectors.length > 0 && (
                    <label className="sort-control">
                      <span>Sektor</span>
                      <select
                        value={sector}
                        onChange={(event) => { setSector(event.target.value); setPage(0); }}
                        aria-label="Filter sektor IDX"
                      >
                        <option value="">Semua</option>
                        {sectors.map((item) => (
                          <option key={item} value={item}>{item}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="sort-control">
                    <span>Urut</span>
                    <select value={sort} onChange={(event) => { setSort(event.target.value as Order); setPage(0); }} aria-label="Urutkan emiten">
                      <option value="value">Nilai</option>
                      <option value="code">Kode</option>
                      <option value="up">Top gainers</option>
                      <option value="down">Top losers</option>
                    </select>
                  </label>
                </div>
              </div>
              <div className="table-scroll" ref={marketPanel}>
                <table className="market-table">
                  <colgroup><col className="col-code" /><col /><col className="col-price" /><col className="col-change" /><col className="col-value" /></colgroup>
                  <thead><tr><th scope="col">Kode</th><th scope="col">Emiten</th><th scope="col">Harga</th><th scope="col" className="day-column">Hari ini</th><th scope="col">Nilai</th></tr></thead>
                  <tbody>
                    {visible.map((item) => {
                      const indexRow = item.code === ihsg.code;
                      const row = prices.get(item.code);
                      const live = indexRow
                        ? liveIndexQuote
                        : (view === "watchlist" || item.code === stock.code)
                          ? liveQuotes[item.code]?.data
                          : undefined;
                      const rowPrice = live ? live.price : row?.price ?? null;
                      const daily = live ? live.changePercent : row?.change ?? null;
                      const otherSession = Boolean(live && row && quoteSessionDate(live) && quoteSessionDate(live) !== row.date);
                      return (
                        <tr key={item.code} data-selected={item.code === stock.code} onClick={() => choose(item.code)}>
                          <th scope="row">
                            <button type="button" className="ticker-button" aria-pressed={item.code === stock.code}
                              onClick={(event) => { event.stopPropagation(); choose(item.code); }}>
                              {item.code}
                            </button>
                          </th>
                          <td className="company" title={item.name}>{item.name}</td>
                          <td>{indexRow ? points(rowPrice) : rupiah(rowPrice)}</td>
                          <td className={movement(daily)}>{percent(daily)}</td>
                          <td className="turnover">{row && !otherSession ? compact(row.value) : "—"}</td>
                        </tr>
                      );
                    })}
                    {!visible.length && <tr><td className="empty" colSpan={5}>{query.trim() || sector ? "Emiten tidak ditemukan." : "Watchlist masih kosong."}</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="pagination">
                <span>{visible.length ? activePage * pageSize + 1 + "–" + (activePage * pageSize + visible.length) : "0"} dari {integer.format(filtered.length)} emiten</span>
                <div>
                  <button type="button" aria-label="Halaman sebelumnya" disabled={activePage === 0} onClick={() => changePage(activePage - 1)}>‹</button>
                  <span aria-label="Halaman saat ini">{activePage + 1}</span>
                  <button type="button" aria-label="Halaman berikutnya" disabled={activePage >= lastPage} onClick={() => changePage(activePage + 1)}>›</button>
                </div>
              </div>
            </section>
          )}
          {isIndex ? (
            <IndexDetail
              quote={liveIndexQuote}
              entry={indexEntry}
              snapshot={snapshot}
              period={period}
              indicators={indicators}
              paused={paused}
              refreshTick={refreshTick}
              nowMs={nowMs}
              onPeriod={setPeriod}
              onToggleIndicator={toggleIndicator}
            />
          ) : (
            <Detail
              stock={stock}
              data={selectedQuote}
              snapshot={snapshot}
              liveEntry={liveQuotes[stock.code]}
              stockAlerts={stockAlerts}
              period={period}
              indicators={indicators}
              watch={isSaved}
              paused={paused}
              refreshTick={refreshTick}
              nowMs={nowMs}
              onWatch={() => toggleWatch(stock.code)}
              onPeriod={setPeriod}
              onToggleIndicator={toggleIndicator}
              onAddAlert={addAlert}
              onRemoveAlert={removeAlert}
              onResetAlert={resetAlert}
            />
          )}
        </div>
      )}

      <footer className="terminal-footer">
        <span>
          {error ||
            (!pageVisible
              ? "Tab tersembunyi — pembaruan dijeda otomatis"
              : paused
                ? "Pembaruan otomatis dijeda"
                : isLive
                  ? "Kuotasi 8 dtk · Watchlist/IHSG 15 dtk · Direktori 30 dtk"
                  : "Cek snapshot tiap 60 detik")}
        </span>
        <span><kbd>/</kbd> Cari <kbd>↑↓</kbd> Pilih <kbd>I</kbd> IHSG <kbd>5</kbd> Portofolio <kbd>6</kbd> Bandingkan</span>
      </footer>
    </main>
  );
}
