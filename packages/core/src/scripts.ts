import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

// All scripts take the time from Redis (TIME) so instances with skewed clocks agree.

/**
 * KEYS: idempotencyKey, streamKey. ARGV: ttlSeconds, trimTokenCount, trimToken..., field, value, ...
 * Stores the event unless the idempotency key was already used; returns the event id either way.
 */
export const EMIT_IDEMPOTENT = `
local existing = redis.call('GET', KEYS[1])
if existing then return existing end
local trimCount = tonumber(ARGV[2])
local args = {}
for i = 3, 2 + trimCount do table.insert(args, ARGV[i]) end
table.insert(args, '*')
for i = 3 + trimCount, #ARGV do table.insert(args, ARGV[i]) end
local id = redis.call('XADD', KEYS[2], unpack(args))
redis.call('SET', KEYS[1], id, 'EX', ARGV[1])
return id
`;

/**
 * KEYS: retryKey. ARGV: leaseMs, count.
 * Claims due retries: bumps their attempt and re-schedules them after the lease, so an instance
 * that dies mid-handling does not lose them. Returns the claimed members.
 */
export const RETRY_CLAIM = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, ARGV[2])
local out = {}
for _, member in ipairs(due) do
  local ev = cjson.decode(member)
  ev.attempt = ev.attempt + 1
  local claimed = cjson.encode(ev)
  redis.call('ZREM', KEYS[1], member)
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[1]), claimed)
  table.insert(out, claimed)
end
return out
`;

/**
 * KEYS: retryKey, streamKey. ARGV: consumer, entryId ('' if none), oldMember ('' if none),
 * newMember, delayMs.
 * Schedules a retry and releases the failed delivery in one step.
 */
export const RETRY_SCHEDULE = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
if ARGV[3] ~= '' then redis.call('ZREM', KEYS[1], ARGV[3]) end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[5]), ARGV[4])
if ARGV[2] ~= '' then redis.call('XACK', KEYS[2], ARGV[1], ARGV[2]) end
return 1
`;

/**
 * KEYS: retryKey, streamKey, dlqKey. ARGV: consumer, entryId ('' if none), oldMember ('' if none),
 * maxLen, field, value, ...
 * Writes the dead-letter entry and releases the failed delivery in one step.
 */
export const DEAD_LETTER = `
redis.call('XADD', KEYS[3], 'MAXLEN', '~', ARGV[4], '*', unpack(ARGV, 5))
if ARGV[3] ~= '' then redis.call('ZREM', KEYS[1], ARGV[3]) end
if ARGV[2] ~= '' then redis.call('XACK', KEYS[2], ARGV[1], ARGV[2]) end
return 1
`;

const shas = new Map<string, string>();

export async function runScript(
  client: Redis,
  script: string,
  keys: string[],
  args: Array<string | number>,
): Promise<unknown> {
  let sha = shas.get(script);
  if (!sha) {
    sha = createHash('sha1').update(script).digest('hex');
    shas.set(script, sha);
  }
  try {
    return await client.call('EVALSHA', sha, keys.length, ...keys, ...args);
  } catch (error) {
    if (!String(error).includes('NOSCRIPT')) throw error;
    return client.call('EVAL', script, keys.length, ...keys, ...args);
  }
}
