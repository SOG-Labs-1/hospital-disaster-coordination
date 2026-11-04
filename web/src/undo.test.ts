import { describe, expect, it } from 'vitest';
import { undoReason } from './undo';

describe('元に戻すときの理由', () => {
  const at = new Date('2026-11-05T10:00:00Z');
  it('1分以内なら「直後」', () => {
    expect(undoReason('2026-11-05T09:59:30Z', at)).toBe('記録の直後に元に戻した');
  });
  it('時間が経ってからなら、記録から何分後かを残す', () => {
    expect(undoReason('2026-11-05T09:47:00Z', at)).toBe('記録から13分後に元に戻した');
  });
});
