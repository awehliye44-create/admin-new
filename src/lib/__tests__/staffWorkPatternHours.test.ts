import { describe, expect, it } from 'vitest';
import {
  applyShiftLengthPreset,
  buildDefaultSchedule,
  calculateDailyMinutes,
  calculateWeeklyMinutes,
  formatMinutesAsHours,
} from '../../../shared/staffWorkPatternHours';

describe('staffWorkPatternHours', () => {
  it('calculates 8-hour shift daily hours', () => {
    expect(calculateDailyMinutes('08:00', '16:00', 60)).toBe(7 * 60);
  });

  it('calculates 10-hour shift daily hours', () => {
    expect(calculateDailyMinutes('08:00', '18:00', 60)).toBe(9 * 60);
  });

  it('calculates 12-hour shift daily hours', () => {
    expect(calculateDailyMinutes('07:00', '19:00', 60)).toBe(11 * 60);
  });

  it('calculates night shift crossing midnight', () => {
    expect(calculateDailyMinutes('19:00', '07:00', 60)).toBe(11 * 60);
  });

  it('calculates weekly hours from working days', () => {
    const schedule = applyShiftLengthPreset(buildDefaultSchedule(true), '8h');
    expect(calculateWeeklyMinutes(schedule)).toBe(5 * 7 * 60);
    expect(formatMinutesAsHours(calculateWeeklyMinutes(schedule))).toBe('35h 00m');
  });

  it('custom shift uses provided times', () => {
    const schedule = buildDefaultSchedule(true);
    schedule[0] = {
      ...schedule[0],
      enabled: true,
      start_time: '09:30',
      end_time: '17:30',
      break_minutes: 30,
    };
    for (let i = 1; i < schedule.length; i += 1) {
      schedule[i].enabled = false;
    }
    expect(calculateDailyMinutes('09:30', '17:30', 30)).toBe(7 * 60 + 30);
  });
});
