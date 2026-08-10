function readPositiveNumber(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!raw.trim() || !Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须是正数`);
  return value;
}

export function readAuthTokenTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, readPositiveNumber(env.AUTH_TOKEN_TTL_HOURS, 'AUTH_TOKEN_TTL_HOURS', 12)) * 60 * 60 * 1_000;
}
