"use client";

import { useState } from "react";
import { percent, rupiah, type Quote, type Stock } from "../lib/market";
import type { LiveQuoteEntry } from "../lib/use-market";
import { maxPositions, type Position } from "../lib/watchlist";

function movement(value: number | null | undefined) {
  if (value == null) return "neutral";
  return value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
}

export default function PortfolioPanel({
  positions,
  stockList,
  prices,
  liveQuotes,
  onSave,
  onSelectStock,
}: {
  positions: Position[];
  stockList: Stock[];
  prices: Map<string, Quote>;
  liveQuotes: Record<string, LiveQuoteEntry>;
  onSave: (next: Position[]) => void;
  onSelectStock: (code: string) => void;
}) {
  const [codeInput, setCodeInput] = useState("BBCA");
  const [lotsInput, setLotsInput] = useState("2");
  const [buyInput, setBuyInput] = useState("5800");
  const [formError, setFormError] = useState("");
  const [scenarios, setScenarios] = useState<Record<string, string>>({});

  const known = new Set(stockList.map((s) => s.code));

  function handleAdd(event: React.FormEvent) {
    event.preventDefault();
    const code = codeInput.trim().toUpperCase().replace(/\.JK$/, "");
    const lots = Number(lotsInput);
    const buyPrice = Number(buyInput.replace(",", "."));
    if (!known.has(code)) {
      setFormError("Kode saham IDX tidak ditemukan.");
      return;
    }
    if (!Number.isInteger(lots) || lots < 1 || lots > 100_000) {
      setFormError("Jumlah lot harus bilangan bulat 1–100.000.");
      return;
    }
    if (!Number.isFinite(buyPrice) || buyPrice < 1 || buyPrice > 1_000_000_000) {
      setFormError("Harga beli per lembar tidak valid.");
      return;
    }
    const exists = positions.some((p) => p.code === code);
    if (!exists && positions.length >= maxPositions) {
      setFormError(`Portofolio maksimal ${maxPositions} saham.`);
      return;
    }
    const next = [...positions.filter((p) => p.code !== code), { code, lots, buyPrice }];
    onSave(next);
    setFormError("");
  }

  function removePosition(code: string) {
    onSave(positions.filter((p) => p.code !== code));
  }

  let totalCost = 0;
  let totalCurrent = 0;
  let totalProjected = 0;
  let allAvailable = true;
  let biggestImpact = 0;
  let biggestCode = "";

  const rows = positions.map((pos) => {
    const shares = pos.lots * 100;
    const cost = shares * pos.buyPrice;
    totalCost += cost;
    const live = liveQuotes[pos.code]?.data;
    const snap = prices.get(pos.code);
    const price = live?.price ?? snap?.price ?? null;
    const source = live?.source ?? (snap?.price != null ? "Pasardana" : "--");
    if (price == null) {
      allAvailable = false;
      return { pos, cost, price: null, current: null, pnl: null, pnlPct: null, pct: 0, projected: null, impact: null, source };
    }
    const current = shares * price;
    totalCurrent += current;
    const rawPct = scenarios[pos.code] ?? "0";
    const parsedPct = Number(rawPct.replace(",", "."));
    const pct = Number.isFinite(parsedPct) ? Math.max(-100, Math.min(1000, parsedPct)) : 0;
    const impact = (current * pct) / 100;
    const projected = current + impact;
    totalProjected += projected;
    if (Math.abs(impact) > Math.abs(biggestImpact)) {
      biggestImpact = impact;
      biggestCode = pos.code;
    }
    const pnl = current - cost;
    const pnlPct = (pnl / cost) * 100;
    return { pos, cost, price, current, pnl, pnlPct, pct, projected, impact, source };
  });

  const totalPnl = totalCurrent - totalCost;
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : null;
  const scenarioDelta = totalProjected - totalCurrent;
  const scenarioPct = totalCurrent > 0 ? (scenarioDelta / totalCurrent) * 100 : null;
  const hasScenario = rows.some((r) => r.pct !== 0);

  return (
    <section className="panel portfolio-panel" aria-labelledby="portfolio-title">
      <div className="panel-heading">
        <h2 id="portfolio-title">Portofolio &amp; Simulasi Skenario</h2>
        <span className="panel-meta">1 lot = 100 lembar · tersimpan lokal di browser</span>
      </div>

      <form className="inline-form" onSubmit={handleAdd}>
        <label>
          <span>Kode</span>
          <input
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
            maxLength={7}
            placeholder="BBCA"
            aria-label="Kode saham"
          />
        </label>
        <label>
          <span>Lot</span>
          <input
            type="number"
            min={1}
            max={100000}
            value={lotsInput}
            onChange={(e) => setLotsInput(e.target.value)}
            aria-label="Jumlah lot"
          />
        </label>
        <label>
          <span>Harga beli (Rp)</span>
          <input
            type="number"
            min={1}
            step="any"
            value={buyInput}
            onChange={(e) => setBuyInput(e.target.value)}
            aria-label="Harga beli per lembar"
          />
        </label>
        <button type="submit" className="summary-button">Simpan posisi</button>
        {hasScenario && (
          <button type="button" className="summary-button" onClick={() => setScenarios({})}>
            Reset skenario
          </button>
        )}
      </form>
      {formError && <p className="form-error" role="alert">{formError}</p>}

      {!positions.length ? (
        <p className="chart-empty">
          Portofolio masih kosong. Tambahkan posisi di atas (contoh: BBCA 2 lot beli Rp5.800) untuk menghitung P/L live dan simulasi skenario.
        </p>
      ) : (
        <>
          <div className="table-scroll">
            <table className="trade-table portfolio-table">
              <thead>
                <tr>
                  <th scope="col">Kode</th>
                  <th scope="col">Lot</th>
                  <th scope="col">Beli</th>
                  <th scope="col">Harga Live</th>
                  <th scope="col">Modal</th>
                  <th scope="col">Nilai</th>
                  <th scope="col">P/L</th>
                  <th scope="col">Skenario (%)</th>
                  <th scope="col">Dampak</th>
                  <th scope="col">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ pos, cost, price, current, pnl, pnlPct, projected, impact, source }) => (
                  <tr key={pos.code}>
                    <th scope="row">
                      <button type="button" className="ticker-button" onClick={() => onSelectStock(pos.code)}>
                        {pos.code}
                      </button>
                    </th>
                    <td>{pos.lots}</td>
                    <td>{rupiah(pos.buyPrice)}</td>
                    <td title={source}>{rupiah(price)}</td>
                    <td>{rupiah(cost)}</td>
                    <td>{rupiah(current)}</td>
                    <td className={movement(pnl)}>
                      {pnl != null ? `${pnl > 0 ? "+" : ""}${rupiah(pnl)} (${percent(pnlPct)})` : "--"}
                    </td>
                    <td>
                      <input
                        className="scenario-input"
                        type="number"
                        step="0.5"
                        min={-100}
                        max={1000}
                        value={scenarios[pos.code] ?? "0"}
                        onChange={(e) => setScenarios((prev) => ({ ...prev, [pos.code]: e.target.value }))}
                        aria-label={`Simulasi persentase ${pos.code}`}
                      />
                    </td>
                    <td className={movement(impact)}>
                      {impact != null && projected != null
                        ? `${impact > 0 ? "+" : ""}${rupiah(impact)}`
                        : "--"}
                    </td>
                    <td>
                      <button type="button" className="mini-button" onClick={() => removePosition(pos.code)}>
                        Hapus
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="portfolio-summary">
            <div className="quote-metric">
              <dt>TOTAL MODAL</dt>
              <dd>{rupiah(totalCost)}</dd>
            </div>
            <div className="quote-metric">
              <dt>NILAI PORTOFOLIO</dt>
              <dd>{allAvailable ? rupiah(totalCurrent) : "Menunggu kuotasi"}</dd>
            </div>
            <div className="quote-metric">
              <dt>P/L BERJALAN</dt>
              <dd className={movement(allAvailable ? totalPnl : null)}>
                {allAvailable ? `${totalPnl > 0 ? "+" : ""}${rupiah(totalPnl)} (${percent(totalPnlPct)})` : "--"}
              </dd>
            </div>
            <div className="quote-metric">
              <dt>NILAI SIMULASI</dt>
              <dd className={movement(hasScenario && allAvailable ? scenarioDelta : null)}>
                {allAvailable
                  ? `${rupiah(totalProjected)}${hasScenario ? ` (${scenarioDelta > 0 ? "+" : ""}${rupiah(scenarioDelta)} / ${percent(scenarioPct)})` : ""}`
                  : "--"}
              </dd>
            </div>
            {hasScenario && biggestCode && (
              <div className="quote-metric">
                <dt>DAMPAK TERBESAR</dt>
                <dd className={movement(biggestImpact)}>
                  {biggestCode} ({biggestImpact > 0 ? "+" : ""}{rupiah(biggestImpact)})
                </dd>
              </div>
            )}
          </dl>
        </>
      )}
    </section>
  );
}
