"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ClassicTouchKeys, { backspaceKey, editWithKey, enterKey, escapeKey, keyboardKey, type TouchKey } from "./classic-touch-keys";
import {
  formatClockWib,
  formatIndexTime,
  formatQuoteTime,
  ihsg,
  matchesIndex,
  percent,
  points,
  rupiah,
  type LiveQuote,
  type Quote,
  type Stock,
} from "../lib/market";
import type { CompareResultRow, LiveQuoteEntry } from "../lib/use-market";
import { readPositions, savePositions, type Position, type PriceAlert } from "../lib/watchlist";

type Step =
  | { kind: "choice" }
  | { kind: "search" }
  | { kind: "search-price" }
  | { kind: "code"; action: number }
  | { kind: "lots"; code: string }
  | { kind: "buy"; code: string; lots: number }
  | { kind: "scenario"; index: number; changes: number[] }
  | { kind: "compare" }
  | { kind: "alert-action" }
  | { kind: "alert-code" }
  | { kind: "alert-target"; code: string }
  | { kind: "alert-delete" };

const menu = [
  [1, "Cari saham"], [2, "Lihat harga"], [3, "Lihat watchlist"], [4, "Tambah ke watchlist"],
  [5, "Hapus dari watchlist"], [6, "Tambah/ubah posisi"],
  [7, "Hapus posisi"], [8, "Lihat portofolio"], [9, "Simulasi skenario"], [10, "Buka dashboard"],
  [11, "Bandingkan saham"], [12, "Kelola price alert"],
] as const;
const choice = { kind: "choice" } as const;

