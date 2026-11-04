import { describe, expect, it } from 'vitest';
import { timeInputNote, timeInputToDate } from './format';

describe('時刻入力（HH:MM）の日付', () => {
  const at = (h: number, m: number) => new Date(2026, 10, 5, h, m, 0, 0);

  it('今より前の時刻は今日の時刻', () => {
    const d = timeInputToDate('09:30', at(10, 0))!;
    expect(d.getDate()).toBe(5);
    expect(d.getHours()).toBe(9);
    expect(timeInputNote('09:30', at(10, 0))).toBeNull();
  });

  it('日付をまたいだ直後に前日の夜の時刻を入れると、前日として扱い説明を出す', () => {
    const d = timeInputToDate('23:50', at(0, 10))!;
    expect(d.getDate()).toBe(4);
    expect(d.getHours()).toBe(23);
    expect(timeInputNote('23:50', at(0, 10))).toBe('前日（11/4）の 23:50 として記録します');
  });

  it('時計の小さなずれ（数分先）は今日のまま', () => {
    expect(timeInputToDate('10:03', at(10, 0))!.getDate()).toBe(5);
  });

  it('空欄は「今」（undefined）', () => {
    expect(timeInputToDate('', at(10, 0))).toBeUndefined();
  });
});
