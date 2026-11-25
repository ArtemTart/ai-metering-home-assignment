export interface ServerConfig {
  port: number;
  simulatorIntervalMs: number;
  maxActivity: number;
  minTasks: number;
  maxTasks: number;
  sseHeartbeatMs: number;
}

/**
 * Reads and validates the environment. Any invalid value throws, so the server refuses to start
 * instead of running with e.g. a NaN interval (which would break the simulator).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const errors: string[] = [];

  const int = (name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!/^-?\d+$/.test(raw) || value < min || value > max) {
      errors.push(`${name} must be a whole number between ${min} and ${max}, got "${env[name]}"`);
      return fallback;
    }
    return value;
  };

  const config: ServerConfig = {
    port: int('PORT', 3001, 1, 65535),
    simulatorIntervalMs: int('SIMULATOR_INTERVAL_MS', 4000, 500),
    maxActivity: int('MAX_ACTIVITY', 50, 1, 1000),
    minTasks: int('MIN_TASKS', 3, 1, 100),
    maxTasks: int('MAX_TASKS', 15, 1, 1000),
    sseHeartbeatMs: int('SSE_HEARTBEAT_MS', 15_000, 1000),
  };

  if (config.minTasks > config.maxTasks) errors.push('MIN_TASKS must be <= MAX_TASKS');
  if (errors.length > 0) throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  return config;
}
