import { callbackify } from 'node:util';
import { createClient, RedisClientOptions, RedisClientType } from 'redis';
import '@redis/client';
import '@redis/bloom';
import '@redis/graph';
import '@redis/json';
import '@redis/search';
import '@redis/time-series';

import { Cache, Store } from 'cache-manager';

type CachingConfig = {
  ttl?: number | ((value: unknown) => number);
};

type CB<T> = (err: NodeJS.ErrnoException | null, result: T | null) => void;

type CBSet = (err: NodeJS.ErrnoException | null) => void;

export interface CacheManagerOptions {
  ttl?: number;
  isCacheableValue?: (value: unknown) => boolean;
}

export interface RedisCache extends Cache {
  store: RedisStore;
  set: RedisStore['set'];
  get: RedisStore['get'];
  del: RedisStore['del'];
  reset: RedisStore['reset'];
}

export interface RedisStore extends Store {
  name: 'redis';
  isCacheableValue: (value: unknown) => boolean;
  get getClient(): RedisClientType;
  set<T>(key: string, value: T, options?: CachingConfig): Promise<void>;
  set<T>(key: string, value: T, ttl: number): Promise<void>;
  set<T>(key: string, value: T, options: CachingConfig, callback: CBSet): void;
  set<T>(key: string, value: T, ttl: number, callback: CBSet): void;

  get<T>(key: string, opt: null, callback: CB<T>): void;
  get<T>(key: string): Promise<T | undefined>;

  del(key: string, callback: CBSet): void;
  del(key: string[], callback: CBSet): void;
  del(key: string): Promise<void>;
  del(key: string[]): Promise<void>;

  reset(): Promise<void>;
  reset(cb: () => void): void;

  mset(args: [string, unknown][], ttl?: number): Promise<void>;

  mget(...args: string[]): Promise<unknown[]>;

  keys(pattern: string | undefined, cb: CB<string[]>): void;
  keys(pattern?: string): Promise<string[]>;

  ttl(key: string): Promise<number>;
}

const getVal = (value: unknown) => JSON.stringify(value) || '"undefined"';
export async function redisStore(
  options?: RedisClientOptions & CacheManagerOptions,
) {
  const isCacheableValue =
    options?.isCacheableValue ||
    ((value) => value !== undefined && value !== null);
  const redisCache = createClient(options);
  await redisCache.connect();
  const get = async <T>(key: string) => {
    const val = await redisCache.get(key);
    if (val) return JSON.parse(val) as T;
    else return null;
  };

  const set = async <T>(
    key: string,
    value: T,
    ttl: number | CachingConfig | undefined,
  ) => {
    if (!isCacheableValue(value))
      throw new Error(`"${value}" is not a cacheable value`);
    if (typeof ttl === 'object') {
      if (typeof ttl.ttl === 'function') ttl = ttl.ttl(value);
      else ttl = ttl.ttl;
    }

    if (ttl) await redisCache.setEx(key, ttl, getVal(value));
    else await redisCache.set(key, getVal(value));
  };
  const reset = async () => {
    await redisCache.flushDb();
  };

  return {
    name: 'redis' as const,
    isCacheableValue,
    get getClient() {
      return redisCache;
    },
    set<T>(key: string, value: T, ttl?: number | CachingConfig, cb?: CBSet) {
      if (typeof cb === 'function') callbackify(set<T>)(key, value, ttl, cb);
      else return set<T>(key, value, ttl);
    },
    // TODO: callbackify
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
          args.map(([key, value]) => {
            if (!isCacheableValue(value))
              throw new Error(`"${getVal(value)}" is not a cacheable value`);
            return [key, getVal(value)] as [string, string];
          }),
        );
    },
    get<T>(key: string, opt?: null, cb?: CB<T>) {
      if (typeof cb === 'function') callbackify(get<T>)(key, cb);
      else return get<T>(key);
    },
    // TODO: callbackify
    mget: (...args: string[]) =>
      redisCache
        .mGet(args)
        .then((x) => x.map((x) => (x === null ? null : JSON.parse(x)))),
    del(args: string | string[], cb?: CBSet) {
      const fn = async () => {
        await redisCache.del(args);
      };
      if (typeof cb === 'function') callbackify(fn)(cb);
      else return fn();
    },
    reset(cb?: CBSet) {
      if (typeof cb === 'function') callbackify(reset)(cb);
      else return reset();
    },
    keys(pattern = '*', cb?: CB<string[]>) {
      if (typeof cb === 'function')
        callbackify(() => redisCache.keys(pattern))(cb);
      else return redisCache.keys(pattern);
    },
    ttl: (key: string) => redisCache.ttl(key),
  } as RedisStore;
}
