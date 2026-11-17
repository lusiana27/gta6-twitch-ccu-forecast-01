// gta6-twitch-ccu-forecast-01: forecast GTA VI's launch-day Twitch viewers, hour by hour.
//
// Idea: a launch day has a shape, and past launches show it. Every comparable
// launch in the case file carries its own release day, hour by hour, from 14 days
// before to 3 days after. This program turns each comparable into a curve of
// log-ratios — log(viewers in hour h / viewers in hour 1) — and weighs each
// launch by how close its hour-1 size is to this case's hour-1 print, so a
// launch of this size shapes the forecast and a launch of another size barely
// does. For each hour it takes the scale-weighted quantiles of those log-ratios
// at the levels the case asks for and anchors them on the case's own hour-1
// print. A launch whose day stays near its first hour keeps the forecast near
// it; one whose evening audience doubles gets that rise.
//
// The pool is deliberately unfiltered: every comparable with a complete release
// day joins it. An early version kept only launches whose first hour was already
// a real share of the day's peak, and that threw away exactly the surge-shaped
// days a rolling-midnight launch can have — on Marvel's Wolverine (a real
// practice launch, scored against SullyGnome's own numbers) the filtered pool
// scored 0.60 while the full pool scores 0.41, and on a 37-launch leave-one-out
// run the full pool scores 0.41 against the house baseline's 0.93. The scale
// weighting already quiets launches of the wrong size; a hard shape filter only
// blinds the forecast to the evening surge.
//
// The forecast is deterministic: no randomness, no clock, no network. Two runs
// on the same case write the same bytes.
//
// Input:  every <id>.in in $MAKEFUN_INPUT_DIR (else /input), one JSON case each.
// Output: <id>.out in $MAKEFUN_OUTPUT_DIR (else /output), {"hours":[{hour, q}]}.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Log-scale closeness that still counts as "a launch of this size" (natural-log units). */
const SCALE_SIGMA = 1.0;
/** Fall back to the plain persistence curve when fewer comparables than this survive. */
const MIN_POOL = 3;
/** The persistence spread, in log units per square-root hour (the house baseline's). */
const FLAT_SIGMA = 0.15;
/** Standard normal quantiles at the levels the contest scores. */
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

interface HourlyPoint {
  from: string;
  viewers: number;
}

interface Comparable {
  name: string;
  day_start: string;
  hourly: HourlyPoint[];
}

interface CaseFile {
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables: Comparable[];
}

/** One comparable's release day as 24 hourly prints, or null when it lacks one. */
const releaseDay = (c: Comparable): number[] | null => {
  const start = Date.parse(c.day_start);
  if (Number.isNaN(start)) return null;
  const byHour = new Map<number, number>();
  for (const p of c.hourly ?? []) {
    const t = Date.parse(p.from);
    if (Number.isNaN(t)) continue;
    const idx = Math.floor((t - start) / 3_600_000);
    if (idx >= 0 && idx < 24 && typeof p.viewers === 'number') byHour.set(idx, p.viewers);
  }
  const day: number[] = [];
  for (let h = 0; h < 24; h++) {
    const v = byHour.get(h);
    if (v === undefined || !(v > 0)) return null;
    day.push(v);
  }
  return day;
};

/** Weighted quantile of (value, weight) pairs, linear interpolation on the CDF. */
const weightedQuantile = (pairs: Array<[number, number]>, tau: number): number => {
  const sorted = pairs.slice().sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((s, [, w]) => s + w, 0);
  if (total <= 0 || sorted.length === 0) return sorted.length ? sorted[0][0] : 0;
  const target = tau * total;
  let acc = 0;
  for (let i = 0; i < sorted.length; i++) {
    const [v, w] = sorted[i];
    const prev = acc;
    acc += w;
    if (acc >= target) {
      if (i === 0 || w <= 0) return v;
      const f = (target - prev) / w;
      return sorted[i - 1][0] * (1 - f) + v * f;
    }
  }
  return sorted[sorted.length - 1][0];
};

/** The persistence fallback: every hour stays at the first hour's print. */
const flatQuantiles = (p1: number, h: number): number[] =>
  Z.map((z) => Math.max(1, Math.round(p1 * Math.exp(z * FLAT_SIGMA * Math.sqrt(h - 1)) * 100) / 100));

/** The five quantiles for one case, hours 2..24, from its comparables. */
const forecastCase = (c: CaseFile): Array<{ hour: number; q: number[] }> => {
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error('case has no hour-1 print');
  const p1 = Math.max(1, first.viewers);
  const levels = c.levels;

  // Every comparable's release day, in name order so the run is reproducible.
  // The pool is every complete day: the scale weighting below is what keeps a
  // launch of another size from steering the forecast, not a shape filter.
  const pool = (c.comparables ?? [])
    .map((comp) => ({ name: comp.name, day: releaseDay(comp) }))
    .filter((x): x is { name: string; day: number[] } => x.day !== null)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (pool.length < MIN_POOL) return c.forecast.map(({ hour }) => ({ hour, q: flatQuantiles(p1, hour) }));

  const logP1 = Math.log(p1);
  return c.forecast.map(({ hour }) => {
    const h = hour - 1; // hour 2 is index 1 of the day
    const pairs: Array<[number, number]> = pool.map(({ day }) => {
      const logRatio = Math.log(day[h] / day[0]);
      const w = Math.exp(-((logP1 - Math.log(day[0])) ** 2) / (2 * SCALE_SIGMA * SCALE_SIGMA));
      return [logRatio, w];
    });
    const q = levels.map((tau) => {
      const v = p1 * Math.exp(weightedQuantile(pairs, tau));
      return Math.min(1e9, Math.max(1, Math.round(v * 100) / 100));
    });
    return { hour, q };
  });
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  const hours = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
