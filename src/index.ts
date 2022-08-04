import { callbackify } from 'node:util';
import {
  createClient,
  createCluster,
  RedisClientOptions,
  RedisClientType,
  RedisClusterOptions,
  RedisClusterType,
} from 'redis';
import '@redis/client';
import '@redis/bloom';
import '@redis/graph';
import '@redis/json';
import '@redis/search';
import '@redis/time-series';

import type { Cache, Store } from 'cache-manager';

type CachingConfig = {
  ttl?: number | ((value: unknown) => number);
};

type CB<T> = (err: NodeJS.ErrnoException | null, result: T | null) => void;

type CBSet = (err: NodeJS.ErrnoException | null) => void;

export interface CacheManagerOptions {
  ttl?: number;
  isCacheableValue?: (value: unknown) => boolean;
}

type Clients = RedisClientType | RedisClusterType;

export interface RedisCache<T extends Clients = RedisClientType> extends Cache {
  store: RedisStore<T>;
  set: RedisStore<T>['set'];
  get: RedisStore<T>['get'];
  del: RedisStore<T>['del'];
  reset: RedisStore<T>['reset'];
}

type Name<T extends Clients> = T extends RedisClientType
  ? 'redis'
  : T extends RedisClusterType
  ? 'redis-cluster'
  : never;

export interface RedisStore<T extends Clients = RedisClientType> extends Store {
  name: Name<T>;
  isCacheableValue: (value: unknown) => boolean;
  get getClient(): T;

  set<T>(key: string, value: T, options: CachingConfig, callback: CBSet): void;
  set<T>(key: string, value: T, ttl: number, callback: CBSet): void;
  set<T>(key: string, value: T, options?: CachingConfig): Promise<void>;
  set<T>(key: string, value: T, ttl: number): Promise<void>;

  get<T>(key: string, opt: null, callback: CB<T>): void;
  get<T>(key: string): Promise<T | undefined>;

  del(key: string, callback: CBSet): void;
  del(key: string[], callback: CBSet): void;
  del(key: string): Promise<void>;
  del(key: string[]): Promise<void>;

  reset(cb: () => void): void;
  reset(): Promise<void>;

  mset(args: [string, unknown][], ttl: number | undefined, cb: CBSet): void;
  mset(args: [string, unknown][], ttl?: number): Promise<void>;

  mget(...args: [...string[], CB<unknown[]>]): void;
  mget(...args: string[]): Promise<unknown[]>;

  keys(pattern: string | undefined, cb: CB<string[]>): void;
  keys(pattern?: string): Promise<string[]>;

  ttl(key: string, cb: CB<number>): void;
  ttl(key: string): Promise<number>;
}

const getVal = (value: unknown) => JSON.stringify(value) || '"undefined"';

export function builder<T extends Clients>(
  redisCache: T,
  name: Name<T>,
  reset: () => Promise<void>,
  keys: (pattern: string) => Promise<string[]>,
  options?: CacheManagerOptions,
) {
  const isCacheableValue =
    options?.isCacheableValue ||
    ((value) => value !== undefined && value !== null);

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

  const mset = async (args: [string, unknown][], ttl: number | undefined) => {
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
  };
  const mget = (...args: string[]) =>
    redisCache
      .mGet(args)
      .then((x) =>
        x.map((x) => (x === null ? null : (JSON.parse(x) as unknown))),
      );
  return {
    isCacheableValue,
    set<T>(key: string, value: T, ttl?: number | CachingConfig, cb?: CBSet) {
      if (typeof cb === 'function') callbackify(set<T>)(key, value, ttl, cb);
      else return set<T>(key, value, ttl);
    },
    get<T>(key: string, opt?: null, cb?: CB<T>) {
      if (typeof cb === 'function') callbackify(get<T>)(key, cb);
      else return get<T>(key);
    },
    mset(args: [string, unknown][], ttl?: number, cb?: CBSet) {
      if (typeof cb === 'function') callbackify(mset)(args, ttl, cb);
      else return mset(args, ttl);
    },
    mget(...args: [...string[], CB<unknown[]>]) {
      if (typeof args.at(-1) === 'function') {
        const cb = args.pop() as CB<unknown[]>;
        callbackify(() => mget(...(args as string[])))(cb);
      } else return mget(...(args as string[]));
    },
    del(args: string | string[], cb?: CBSet) {
      const fn = async () => {
        await redisCache.del(args);
      };
      if (typeof cb === 'function') callbackify(fn)(cb);
      else return fn();
    },

    ttl: (key: string, cb?: CB<number>) => {
      if (typeof cb === 'function') callbackify(() => redisCache.ttl(key))(cb);
      else return redisCache.ttl(key);
    },
    name,
    get getClient() {
      return redisCache;
    },
    reset(cb?: CBSet) {
      if (typeof cb === 'function') callbackify(reset)(cb);
      else return reset();
    },
    keys(pattern = '*', cb?: CB<string[]>) {
      if (typeof cb === 'function') callbackify(() => keys(pattern))(cb);
      else return keys(pattern);
    },
  } as RedisStore<T>;
}

// TODO: past instance as option
export async function redisStore(
  options?: RedisClientOptions & CacheManagerOptions,
) {
  const redisCache = createClient(options);
  await redisCache.connect();

  const reset = async () => {
    await redisCache.flushDb();
  };
  const keys = (pattern: string) => redisCache.keys(pattern);

  return builder(redisCache as RedisClientType, 'redis', reset, keys, options);
}

// TODO: coverage
export async function redisClusterStore(
  options: RedisClusterOptions & CacheManagerOptions,
) {
  const redisCache = createCluster(options);
  await redisCache.connect();

  const reset = async () => {
    await Promise.all(
      redisCache.getMasters().map((node) => node.client.flushDb()),
    );
  };

  const keys = async (pattern: string) =>
    (
      await Promise.all(
        redisCache.getMasters().map((node) => node.client.keys(pattern)),
      )
    ).flat();

  return builder(redisCache, 'redis-cluster', reset, keys, options);
}
