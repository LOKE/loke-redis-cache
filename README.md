# @loke/redis-cache

**Please note v2 has breaking changes in that it now uses milliseconds not seconds**

## Examples

```js
import promClient from "prom-client";
import { create as createCache, cacheKey } from "@loke/redis-cache";
import redis from "redis";
import { MINUTE } from "@loke/duration";

import { fetchUser } from "./user";

redisCache.registerMetrics(promClient.register);

const redisClient = redis.createClient();
const cache = createCache({ redisClient, prefix: "some-service:" });

function getUser(userId) {
  return cache.apply(cacheKey`user:${userId}`, 5 * MINUTE, () =>
    fetchUser(userId)
  );
}
```

## API

### create(options)

#### options

##### redisClient

A redis client from the [redis](https://www.npmjs.com/package/redis) package

##### prefix

A string prefix for the keys used by this client, usually the name of the service followed by a colon eg. `"tidy-api"`

### cache.get(key[, reviver])

Gets a value in the cache, optionally can be run through a json `reviver` to apply things like the `Date` type

### cache.put(key, value, ttl[, reviver])

Puts a value into the cache, the value will expire from the cache after `ttl` (milliseconds) has elapsed

Also returns a promise of the value that has been run through the json `reviver`, this can be useful for getting consistent value types from get and put

### cache.clear(key)

Removes a key from the cache

### cache.apply(key, ttl, promiseFn[, reviver])

Applies caching to a promise function

### cacheKey

Creates a cache key used with template strings, creates a key object that has two functions

**getString(prefix)**: returns the templated string with the supplied prefix

**getMetaString(prefix)**: returns a version of the string with the dynamic values stripped out. This is used when recording metrics.

Example

```js
const prefix = "foo:";
const userId = 5;
const userToken = "a42799b8";
const key = cacheKey`user:${userId}:session:${userToken}`;

key.getString(prefix) === "foo:user:5:session:a42799b8";
key.getMetaString(prefix) === "foo:user:{0}:session:{1}";
```

### registerMetrics(registry)

register the metrics provided by this package with [prom-client](https://www.npmjs.com/package/prom-client) registry
