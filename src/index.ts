import { callbackify } from 'node:util';
import { createClient, RedisClientOptions } from 'redis';
import '@redis/client';
import '@redis/bloom';
import '@redis/graph';
import '@redis/json';
import '@redis/search';
import '@redis/time-series';

export type WrapArgsType<T> =
  | string
  | ((callback: CB<T>) => void)
  | CachingConfig
  | CB<T>
  | (() => PromiseLike<T> | T);

type CachingConfig = {
  ttl: number | ((value: unknown) => number);
};
type CB<T> = (err: NodeJS.ErrnoException | null, result: T | null) => void;

type CBSet = (err: NodeJS.ErrnoException | null) => void;

export interface CacheManagerOptions {
  ttl?: number;
  isCacheableValue?: (value: unknown) => boolean;
}

export type Awaited<T> = T extends Promise<infer U> ? U : never;
export type RedisStore = Awaited<ReturnType<typeof redisStore>>;

export interface RedisCache {
  store: RedisStore;
  wrap<T>(...args: WrapArgsType<T>[]): Promise<T>;
  set: RedisStore['set'];
  get: RedisStore['get'];
  del: RedisStore['del'];
  reset: RedisStore['reset'];
}

export type RedisClientType = RedisStore['getClient'];

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

    return value;
  };
  return {
    name: 'redis' as const,
    isCacheableValue,
    get getClient() {
      return redisCache;
    },
    set: <T>(
      key: string,
      value: T,
      ttl?: number | CachingConfig,
      cb?: CBSet,
    ) => {
      if (typeof cb === 'function')
        callbackify(set<T>)(key, value, ttl, cb as CBSet);
      else return set<T>(key, value, ttl);
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
          args.map(([key, value]) => {
            if (!isCacheableValue(value))
              throw new Error(`"${getVal(value)}" is not a cacheable value`);
            return [key, getVal(value)] as [string, string];
          }),
        );
    },
    get: <T>(key: string, opt?: null, cb?: CB<T>) => {
      if (typeof cb === 'function') callbackify(get<T>)(key, cb);
      else return get<T>(key);
    },
    mget: (...args: string[]) =>
      redisCache
        .mGet(args)
        .then((x) => x.map((x) => (x === null ? null : JSON.parse(x)))),
    del: (args: string | string[], cb?: CB<number>) => {
      if (typeof cb === 'function') callbackify(() => redisCache.del(args))(cb);
      else return redisCache.del(args);
    },
    reset: (cb?: CB<string>) => {
      if (typeof cb === 'function') callbackify(redisCache.flushDb)(cb);
      else return redisCache.flushDb();
    },
    keys: (pattern = '*', cb?: CB<string[]>) => {
      if (typeof cb === 'function')
        callbackify(() => redisCache.keys(pattern))(cb);
      else return redisCache.keys(pattern);
    },
    ttl: (key: string) => redisCache.ttl(key),
  };
}
