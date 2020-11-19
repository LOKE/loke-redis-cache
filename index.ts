import { promisify } from "util";
import { Counter, Histogram, exponentialBuckets, Registry } from "prom-client";
import type { RedisClient } from "redis";

const queryCount = new Counter({
  name: "cache_queries_total",
  help: "Total number of cache lookups made.",
  labelNames: ["key"],
  registers: [],
});
const hitCount = new Counter({
  name: "cache_hits_total",
  help: "Total number of cache hits",
  // first_flight = false, indicates that the request reused an in flight promise
  labelNames: ["key", "first_flight"],
  registers: [],
});
const queryDuration = new Histogram({
  name: "cache_query_duration_seconds",
  help: "Latency of cache lookup",
  labelNames: ["key"],
  registers: [],
});

const setDuration = new Histogram({
  name: "cache_set_duration_seconds",
  help: "Latency of inserting a value into the cache",
  labelNames: ["key"],
  registers: [],
});
const deleteDuration = new Histogram({
  name: "cache_delete_duration_seconds",
  help: "Latency of deleting a key from the cache",
  labelNames: ["key"],
  registers: [],
});

const serviceQueryCount = new Counter({
  name: "cached_service_queries_total",
  help: "Number of lookups made to cache backing services",
  labelNames: ["key"],
  registers: [],
});
const serviceResultCount = new Counter({
  name: "cached_service_results_total",
  help: "Number of results returned from cache backed services",
  // first_flight = false, indicates that the request reused an in flight promise
  labelNames: ["key", "first_flight"],
  registers: [],
});
const serviceQueryDuration = new Histogram({
  name: "cached_service_query_duration_seconds",
  help: "Cached backing service latencies in seconds.",
  labelNames: ["key"],
  registers: [],
});
const cacheValueSize = new Histogram({
  name: "cache_value_size_bytes",
  help: "Latency of cache lookup",
  labelNames: ["key"],
  buckets: exponentialBuckets(100, 10, 5),
  registers: [],
});

export interface CacheKey {
  getMetaString(prefix: string): string;
  getString(prefix: string): string;
}

export interface Reviver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (this: any, key: string, value: any): any;
}

export interface RedisCacheOptions {
  /**
   * a redis client, see https://www.npmjs.com/package/redis
   */
  redisClient: RedisClient;
  /**
   * a string prefix to add to the redis keys, usually the service name followed by a colon
   * @example "tidy-api:"
   */
  prefix: string;
}

export interface Cache {
  put<T>(key: CacheKey, value: T, ttl: number, reviver?: Reviver): Promise<T>;
  get<T>(key: CacheKey, reviver?: Reviver): Promise<T | undefined>;
  clear(key: CacheKey): Promise<void>;
  apply<T>(
    key: CacheKey,
    ttl: number,
    promiseFn: () => Promise<T>,
    reviver?: Reviver
  ): Promise<T>;
}

export class RedisCache implements Cache {
  private prefix: string;

  private singleFlightGetCache: Map<string, Promise<string>>;
  private singleFlightApplyCache: Map<string, Promise<string>>;

  private _get: (key: string) => Promise<string | null>;
  private _psetex: (key: string, ttl: number, value: string) => Promise<string>;
  private _del: (key: string) => Promise<number>;

  constructor(options: RedisCacheOptions) {
    const { prefix, redisClient } = options;

    this.prefix = prefix;

    this.singleFlightGetCache = new Map();
    this.singleFlightApplyCache = new Map();

    this._get = promisify(redisClient.get).bind(redisClient);
    this._psetex = promisify(redisClient.psetex).bind(redisClient);
    this._del = promisify(redisClient.del).bind(redisClient);
  }

  /**
   *
   * @param key the unique key for the cache item
   * @param value the value to insert into the cache
   * @param ttl the time to live/expiry of the cached item in milliseconds
   * @param reviver a json reviver function to run over the value
   */
  async put<T>(
    key: CacheKey,
    value: T,
    ttl: number,
    reviver?: Reviver
  ): Promise<T> {
    const str = JSON.stringify(value);

    await this.putRawString(key, str, ttl);

    return JSON.parse(str, reviver);
  }

  private async putRawString(key: CacheKey, str: string, ttl: number) {
    const redisKey = key.getString(this.prefix);
    const metaKey = key.getMetaString(this.prefix);

    // JS UTF-16 is 2 bytes per char, 🤞redis client isn't using utf8
    cacheValueSize.observe({ key: metaKey }, str.length * 2);

    const end = setDuration.startTimer({ key: metaKey });

    await this._psetex(redisKey, ttl, str);

    end();

    return str;
  }

