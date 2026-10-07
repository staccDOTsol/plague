// Bound public endpoints that make paid Solana RPC requests. Each limiter has
// both a per-client and a process-wide budget for a fixed time window.
export function rateLimit({ windowMs = 60_000, perIp, global }) {
  if (!Number.isSafeInteger(windowMs) || windowMs < 1 ||
      !Number.isSafeInteger(perIp) || perIp < 1 ||
      !Number.isSafeInteger(global) || global < 1) {
    throw new Error('Invalid rate-limit configuration');
  }
  const clients = new Map();
  let globalWindowStart = Date.now();
  let globalCount = 0;

  return (request, response, next) => {
    const now = Date.now();
    if (now - globalWindowStart >= windowMs) {
      clients.clear();
      globalWindowStart = now;
      globalCount = 0;
    }
    const ip = request.ip || 'unknown';
    let client = clients.get(ip);
    if (!client || now - client.startedAt >= windowMs) {
      client = { startedAt: now, count: 0 };
    }
    if (client.count >= perIp || globalCount >= global) {
      const clientRetry = client.count >= perIp ? windowMs - (now - client.startedAt) : 0;
      const globalRetry = globalCount >= global ? windowMs - (now - globalWindowStart) : 0;
      response.set('Cache-Control', 'no-store');
      response.set('Retry-After', String(Math.max(1, Math.ceil(Math.max(clientRetry, globalRetry) / 1000))));
      return response.status(429).json({ error: 'Rate limit reached. Try again shortly.' });
    }
    client.count++;
    globalCount++;
    clients.set(ip, client);
    next();
  };
}
