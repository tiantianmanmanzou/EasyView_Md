import { describe, expect, it, vi } from 'vitest';
import { ExternalFollowController } from './ExternalFollowController';

describe('ExternalFollowController', () => {
  it('follows external hunks from top to bottom and ignores stale revisions', async () => {
    vi.useFakeTimers();
    const reveal = vi.fn();
    const controller = new ExternalFollowController(reveal, 10);
    controller.enqueue('a\nb\nc\nd\n', 'A\nb\nC\nd\ne\n', 2);
    controller.enqueue('a\nb\nc\nd\n', 'A\nb\nC\nd\ne\n', 1);
    expect(reveal).toHaveBeenCalledWith(1);
    vi.advanceTimersByTime(10);
    expect(reveal).toHaveBeenCalledWith(3);
    vi.advanceTimersByTime(10);
    expect(reveal).toHaveBeenCalledWith(5);
    vi.useRealTimers();
  });

  it('does not reveal when disabled', () => {
    const reveal = vi.fn();
    const controller = new ExternalFollowController(reveal);
    controller.setEnabled(false);
    controller.enqueue('a', 'b', 1);
    expect(reveal).not.toHaveBeenCalled();
  });
});
