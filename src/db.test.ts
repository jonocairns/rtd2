import { beforeEach, describe, expect, it } from 'vitest';
import {
  getStoreValue,
  getStoredMediaTitle,
  resetDbForTests,
  setDbClockForTests,
  setStoreValue,
  storeMediaTitle,
} from './db.js';

describe('local database store', () => {
  beforeEach(() => {
    resetDbForTests(':memory:');
  });

  it('stores and reads generic values', () => {
    setStoreValue('test', 'key', { ok: true });

    expect(getStoreValue('test', 'key', 1000)).toEqual({ ok: true });
  });

  it('expires values by ttl', () => {
    let currentTime = 100;
    setDbClockForTests(() => currentTime);
    setStoreValue('test', 'key', { ok: true });

    currentTime = 200;
    expect(getStoreValue('test', 'key', 101)).toEqual({ ok: true });
    expect(getStoreValue('test', 'key', 99)).toBeNull();
  });

  it('stores and reads media titles', () => {
    storeMediaTitle({ mediaType: 'movie', tmdbId: 603, title: 'The Matrix', year: '1999' });

    expect(getStoredMediaTitle('movie', 603)).toEqual({
      mediaType: 'movie',
      tmdbId: 603,
      title: 'The Matrix',
      year: '1999',
    });
  });

  it('reset switches database instances cleanly', () => {
    setStoreValue('test', 'key', { db: 1 });

    resetDbForTests(':memory:');

    expect(getStoreValue('test', 'key', 1000)).toBeNull();
  });
});
