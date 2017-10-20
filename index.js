const pify = require('pify');
const { Counter, Histogram } = require('prom-client');

const queryCount = new Counter(
  'cache_queries_total',
  'Total number of HTTP requests made.',
  ['key']
);
const hitCount = new Counter(
  'cache_hits_total',
  'Total number of HTTP requests made.',
  ['key']
);
const queryDuration = new Histogram(
  'cache_query_duration_seconds',
  'The HTTP request latencies in seconds.',
  ['key']
);

const serviceQueryCount = new Counter(
  'cached_service_queries_total',
  'Total number of HTTP requests made.',
  ['key']
);
const serviceQueryDuration = new Histogram(
  'cached_service_query_duration_seconds',
  'The HTTP request latencies in seconds.',
  ['key']
);

function countQuery(key) {
  if (!key.getMetaString) return;
  queryCount.inc({ key: key.getMetaString() });
}

function countHit(key) {
  if (!key.getMetaString) return;
  hitCount.inc({ key: key.getMetaString() });
}

function startDurationTimer(key) {
  if (!key.getMetaString) return () => {};
  return queryDuration.startTimer({ key: key.getMetaString() });
}

function countServiceQuery(key) {
  if (!key.getMetaString) return;
  serviceQueryCount.inc({ key: key.getMetaString() });
}

function startServiceDurationTimer(key) {
  if (!key.getMetaString) return () => {};
  return serviceQueryDuration.startTimer({ key: key.getMetaString() });
}

class RedisCache {
  constructor({ redisClient, prefix = '', defaulTTL = 30 }) {
    this.redisClient = redisClient;
    this.prefix = prefix;
    this.defaulTTL = defaulTTL;

    this._get = pify(redisClient.get.bind(redisClient));
    this._setex = pify(redisClient.setex.bind(redisClient));
    this._del = pify(redisClient.del.bind(redisClient));
  }
  /**
   * Creates a cache key
   * used with template strings, creates a key object that has two functions
   * toString: makes the object behave mostly like a regular template strings
   *     returning what you'd expect.
   * getMetaString: returns a version of the string with the dynamic values
   *     stripped out. This is used when recording metrics.
   *
   * @example
   *     const userId = 5;
   *     const userToken = 'a42799b8';
   *     const key = sharedCache.key`user:${userId}:session:${userToken}`;
   *
   *     key.toString() === 'user:5:session:a42799b8';
   *     key.getMetaString() === 'user:{0}:session:{1}';
   *
   * @param  {String[]} strings - the constant sring components of the template
   * @param  {...Number} values - the dynamic values for the cache key
   * @return {Object} Cache key
   *
   */
  key(strings, ...values) {
    return {
      toString: () =>
        this.prefix +
        strings.reduce((out, str, i) => out + values[i - 1] + str),
      getMetaString: () =>
        this.prefix + strings.reduce((out, str, i) => out + `{${i - 1}}` + str)
    };
  }

  /**
   * Puts an item in cache
   * @param  {String} key - the unique key for the cache item
   * @param  {Number} [ttl] - the TTL/expiry
   * @return {Promise<>} where Lock has methods #unlock() and #extend(ttl)
   */
  put(key, value, ttl, reviver) {
    const str = JSON.stringify(value);

    return this._setex(key.toString(), ttl || this.defaulTTL, str).then(() =>
      JSON.parse(str, reviver)
    );
  }

  get(key, reviver) {
    countQuery(key);
    const end = startDurationTimer(key);

    return this._get(key.toString()).then(value => {
      end();
      if (!value) return undefined;
      countHit(key);
      return JSON.parse(value, reviver);
    });
  }

  clear(key) {
    return this._del(key.toString());
  }

  apply(key, ttl, promiseFn, reviver) {
    return this.get(key, reviver).then(value => {
      // Value of null cachable
      if (value !== undefined) return value;

      countServiceQuery(key);
      const end = startServiceDurationTimer(key);

      return promiseFn().then(result => {
        end();
        return this.put(key, result, ttl, reviver);
      });
    });
  }
}

exports.RedisCache = RedisCache;
exports.create = (...args) => new RedisCache(...args);