export default function ClassicMenu({
  source,
  prices,
  liveQuotes,
  indexQuote,
  stockList,
  watchlist,
  alerts,
  fetchOneQuote,
  fetchCompare,
  onWatch,
  onAddAlert,
  onRemoveAlert,
  onReturn,
  onQuit,
}: {
  source: string;
  prices: Map<string, Quote>;
  liveQuotes: Record<string, LiveQuoteEntry>;
  indexQuote: LiveQuote;
  stockList: Stock[];
  watchlist: string[];
  alerts: PriceAlert[];
  fetchOneQuote: (code: string) => Promise<LiveQuote | null>;
  fetchCompare: (codes: string[]) => Promise<CompareResultRow[]>;
  onWatch: (code: string) => string;
  onAddAlert: (code: string, target: number, above: boolean) => string;
  onRemoveAlert: (id: string) => void;
  onReturn: () => void;
  onQuit: () => void;
}) {
  const [step, setStep] = useState<Step>(choice);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState<string[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const field = useRef<HTMLInputElement>(null);
  const known = useMemo(() => new Set(stockList.map((stock) => stock.code)), [stockList]);

  useEffect(() => {
    setPositions(readPositions());
  }, []);

  useEffect(() => { field.current?.focus(); }, [step]);

  function save(next: Position[]) {
    setPositions(next);
    savePositions(next);
  }

  function finish(lines: string[] = []) {
    setStep(choice);
    setOutput(lines);
  }

  function effectivePrice(code: string) {
    return liveQuotes[code]?.data.price ?? prices.get(code)?.price ?? null;
  }

  function effectiveChange(code: string) {
    return liveQuotes[code]?.data.changePercent ?? prices.get(code)?.change ?? null;
  }

  function quoteLines(code: string, live?: LiveQuote | null) {
    if (code === ihsg.code) {
      const q = live ?? indexQuote;
      const stamp = q.marketTime ? formatIndexTime(q.marketTime) + " WIB" : q.date || "--";
      return [
        ihsg.code + " | " + ihsg.name,
        "Nilai indeks      " + points(q.price) + " poin",
        "Hari ini          " + percent(q.changePercent),
        q.source + " · " + stamp + (q.fetchedAt ? " | Ambil " + formatClockWib(q.fetchedAt) : ""),
      ];
    }
    const fresh = live ?? liveQuotes[code]?.data ?? null;
    const data = prices.get(code);
    const stock = stockList.find((item) => item.code === code);
    const heading = code + " | " + (fresh?.name || stock?.name || code);
    const price = fresh?.price ?? data?.price ?? null;
    if (price === null) return [heading, "Kuotasi belum tersedia."];
    const change = fresh?.changePercent ?? data?.change ?? null;
    const volume = fresh?.volume ?? data?.volume ?? null;
    const sourceLabel = fresh
      ? fresh.source +
        (fresh.marketTime ? " " + formatQuoteTime(fresh.marketTime) + " WIB" : fresh.date ? " | Sesi " + fresh.date : "") +
        (fresh.fetchedAt ? " | Ambil " + formatClockWib(fresh.fetchedAt) : "")
      : source + (data?.date ? " | Sesi " + data.date : "");
    return [
      heading,
      "Harga terakhir    " + rupiah(price),
      "Hari ini          " + percent(change),
      "Volume            " + (volume?.toLocaleString("id-ID") ?? "--"),
      ...(fresh?.bid != null || fresh?.offer != null
        ? ["Bid / Offer       " + rupiah(fresh.bid) + " / " + rupiah(fresh.offer)]
        : []),
      sourceLabel,
    ];
  }

  function openQuote(code: string) {
    finish(quoteLines(code));
    void fetchOneQuote(code).then((fresh) => {
      if (fresh) setOutput(quoteLines(code, fresh));
    });
  }

  function formatCompareRows(rows: CompareResultRow[]) {
    return [
      "KODE     HARGA           HARI INI    BID / OFFER            SUMBER",
      ...rows.map((row) => {
        if ("error" in row) return row.code.padEnd(9) + row.error;
        const book = (row.bid != null ? rupiah(row.bid) : "--") + " / " + (row.offer != null ? rupiah(row.offer) : "--");
        return (
          row.code.padEnd(9) +
          rupiah(row.price).padEnd(16) +
          percent(row.changePercent).padEnd(12) +
          book.padEnd(23) +
          row.source
        );
      }),
    ];
  }

  function allPricesAvailable() {
    return positions.every((position) => effectivePrice(position.code) != null);
  }

  function portfolio(changes?: number[], priceOverrides?: Map<string, number>) {
    const complete = positions.every((position) => (priceOverrides?.get(position.code) ?? effectivePrice(position.code)) != null);
    if (changes && !complete) return ["Skenario membutuhkan kuotasi untuk setiap posisi."];
    let cost = 0, current = 0, projected = 0, biggest = 0;
    let biggestCode = "";
    const lines = positions.map((position, index) => {
      const shares = position.lots * 100;
      const bought = shares * position.buyPrice;
      cost += bought;
      const price = priceOverrides?.get(position.code) ?? effectivePrice(position.code);
      if (price == null) return position.code + " | " + position.lots + " lot | Modal " + rupiah(bought) +
        " | Kuotasi belum tersedia";
      const value = shares * price;
      current += value;
      if (!changes) return position.code + " | " + position.lots + " lot | Modal " + rupiah(bought) +
        " | Nilai " + rupiah(value) + " | P/L " + rupiah(value - bought) + " (" + percent((value - bought) / bought * 100) + ")";
      const impact = value * changes[index] / 100;
      projected += value + impact;
      if (Math.abs(impact) > Math.abs(biggest)) {
        biggest = impact;
        biggestCode = position.code;
      }
      return position.code + " | " + rupiah(value) + " → " + rupiah(value + impact) + " | Dampak " + rupiah(impact);
    });
    return [...lines, "", ...(changes ? [
      "Nilai awal       " + rupiah(current),
      "Nilai simulasi   " + rupiah(projected),
      "Dampak skenario  " + rupiah(projected - current) + " (" + percent((projected - current) / current * 100) + ")",
      ...(biggestCode ? ["Dampak terbesar  " + biggestCode + " (" + rupiah(biggest) + ")"] : []),
    ] : [
      "Total modal      " + rupiah(cost),
      ...(complete ? [
        "Nilai portofolio " + rupiah(current),
        "P/L portofolio   " + rupiah(current - cost) + " (" + percent((current - cost) / cost * 100) + ")",
      ] : ["Nilai dan P/L menunggu kuotasi untuk setiap posisi."]),
    ])];
  }

  function alertListLines() {
    if (!alerts.length) return ["Belum ada price alert tersimpan."];
    return [
      "Daftar Price Alert:",
      ...alerts.map((a, i) => `  ${i + 1}. ${a.code} ${a.above ? ">=" : "<="} ${rupiah(a.target)} ${a.triggered ? "[TERPICU]" : "[AKTIF]"}`),
    ];
  }

  function pick(value: number) {
    setOutput([]);
    setInput("");
    if (value === 0) onQuit();
    else if (value === 10) onReturn();
    else if (value === 1) setStep({ kind: "search" });
    else if ([2, 4, 5, 6, 7].includes(value)) setStep({ kind: "code", action: value });
    else if (value === 3) {
      if (!watchlist.length) {
        finish(["Watchlist kosong. Tambahkan kode lewat menu 4."]);
        return;
      }
      finish(["KODE     HARGA            HARI INI", ...watchlist.map((code) =>
        code.padEnd(9) + rupiah(effectivePrice(code)).padEnd(17) + percent(effectiveChange(code)))]);
      void fetchCompare(watchlist).then((rows) => {
        if (rows.length) setOutput(formatCompareRows(rows));
      });
    } else if (value === 11) {
      setStep({ kind: "compare" });
    } else if (value === 12) {
      setOutput(alertListLines());
      setStep({ kind: "alert-action" });
    } else if (!positions.length) finish(["Portofolio kosong. Tambahkan posisi lewat menu 6."]);
    else if (value === 8) {
      finish(portfolio());
      void fetchCompare(positions.map((p) => p.code)).then((rows) => {
        const map = new Map<string, number>();
        for (const r of rows) if (!("error" in r)) map.set(r.code, r.price);
        if (map.size) setOutput(portfolio(undefined, map));
      });
    } else if (!allPricesAvailable()) finish(["Skenario membutuhkan kuotasi untuk setiap posisi."]);
    else {
      setOutput(["Masukkan persentase perubahan (contoh -5 atau 2,5)."]);
      setStep({ kind: "scenario", index: 0, changes: [] });
    }
  }

  function submit() {
    const value = input.trim();
    setInput("");
    if (step.kind === "choice") {
      if (/^(?:[0-9]|1[0-2])$/.test(value)) pick(Number(value));
      else setOutput(["Pilihan harus angka 0 sampai 12."]);
      return;
    }
    if (step.kind === "compare") {
      const codes = value.split(/[\s,]+/).map((s) => s.trim().toUpperCase().replace(/\.JK$/, "")).filter((s) => /^[A-Z]{4}$/.test(s));
      const unique = [...new Set(codes)].slice(0, 8);
      if (!unique.length) {
        finish(["Masukkan 1–8 kode saham (contoh: BBCA,BBRI,BMRI)."]);
        return;
      }
      finish(["Memuat perbandingan " + unique.join(", ") + "…"]);
      void fetchCompare(unique).then((rows) => setOutput(formatCompareRows(rows)));
      return;
    }
    if (step.kind === "alert-action") {
      if (!value) finish();
      else if (value === "1") { setOutput([]); setStep({ kind: "alert-code" }); }
      else if (value === "2") {
        if (!alerts.length) finish(["Belum ada alert untuk dihapus."]);
        else { setOutput(alertListLines()); setStep({ kind: "alert-delete" }); }
      } else setOutput([...alertListLines(), "Masukkan 1 (Tambah), 2 (Hapus), atau Enter untuk kembali."]);
      return;
    }
    if (step.kind === "alert-code") {
      const code = value.toUpperCase().replace(/\.JK$/, "");
      if (!known.has(code)) setOutput(["Kode saham tidak ditemukan."]);
      else { setOutput([]); setStep({ kind: "alert-target", code }); }
      return;
    }
    if (step.kind === "alert-target") {
      let raw = value;
      let above: boolean | null = null;
      if (raw.startsWith(">") || raw.startsWith("<")) {
        above = raw[0] === ">";
        raw = raw.slice(1).replace(/^=/, "").trim();
      }
      const target = raw ? Number(raw.replace(",", ".")) : NaN;
      if (!Number.isFinite(target) || target <= 0 || target > 1_000_000_000) {
        setOutput(["Format tidak valid. Contoh: >6000 atau <5500."]);
        return;
      }
      const curr = effectivePrice(step.code);
      const isAbove = above ?? (curr == null || target >= curr);
      finish([onAddAlert(step.code, target, isAbove)]);
      return;
    }
    if (step.kind === "alert-delete") {
      const idx = Number(value);
      if (!Number.isInteger(idx) || idx < 1 || idx > alerts.length) {
        setOutput([...alertListLines(), `Masukkan nomor 1 sampai ${alerts.length}.`]);
        return;
      }
      const targetAlert = alerts[idx - 1];
      onRemoveAlert(targetAlert.id);
      finish([`Alert ${targetAlert.code} dihapus.`]);
      return;
    }
    if (step.kind === "search") {
      const terms = value.toLowerCase().split(/\s+/).filter(Boolean);
      const results = value.length < 2 ? [] : stockList.filter((stock) =>
        terms.every((term) => (stock.code + " " + stock.name).toLowerCase().includes(term))).slice(0, 30);
      if (value.length >= 2 && matchesIndex(value)) results.unshift(ihsg);
      if (!results.length) finish(["Tidak ada hasil saham IDX."]);
      else {
        setOutput(results.map((stock) => stock.code + "  " + stock.name));
        setStep({ kind: "search-price" });
      }
      return;
    }
    if (step.kind === "search-price" || step.kind === "code") {
      const ticker = value.toUpperCase().replace(/\.JK$/, "");
      const code = ["^JKSE", "JKSE", "COMPOSITE"].includes(ticker) ? ihsg.code : ticker;
      if (!value && step.kind === "search-price") finish();
      else if (code === ihsg.code) {
        if (step.kind === "search-price" || step.action === 2) openQuote(code);
        else finish(["IHSG tersedia di tab Pasar sebagai indeks."]);
      } else if (!known.has(code)) setOutput(["Kode saham tidak ditemukan."]);
      else if (step.kind === "search-price" || step.action === 2) openQuote(code);
      else if (step.action === 4 || step.action === 5) {
        const exists = watchlist.includes(code);
        if (step.action === 4 && exists) finish(["Kode sudah ada di watchlist."]);
        else if (step.action === 5 && !exists) finish(["Kode belum ada di watchlist."]);
        else finish([onWatch(code)]);
      } else if (step.action === 7) {
        const next = positions.filter((position) => position.code !== code);
        if (next.length === positions.length) finish(["Posisi belum ada."]);
        else { save(next); finish(["Portofolio tersimpan."]); }
      } else if (positions.length >= 8 && !positions.some((position) => position.code === code))
        finish(["Portofolio maksimal 8 saham."]);
      else setStep({ kind: "lots", code });
      return;
    }

    const amount = value ? Number(value.replace(",", ".")) : NaN;
    if (step.kind === "lots") {
      if (!Number.isInteger(amount) || amount < 1 || amount > 100_000) setOutput(["Jumlah lot harus 1 sampai 100000."]);
      else { setOutput([]); setStep({ kind: "buy", code: step.code, lots: amount }); }
    } else if (step.kind === "buy") {
      if (!Number.isFinite(amount) || amount < .01 || amount > 1_000_000_000) setOutput(["Harga beli di luar batas."]);
      else {
        const next = { code: step.code, lots: step.lots, buyPrice: amount };
        save([...positions.filter((position) => position.code !== step.code), next]);
        finish(["Portofolio tersimpan."]);
      }
    } else if (step.kind === "scenario") {
      if (!Number.isFinite(amount) || amount < -100 || amount > 1000) setOutput(["Perubahan harus -100 sampai 1000 persen."]);
      else {
        const changes = [...step.changes, amount];
        if (changes.length === positions.length) finish(portfolio(changes));
        else setStep({ kind: "scenario", index: step.index + 1, changes });
      }
    }
  }

  function cancel() {
    if (step.kind === "choice") onReturn();
    else { setInput(""); finish(); }
  }

  const needsText =
    step.kind === "search" ||
    step.kind === "search-price" ||
    step.kind === "code" ||
    step.kind === "compare" ||
    step.kind === "alert-code" ||
    step.kind === "alert-target";
  const digitKeys = Array.from({ length: 10 }, (_, index) => {
    const value = String((index + 1) % 10);
    return { value, text: value, label: "Angka " + value };
  });
  const decimalKeys: TouchKey[] = step.kind === "buy" || step.kind === "scenario" ? [
    { value: ",", text: ",", label: "Koma desimal" },
    ...(step.kind === "scenario" ? [{ value: "-", text: "−", label: "Tanda minus" }] : []),
  ] : [];
  const keys = needsText ? [[escapeKey, keyboardKey, backspaceKey, enterKey]] : [
    digitKeys.slice(0, 6), [...digitKeys.slice(6), backspaceKey, enterKey], [escapeKey, ...decimalKeys],
  ];

  function touchKey(value: string) {
    if (value === "escape") cancel();
    else if (value === "enter") submit();
    else if (value === "keyboard") {
      field.current?.blur();
      field.current?.focus();
    }
    else editWithKey(field.current, input, value, setInput);
  }

  const prompt =
    step.kind === "choice" ? "Pilihan (0-12):" :
    step.kind === "search" ? "Kode atau nama:" :
    step.kind === "search-price" ? "Kode untuk lihat harga (Enter untuk kembali):" :
    step.kind === "code" ? "Kode saham:" :
    step.kind === "compare" ? "2-8 kode saham (contoh BBCA,BBRI,BMRI):" :
    step.kind === "alert-action" ? "Aksi (1 Tambah, 2 Hapus, Enter Kembali):" :
    step.kind === "alert-code" ? "Kode saham untuk alert:" :
    step.kind === "alert-target" ? `Target ${step.code} (contoh >6000 atau <5500):` :
    step.kind === "alert-delete" ? "Nomor alert yang dihapus:" :
    step.kind === "lots" ? "Jumlah lot (1-100000):" :
    step.kind === "buy" ? "Harga beli per lembar:" :
    step.kind === "scenario" ? positions[step.index]?.code + " (%):" : "";

  return (
    <section className="cmd-menu" aria-label="Menu terminal">
      {step.kind === "choice" && <>
        <h2>========== STOCKWATCH | IDX ==========</h2>
        <div className="cmd-menu-choices">
          {menu.map(([key, label]) => <button key={key} type="button" onClick={() => pick(key)}>{key.toString().padStart(2)}  {label}</button>)}
        </div>
        <button type="button" onClick={onQuit}> 0  Keluar</button>
      </>}
      {output.length > 0 && <pre role="status">{output.join("\n")}</pre>}
      <form className="cmd-prompt" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <label htmlFor="cmd-menu-input">{prompt}</label>
        <input id="cmd-menu-input" ref={field} value={input} autoComplete="off" spellCheck={false}
          inputMode={needsText ? "text" : "none"} enterKeyHint="done"
          onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Escape") cancel();
          }} />
        <button type="submit">Enter</button>
      </form>
      <ClassicTouchKeys rows={keys} onKey={touchKey} />
    </section>
  );
}