  /**
   *
   * @param key the unique key for the cache item
   * @param reviver a json reviver function to run over the value
   */
  async get<T>(key: CacheKey, reviver?: Reviver): Promise<T | undefined> {
    const metaKey = key.getMetaString(this.prefix);
    const redisKey = key.getString(this.prefix);

    queryCount.inc({ key: metaKey });

    const { value: valueStr, first } = await singleFlight(
      this.singleFlightGetCache,
      redisKey,
      async () => {
        const end = queryDuration.startTimer({ key: metaKey });

        const valueStr = await this._get(redisKey);

        end();

        return valueStr;
      }
    );

    if (!valueStr) return undefined;

    hitCount.inc({
      key: metaKey,
      first_flight: String(first),
    });

    // Would be nice if we could include this in the single flight
    // but can't guarantee a caller won't mutate the response
    return JSON.parse(valueStr, reviver);
  }

  /**
   * Clear key from cache
   *
   * @param key the unique key for the cache item
   */
  async clear(key: CacheKey): Promise<void> {
    const redisKey = key.getString(this.prefix);
    const metaKey = key.getMetaString(this.prefix);

    const end = deleteDuration.startTimer({ key: metaKey });

    await this._del(redisKey);

    end();

    this.singleFlightGetCache.delete(redisKey);
    this.singleFlightApplyCache.delete(redisKey);
  }

  /**
   *
   * @param key the unique key for the cache item
   * @param ttl the time to live/expiry of the cached item in milliseconds
   * @param promiseFn function to apply caching to
   * @param reviver a json reviver function to run over the value
   */
  async apply<T>(
    key: CacheKey,
    ttl: number,
    promiseFn: () => Promise<T>,
    reviver?: Reviver
  ): Promise<T> {
    const cachedValue = await this.get<T>(key, reviver);
    // NOTE: null is a valid cached cachedValue
    if (cachedValue !== undefined) return cachedValue;

    const metaKey = key.getMetaString(this.prefix);

    const { value, first } = await singleFlight(
      this.singleFlightApplyCache,
      key.getString(this.prefix),
      async () => {
        serviceQueryCount.inc({ key: metaKey });

        const end = serviceQueryDuration.startTimer({
          key: metaKey,
        });

        const result = await promiseFn();

        const str = JSON.stringify(result);

        end();

        return this.putRawString(key, str, ttl);
      }
    );

    serviceResultCount.inc({
      key: metaKey,
      first_flight: String(first),
    });

    // Would be nice if we could include this in the single flight
    // but can't guarantee a caller won't mutate the response
    return JSON.parse(value, reviver);
  }
}

export function create(options: RedisCacheOptions): RedisCache {
  return new RedisCache(options);
}

/**
 * Creates a cache key
 *
 * @example
 * const prefix = "foo:";
 * const userId = 5;
 * const userToken = "a42799b8";
 * const key = cacheKey`user:${userId}:session:${userToken}`;
 *
 * key.getString(prefix) === "foo:user:5:session:a42799b8";
 * key.getMetaString(prefix) === "foo:user:{0}:session:{1}";
 */
export function cacheKey(
  strings: TemplateStringsArray,
  ...values: string[]
): CacheKey {
  return {
    getString: (prefix: string) =>
      prefix + strings.reduce((out, str, i) => out + values[i - 1] + str),
    getMetaString: (prefix: string) =>
      prefix + strings.reduce((out, str, i) => out + `{${i - 1}}` + str),
  };
}

export function registerMetrics(registry: Registry): void {
  registry.registerMetric(queryCount);
  registry.registerMetric(hitCount);
  registry.registerMetric(queryDuration);
  registry.registerMetric(setDuration);
  registry.registerMetric(deleteDuration);
  registry.registerMetric(serviceQueryCount);
  registry.registerMetric(serviceResultCount);
  registry.registerMetric(serviceQueryDuration);
  registry.registerMetric(cacheValueSize);
}

async function singleFlight<T>(
  map: Map<string, Promise<T>>,
  key: string,
  promiseFn: () => Promise<T>
) {
  const valueP = map.get(key);
  if (valueP !== undefined) {
    return { value: await valueP, first: false };
  }

  try {
    const valueP = promiseFn();

    map.set(key, valueP);

    const value = await valueP;

    return { value, first: true };
  } finally {
    map.delete(key);
  }
}
