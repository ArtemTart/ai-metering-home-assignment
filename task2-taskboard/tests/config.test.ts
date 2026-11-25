import { describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.js';

describe('loadConfig', () => {
  it('uses defaults when nothing is set', () => {
    expect(loadConfig({})).toMatchObject({
      port: 3001,
      simulatorIntervalMs: 4000,
      maxActivity: 50,
      minTasks: 3,
      maxTasks: 15,
      sseHeartbeatMs: 15_000,
    });
  });

  it('parses valid values', () => {
    expect(loadConfig({ PORT: ' 3100 ', MAX_ACTIVITY: '20', MIN_TASKS: '2', MAX_TASKS: '10' })).toMatchObject({
      port: 3100,
      maxActivity: 20,
      minTasks: 2,
      maxTasks: 10,
    });
  });

  it.each([
    ['PORT', '70000'],
    ['MAX_ACTIVITY', '0'],
    ['SIMULATOR_INTERVAL_MS', 'abc'],
  ])('refuses to start with %s=%s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(new RegExp(name));
  });

  it('requires MIN_TASKS <= MAX_TASKS', () => {
    expect(() => loadConfig({ MIN_TASKS: '10', MAX_TASKS: '3' })).toThrow(/MIN_TASKS/);
  });
});
