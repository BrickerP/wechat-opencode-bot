// Routine schedules: when a routine is next due, and how /routine shows it. Pure: no state.db, OpenCode or WeChat.
import { formatTime } from './orchestrator.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Asia/Shanghai is UTC+8 all year: China has no daylight saving time. */
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;

// A phone's Chinese keyboard types "：".
const DAILY = /^daily(\d{1,2})[:：](\d{2})$/i;
const EVERY = /^every(\d+)([mh])$/i;
const MIN_INTERVAL_MS = 5 * MINUTE_MS;
const MAX_INTERVAL_MS = DAY_MS;

export interface Schedule {
  /** The canonical form state.db stores: daily09:00, every30m, every2h. */
  spec: string;
  /**
   * When the routine is next due, always after now. after is the slot the run at now was due at; only an
   * interval uses it.
   */
  nextRunAt(now: number, after?: number): number;
}

/** dailyHH:MM on a 24-hour clock in Asia/Shanghai, everyNm (N ≥ 5) or everyNh (N ≤ 24), in any case; null for anything else. */
export function parseSchedule(text: string): Schedule | null {
  const daily = DAILY.exec(text.trim());
  if (daily) {
    const hours = Number(daily[1]);
    const minutes = Number(daily[2]);
    if (hours > 23 || minutes > 59) return null;
    const time = hours * HOUR_MS + minutes * MINUTE_MS;
    return {
      spec: `daily${daily[1].padStart(2, '0')}:${daily[2]}`,
      nextRunAt(now) {
        // Midnight of now's date in Shanghai.
        const midnight = Math.floor((now + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS;
        const today = midnight + time;
        return today > now ? today : today + DAY_MS;
      },
    };
  }
  const every = EVERY.exec(text.trim());
  if (!every) return null;
  const n = Number(every[1]);
  const unit = every[2].toLowerCase();
  const interval = n * (unit === 'h' ? HOUR_MS : MINUTE_MS);
  if (interval < MIN_INTERVAL_MS || interval > MAX_INTERVAL_MS) return null;
  return {
    spec: `every${n}${unit}`,
    // Up to one interval late, a run keeps the rhythm, so the tick's delay does not add up. Later than that,
    // as after the bot was down, the routine counts from now: the runs it missed are not made up.
    nextRunAt: (now, after) => (after !== undefined && after <= now && now - after < interval ? after : now) + interval,
  };
}

/** "每天 09:00", "每 30 分钟", "每 2 小时"; a spec that is none of them as it is. */
export function formatSchedule(spec: string): string {
  const [, time] = /^daily(\d\d:\d\d)$/.exec(spec) ?? [];
  if (time) return `每天 ${time}`;
  const [, n, unit] = /^every(\d+)([mh])$/.exec(spec) ?? [];
  return n ? `每 ${n} ${unit === 'h' ? '小时' : '分钟'}` : spec;
}

/** "11-10 09:00" in Asia/Shanghai: formatTime without the year. */
export const nextRunText = (ms: number): string => formatTime(ms).slice(5);
