import { chartTime, groupBars, ihsg, integer, points as indexPoints, wib, type Candle } from "../lib/market";

export type ClassicIndicator = "none" | "ma5" | "ma20" | "prev";

const dateLabel = new Intl.DateTimeFormat("en-GB", {
  timeZone: wib, day: "2-digit", month: "2-digit", year: "2-digit",
});
const dayTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: wib, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const guides = [0, .5, 1];

export default function ClassicChart({
  bars,
  columns,
  rows,
  period,
  code,
  indicator = "none",
  previous,
}: {
  bars: Candle[];
  columns: number;
  rows: number;
  period: number;
  code: string;
  indicator?: ClassicIndicator;
  previous?: number | null;
}) {
  const points = groupBars(bars, Math.max(4, Math.floor((columns - 10) / 1.6)));
  const showPrev = indicator === "prev" && previous != null && previous > 0;
  let high = Math.max(...points.map((bar) => bar.high));
  let low = Math.min(...points.map((bar) => bar.low));
  if (showPrev && previous != null) {
    high = Math.max(high, previous);
    low = Math.min(low, previous);
  }
  const ceiling = high > low ? high : low + 1;
  const volume = Math.max(1, ...points.map((bar) => bar.volume));
  const showVolume = rows >= 9 && points.some((bar) => bar.volume > 0);
  const formatPrice = code === ihsg.code ? indexPoints : integer.format;
  const height = Math.max(3, rows - (showVolume ? 2 : 1));
  const y = (price: number) => ((ceiling - price) / (ceiling - low)) * 100;
  const pct = (value: number) => value + "%";
  const format = (time: number) => period === 0 ? chartTime(time, 0) :
    period === 1 ? dayTime.format(time).replace(",", "") : dateLabel.format(time);

  const maWindow = indicator === "ma5" ? 5 : indicator === "ma20" ? 20 : 0;
  const maValues: (number | null)[] = new Array(points.length).fill(null);
  if (maWindow > 0 && points.length >= maWindow) {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      sum += points[i].close;
      if (i >= maWindow) sum -= points[i - maWindow].close;
      if (i + 1 >= maWindow) maValues[i] = sum / maWindow;
    }
  }

  return (
    <div className="cmd-chart" data-index={code === ihsg.code} role="img" aria-label={"Grafik candlestick " + code}>
      <div aria-hidden="true">
        <div className="cmd-price-plot" style={{ height: "calc(var(--cmd-line) * " + height + ")" }}>
          <div className="cmd-chart-axis">
            {guides.map((fraction) => <span key={fraction} style={{ top: pct(fraction * 100) }}>
              {formatPrice(ceiling - (ceiling - low) * fraction)}
            </span>)}
          </div>
          <div className="cmd-chart-track">
            {guides.map((fraction) => <i className="cmd-chart-guide" key={fraction} style={{ top: pct(fraction * 100) }} />)}
            {showPrev && previous != null && (
              <i className="cmd-chart-prev" style={{ top: pct(y(previous)) }} />
            )}
            {points.map((point, idx) => {
              const bodyTop = y(Math.max(point.open, point.close));
              const ma = maValues[idx];
              return (
                <div key={point.time} className={"cmd-candle " + (point.close >= point.open ? "cmd-green" : "cmd-red")}>
                  <i className="cmd-wick" style={{ top: pct(y(point.high)), height: pct(y(point.low) - y(point.high)) }} />
                  <i className="cmd-candle-body" style={{ top: pct(bodyTop), height: pct(y(Math.min(point.open, point.close)) - bodyTop) }} />
                  {ma != null && (
                    <i
                      className={"cmd-ma-dot " + (indicator === "ma5" ? "cmd-cyan" : "cmd-amber")}
                      style={{ top: pct(y(ma)) }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {showVolume && (
          <div className="cmd-volume-plot">
            <span className="cmd-muted">VOL</span>
            <div className="cmd-chart-track">
              {points.map((point) => <div key={point.time} className="cmd-candle cmd-teal">
                {point.volume > 0 && <i className="cmd-volume-bar" style={{ height: pct((point.volume / volume) * 90) }} />}
              </div>)}
            </div>
          </div>
        )}
        <div className="cmd-chart-dates cmd-muted">
          <span>{format(bars[0].time)}</span>
          <span>{format(bars[Math.floor(bars.length / 2)].time)}</span>
          <span>{format(bars[bars.length - 1].time)}</span>
        </div>
      </div>
    </div>
  );
}
