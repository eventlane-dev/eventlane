import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatNumber,
  formatRelative,
  formatSize,
  formatTime,
} from '../src/format';
import { parseRoute, topicHref } from '../src/route';

describe('format', () => {
  it('formats durations in the largest sensible unit', () => {
    expect(formatDuration(0)).toBe('0 ms');
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(12_000)).toBe('12 s');
    expect(formatDuration(4 * 60_000)).toBe('4 min');
    expect(formatDuration(3 * 3_600_000)).toBe('3 h');
    expect(formatDuration(2 * 86_400_000)).toBe('2 d');
  });

  it('says how long ago or from now something is', () => {
    const now = 1_000_000;
    expect(formatRelative(now - 5000, now)).toBe('5 s ago');
    expect(formatRelative(now + 30_000, now)).toBe('in 30 s');
    expect(formatRelative(null)).toBe('-');
    expect(formatRelative(undefined)).toBe('-');
  });

  it('formats times, numbers and sizes', () => {
    expect(formatTime(null)).toBe('-');
    expect(formatTime(new Date(2026, 10, 10, 14, 2, 7).getTime())).toBe('2026-11-10 14:02:07');
    expect(formatNumber(12840)).toBe('12,840');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('route', () => {
  it('parses the hash into a view', () => {
    expect(parseRoute('')).toEqual({ view: 'topics' });
    expect(parseRoute('#/')).toEqual({ view: 'topics' });
    expect(parseRoute('#/topics/users/dlq')).toEqual({ view: 'topic', topic: 'users', tab: 'dlq' });
    expect(parseRoute('#/topics/users')).toEqual({ view: 'topic', topic: 'users', tab: 'events' });
    expect(parseRoute('#/topics/users/nonsense')).toEqual({
      view: 'topic',
      topic: 'users',
      tab: 'events',
    });
    expect(parseRoute('#/topics/a%20b/consumers')).toEqual({
      view: 'topic',
      topic: 'a b',
      tab: 'consumers',
    });
    expect(parseRoute('#/elsewhere')).toEqual({ view: 'topics' });
  });

  it('builds links that parse back', () => {
    for (const topic of ['users', 'a b', 'x.y-z']) {
      expect(parseRoute(topicHref(topic, 'consumers'))).toEqual({
        view: 'topic',
        topic,
        tab: 'consumers',
      });
    }
  });
});
