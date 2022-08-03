import { createClient, RedisClientOptions } from 'redis';
import '@redis/client';
import '@redis/bloom';
import '@redis/graph';
import '@redis/json';
import '@redis/search';
import '@redis/time-series';

import { Cache, CachingConfig } from 'cache-manager';

export interface CacheManagerOptions {
  ttl?: number;
  isCacheableValue?: (value: unknown) => boolean;
}

export type Awaited<T> = T extends Promise<infer U> ? U : never;
export type RedisStore = Awaited<ReturnType<typeof redisStore>>;

export interface RedisCache extends Cache {
  store: RedisStore;
}

export type RedisClientType = ReturnType<RedisStore['getClient']>;

const getVal = (value: unknown) => JSON.stringify(value) || '"undefined"';
export async function redisStore(
  options?: RedisClientOptions & CacheManagerOptions,
) {
  const isCacheableValue =
    options?.isCacheableValue ||
    ((value) => value !== undefined && value !== null);
  const redisCache = createClient(options);
  await redisCache.connect();

  return {
    name: 'redis' as const,
    isCacheableValue,
    getClient: () => redisCache,
    set: async <T>(key: string, value: T, ttl?: number | CachingConfig) => {
      if (!isCacheableValue(value))
        throw new Error(`"${value}" is not a cacheable value`);
      if (typeof ttl === 'object') {
        if (typeof ttl.ttl === 'function') ttl = ttl.ttl(value);
        else ttl = ttl.ttl;
      }

      if (ttl) await redisCache.setEx(key, ttl, getVal(value));
      else await redisCache.set(key, getVal(value));

      return value;
    },
    mset: async (args: [string, unknown][], ttl?: number) => {
      if (!ttl) ttl = options?.ttl;

      if (ttl) {
        const multi = redisCache.multi();
        for (const [key, value] of args) {
          if (!isCacheableValue(value))
            throw new Error(`"${getVal(value)}" is not a cacheable value`);
          multi.setEx(key, ttl, getVal(value));
        }
        await multi.exec();
      } else
        await redisCache.mSet(
          args.flatMap(([key, value]) => [key, getVal(value)]),
        );
    },
    get: async <T>(key: string) => {
      const val = await redisCache.get(key);
      if (val) return JSON.parse(val) as T;
    },
    mget: (...args: string[]) =>
      redisCache
        .mGet(args)
        .then((x) => x.map((x) => (x ? JSON.parse(x) : undefined))),
    del: (...args: [string] | string[]) => redisCache.del(args),
    reset: () => redisCache.flushDb(),
    keys: (pattern = '*') => redisCache.keys(pattern),
    ttl: (key: string) => redisCache.ttl(key),
  };
}
