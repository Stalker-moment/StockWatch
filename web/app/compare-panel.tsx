"use client";

import { useState } from "react";
import { compact, percent, points, rupiah, type Quote, type Stock } from "../lib/market";
import type { LiveQuoteEntry } from "../lib/use-market";

function movement(value: number | null | undefined) {
  if (value == null) return "neutral";
  return value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
}

export default function ComparePanel({
  codes,
  stockList,
  prices,
  liveQuotes,
  onChangeCodes,
  onSelectStock,
}: {
  codes: string[];
  stockList: Stock[];
  prices: Map<string, Quote>;
  liveQuotes: Record<string, LiveQuoteEntry>;
  onChangeCodes: (next: string[]) => void;
  onSelectStock: (code: string) => void;
}) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const stockMap = new Map(stockList.map((s) => [s.code, s]));

  function addStock(event: React.FormEvent) {
    event.preventDefault();
    const raw = input
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase().replace(/\.JK$/, ""))
      .filter(Boolean);
    if (!raw.length) return;
    const next = [...codes];
    for (const code of raw) {
      if (!stockMap.has(code)) {
        setError(`Kode ${code} tidak ditemukan.`);
        return;
      }
      if (!next.includes(code)) {
        if (next.length >= 8) {
          setError("Perbandingan maksimal 8 saham.");
          return;
        }
        next.push(code);
      }
    }
    onChangeCodes(next);
    setInput("");
    setError("");
  }

  function removeCode(code: string) {
    onChangeCodes(codes.filter((c) => c !== code));
  }

  const rows = codes
    .map((code) => {
      const stock = stockMap.get(code);
      const snap = prices.get(code);
      const live = liveQuotes[code]?.data;
      const price = live?.price ?? snap?.price ?? null;
      const change = live?.changePercent ?? snap?.change ?? null;
      return {
        code,
        name: live?.name || stock?.name || code,
        sector: stock?.sector || "--",
        price,
        change,
        bid: live?.bid ?? null,
        offer: live?.offer ?? null,
        ara: live?.ara ?? null,
        arb: live?.arb ?? null,
        volume: live?.volume ?? snap?.volume ?? null,
        cap: snap?.cap ?? null,
        per: snap?.per ?? null,
        pbr: snap?.pbr ?? null,
        source: live?.source ?? (snap?.price != null ? "Pasardana" : "--"),
      };
    })
    .sort((a, b) => {
      if (a.change == null && b.change == null) return a.code.localeCompare(b.code);
      if (a.change == null) return 1;
      if (b.change == null) return -1;
      return b.change - a.change;
    });

  return (
    <section className="panel" aria-labelledby="compare-title">
      <div className="panel-heading">
        <h2 id="compare-title">Bandingkan Emiten (Live)</h2>
        <span className="panel-meta">Diurutkan berdasarkan perubahan harian · maks. 8 saham</span>
      </div>

      <form className="inline-form" onSubmit={addStock}>
        <label>
          <span>Tambah kode</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            placeholder="BMRI, TLKM, ASII"
            aria-label="Tambah kode saham untuk dibandingkan"
          />
        </label>
        <button type="submit" className="summary-button">Tambah</button>
        <div className="compare-chips">
          {codes.map((code) => (
            <button key={code} type="button" className="chip-button" onClick={() => removeCode(code)} title={`Hapus ${code}`}>
              {code} ×
            </button>
          ))}
        </div>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}

      {!rows.length ? (
        <p className="chart-empty">Tambahkan 2–8 kode saham untuk membandingkan harga live, bid/offer, dan valuasi berdampingan.</p>
      ) : (
        <div className="table-scroll">
          <table className="trade-table">
            <thead>
              <tr>
                <th scope="col">Kode</th>
                <th scope="col">Sektor</th>
                <th scope="col">Harga</th>
                <th scope="col">Hari Ini</th>
                <th scope="col">Bid / Offer</th>
                <th scope="col">ARA* / ARB*</th>
                <th scope="col">Volume</th>
                <th scope="col">Kap. Pasar</th>
                <th scope="col">PER</th>
                <th scope="col">PBV</th>
                <th scope="col">Sumber</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.code}>
                  <th scope="row">
                    <button type="button" className="ticker-button" onClick={() => onSelectStock(row.code)}>
                      {row.code}
                    </button>
                  </th>
                  <td className="muted">{row.sector}</td>
                  <td>{rupiah(row.price)}</td>
                  <td className={movement(row.change)}>{percent(row.change)}</td>
                  <td className="muted">{rupiah(row.bid)} / {rupiah(row.offer)}</td>
                  <td className="muted">{rupiah(row.ara)} / {rupiah(row.arb)}</td>
                  <td>{compact(row.volume)}</td>
                  <td className="muted">{compact(row.cap)}</td>
                  <td className="muted">{row.per == null ? "--" : points(row.per) + "x"}</td>
                  <td className="muted">{row.pbr == null ? "--" : points(row.pbr) + "x"}</td>
                  <td className="muted">{row.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
