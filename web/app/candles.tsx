"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { chartTime, compact, groupBars, ihsg, integer, periods, points, type Candle } from "../lib/market";

export type ChartIndicators = {
  ma5: boolean;
  ma20: boolean;
  prev: boolean;
  avg: boolean;
};

const green = "#3fb950";
const red = "#f85149";
const cyan = "#58a6ff";
const amber = "#e3b341";
const teal = "#3b9b83";

function roundStep(value: number) {
  const factor = 10 ** Math.floor(Math.log10(Math.max(value, 1)));
  return ([1, 2, 2.5, 5, 10].find((amount) => amount * factor >= value) ?? 10) * factor;
}

function movingAverage(bars: Candle[], windowSize: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length < windowSize) return out;
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= windowSize) sum -= bars[i - windowSize].close;
    if (i + 1 >= windowSize) out[i] = sum / windowSize;
  }
  return out;
}

export default function Candles({
  code,
  period,
  bars,
  previous,
  average,
  indicators,
}: {
  code: string;
  period: number;
  bars: Candle[];
  previous?: number | null;
  average?: number | null;
  indicators?: ChartIndicators;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const chart = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [cursor, setCursor] = useState<number | null>(null);
  const axisWidth = code === ihsg.code ? 75 : 62;
  const plotted = useMemo(
    () => groupBars(bars, Math.floor((size.width - axisWidth - 20) / 7)),
    [bars, size.width, axisWidth],
  );
  const ma5Series = useMemo(() => (indicators?.ma5 ? movingAverage(plotted, 5) : []), [plotted, indicators?.ma5]);
  const ma20Series = useMemo(() => (indicators?.ma20 ? movingAverage(plotted, 20) : []), [plotted, indicators?.ma20]);
  const format = code === ihsg.code ? points : integer.format;
  const hasVolume = bars.some((bar) => bar.volume > 0);
  const selected = cursor == null ? plotted.length - 1 : Math.min(cursor, plotted.length - 1);
  const candle = plotted[selected] ?? bars[bars.length - 1];
  const activeMa5 = indicators?.ma5 ? ma5Series[selected] ?? null : null;
  const activeMa20 = indicators?.ma20 ? ma20Series[selected] ?? null : null;

  useEffect(() => {
    const element = chart.current;
    if (!element) return;
    const resize = new ResizeObserver(([entry]) => {
      setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) });
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, []);

  useEffect(() => {
    const element = canvas.current;
    const { width, height } = size;
    if (!element || width < 100 || height < 100 || !plotted.length) return;
    const dpr = window.devicePixelRatio || 1;
    element.width = Math.round(width * dpr);
    element.height = Math.round(height * dpr);
    const ctx = element.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const left = 12, right = width - axisWidth;
    const top = 13, priceBottom = height - (hasVolume ? 79 : 33);
    const volumeTop = priceBottom + 9, volumeBottom = height - 29;
    let min = Math.min(...plotted.map((bar) => bar.low));
    let max = Math.max(...plotted.map((bar) => bar.high));
    const spanGuard = Math.max(max - min, max * 0.05);
    const includeRef = (val: number | null | undefined) => {
      if (val != null && val > 0 && val >= min - spanGuard * 0.5 && val <= max + spanGuard * 0.5) {
        min = Math.min(min, val);
        max = Math.max(max, val);
      }
    };
    if (indicators?.prev) includeRef(previous);
    if (indicators?.avg) includeRef(average);

    const interval = roundStep((max - min) / 5);
    const floor = Math.max(0, Math.floor(min / interval) * interval);
    const ceiling = Math.max(floor + interval, Math.ceil(max / interval) * interval);
    const maxVolume = Math.max(1, ...plotted.map((bar) => bar.volume));
    const step = (right - left) / plotted.length;
    const x = (index: number) => left + (index + 0.5) * step;
    const y = (price: number) => top + ((ceiling - price) / (ceiling - floor)) * (priceBottom - top);
    const text = (value: string, atX: number, atY: number, color = "#8b949e") => {
      ctx.fillStyle = color;
      ctx.fillText(value, atX, atY);
    };
    const line = (x1: number, y1: number, x2: number, y2: number, color: string, dash: number[] = [], lineWidth = 1) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    };

    ctx.font = '12px "IBM Plex Mono", Consolas, monospace';
    ctx.textBaseline = "middle";
    for (let price = floor; price <= ceiling; price += interval) {
      const at = y(price);
      line(left, at, right, at, "#30363d", [2, 4]);
      text(format(price), right + 8, at);
    }
    const tickCount = width > 490 ? 6 : 4;
    for (let i = 0; i < tickCount; i += 1) {
      const index = Math.round((i * (plotted.length - 1)) / (tickCount - 1));
      const at = x(index);
      line(at, top, at, volumeBottom, "#21262d", [2, 4]);
      const label = chartTime(i === tickCount - 1 ? bars[bars.length - 1].time : plotted[index].time, period);
      const labelWidth = ctx.measureText(label).width;
      text(label, Math.max(left, Math.min(right - labelWidth, at - labelWidth / 2)), height - 12);
    }
    line(left, volumeBottom, right, volumeBottom, "#30363d");
    line(right, top, right, volumeBottom, "#30363d");

    if (indicators?.prev && previous != null && previous >= floor && previous <= ceiling) {
      const py = y(previous);
      line(left, py, right, py, "#8b949e", [5, 4], 1);
      text("PREV", left + 4, Math.max(top + 8, py - 8), "#8b949e");
    }
    if (indicators?.avg && average != null && average >= floor && average <= ceiling) {
      const ay = y(average);
      line(left, ay, right, ay, teal, [3, 3], 1.2);
      text("AVG", left + 44, Math.max(top + 8, ay - 8), teal);
    }

    const barWidth = Math.min(13, Math.max(2, step * 0.56));
    plotted.forEach((bar, index) => {
      const at = x(index);
      const color = bar.close >= bar.open ? green : red;
      const candleTop = Math.min(y(bar.open), y(bar.close));
      line(at, y(bar.high), at, y(bar.low), color);
      ctx.fillStyle = color;
      ctx.fillRect(at - barWidth / 2, candleTop, barWidth, Math.max(2, Math.abs(y(bar.open) - y(bar.close))));
      if (bar.volume > 0) {
        const volumeHeight = Math.max(1, Math.round((bar.volume / maxVolume) * (volumeBottom - volumeTop)));
        ctx.globalAlpha = 0.44;
        ctx.fillRect(at - barWidth / 2, volumeBottom - volumeHeight, barWidth, volumeHeight);
        ctx.globalAlpha = 1;
      }
    });

    const drawSeries = (series: (number | null)[], color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < series.length; i++) {
        const val = series[i];
        if (val == null) continue;
        const px = x(i);
        const py = y(val);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
      if (started) ctx.stroke();
      ctx.lineWidth = 1;
    };

    if (indicators?.ma5 && ma5Series.length) drawSeries(ma5Series, cyan);
    if (indicators?.ma20 && ma20Series.length) drawSeries(ma20Series, amber);

    const last = plotted[plotted.length - 1];
    const lastY = y(last.close);
    line(left, lastY, right, lastY, teal, [4, 4]);
    ctx.fillStyle = "#203b2c";
    ctx.fillRect(right + 3, lastY - 10, axisWidth - 7, 20);
    text(format(last.close), right + 9, lastY, "#7ee787");

    if (cursor != null) {
      const at = x(selected);
      const atY = y(plotted[selected].close);
      line(at, top, at, volumeBottom, "#748ba4", [3, 4]);
      line(left, atY, right, atY, "#748ba4", [3, 4]);
      ctx.fillStyle = "#ecf5ff";
      ctx.beginPath();
      ctx.arc(at, atY, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [size, bars, plotted, period, cursor, selected, format, hasVolume, axisWidth, previous, average, indicators, ma5Series, ma20Series]);

  function move(event: PointerEvent<HTMLCanvasElement>) {
    const offset = event.clientX - event.currentTarget.getBoundingClientRect().left - 12;
    const span = size.width - axisWidth - 12;
    if (span <= 0) return;
    setCursor(Math.max(0, Math.min(plotted.length - 1, Math.floor((offset / span) * plotted.length))));
  }

  function inspect(event: KeyboardEvent<HTMLCanvasElement>) {
    if (event.key === "Escape") setCursor(null);
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const moveBy = event.key === "ArrowLeft" ? -1 : 1;
    setCursor(Math.max(0, Math.min(plotted.length - 1, selected + moveBy)));
  }

  return (
    <div className="chart-block">
      <div className="chart-legend">
        <span className="chart-interval">{cursor == null ? "OHLC " + periods[period].interval : chartTime(candle.time, period)}</span>
        <span>O <b>{format(candle.open)}</b></span>
        <span>H <b>{format(candle.high)}</b></span>
        <span>L <b>{format(candle.low)}</b></span>
        <span>C <b>{format(candle.close)}</b></span>
        {hasVolume && <span className="volume-legend">VOL <b>{candle.volume > 0 ? compact(candle.volume) : "--"}</b></span>}
        {activeMa5 != null && <span className="ma5-legend">MA5 <b>{format(activeMa5)}</b></span>}
        {activeMa20 != null && <span className="ma20-legend">MA20 <b>{format(activeMa20)}</b></span>}
      </div>
      <div className="chart-canvas" ref={chart}>
        <canvas
          ref={canvas}
          tabIndex={0}
          aria-label={"Grafik " + code + " " + periods[period].label + ". Panah kiri dan kanan memeriksa candle."}
          onPointerMove={move}
          onPointerLeave={() => setCursor(null)}
          onKeyDown={inspect}
          onBlur={() => setCursor(null)}
        />
      </div>
    </div>
  );
}
