import { initialWatchlist, stocks } from "./market";

const watchlistKey = "stockwatch-web-watchlist";
const positionKey = "stockwatch-web-positions";
const alertKey = "stockwatch-web-alerts";
const legacyWatchlistKey = "pantau-saham-web-watchlist";
const legacyPositionKey = "pantau-saham-web-positions";
const legacyAlertKey = "pantau-saham-web-alerts";
const codes = new Set(stocks.map((stock) => stock.code));

export const maxWatchlist = 8;
export const maxPositions = 8;
export const maxAlerts = 12;

export type Position = { code: string; lots: number; buyPrice: number };

export type PriceAlert = {
  id: string;
  code: string;
  target: number;
  above: boolean;
  triggered: boolean;
};

export function readWatchlist(): string[] {
  try {
    const stored = window.localStorage.getItem(watchlistKey) ?? window.localStorage.getItem(legacyWatchlistKey);
    if (stored !== null) {
      const values: unknown = JSON.parse(stored);
      if (Array.isArray(values)) {
        return [...new Set(values.filter((value): value is string =>
          typeof value === "string" && (codes.has(value) || /^[A-Z]{4}$/.test(value))))].slice(0, maxWatchlist);
      }
    }
  } catch {
    // Browser dapat membatasi localStorage.
  }
  return initialWatchlist;
}

export function saveWatchlist(values: string[]) {
  try {
    window.localStorage.setItem(watchlistKey, JSON.stringify(values.slice(0, maxWatchlist)));
  } catch {
    // Watchlist masih dapat dipakai untuk sesi ini.
  }
}

export function readPositions(): Position[] {
  try {
    const item: unknown = JSON.parse(
      window.localStorage.getItem(positionKey) ?? window.localStorage.getItem(legacyPositionKey) ?? "[]",
    );
    if (Array.isArray(item)) {
      return item
        .filter((position): position is Position =>
          Boolean(position) &&
          typeof position.code === "string" &&
          (codes.has(position.code) || /^[A-Z]{4}$/.test(position.code)) &&
          Number.isInteger(position.lots) &&
          position.lots >= 1 &&
          position.lots <= 100_000 &&
          Number.isFinite(position.buyPrice) &&
          position.buyPrice >= 0.01 &&
          position.buyPrice <= 1_000_000_000,
        )
        .slice(0, maxPositions);
    }
  } catch {
    // Portofolio tetap tersedia untuk sesi ini.
  }
  return [];
}

export function savePositions(values: Position[]) {
  try {
    window.localStorage.setItem(positionKey, JSON.stringify(values.slice(0, maxPositions)));
  } catch {
    // Portofolio tetap tersedia untuk sesi ini.
  }
}

export function readAlerts(): PriceAlert[] {
  try {
    const raw: unknown = JSON.parse(
      window.localStorage.getItem(alertKey) ?? window.localStorage.getItem(legacyAlertKey) ?? "[]",
    );
    if (Array.isArray(raw)) {
      return raw
        .filter((item): item is PriceAlert =>
          Boolean(item) &&
          typeof item.code === "string" &&
          /^[A-Z]{4}$/.test(item.code) &&
          typeof item.target === "number" &&
          Number.isFinite(item.target) &&
          item.target > 0 &&
          item.target <= 1_000_000_000 &&
          typeof item.above === "boolean",
        )
        .map((item, idx) => ({
          id: typeof item.id === "string" && item.id ? item.id : `${item.code}-${item.target}-${idx}`,
          code: item.code,
          target: item.target,
          above: item.above,
          triggered: Boolean(item.triggered),
        }))
        .slice(0, maxAlerts);
    }
  } catch {
    // Alert tetap tersedia untuk sesi ini.
  }
  return [];
}

export function saveAlerts(values: PriceAlert[]) {
  try {
    window.localStorage.setItem(alertKey, JSON.stringify(values.slice(0, maxAlerts)));
  } catch {
    // Alert tetap tersedia untuk sesi ini.
  }
}

export function playAlertBeep() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1174, ctx.currentTime + 0.11);
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.29);
    window.setTimeout(() => void ctx.close().catch(() => {}), 450);
  } catch {
    // Abaikan jika browser memblokir audio otomatis.
  }
}
