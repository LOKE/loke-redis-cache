import crypto from "crypto";
import test from "ava";
import redis from "redis";
import { register } from "prom-client";
import { RedisCache, cacheKey, Reviver, registerMetrics } from ".";

registerMetrics(register);

const randomId = () => crypto.randomBytes(16).toString("hex");

const redisClient = redis.createClient({
  host: process.env.REDIS_HOST || "localhost",
});
const cache = new RedisCache({ redisClient, prefix: "test:" });

test("should generate formatted keys", (t) => {
  const value = "x";
  const key = cacheKey`${value}:$`;

  t.is(key.getString("prefix:"), "prefix:x:$");
  t.is(key.getMetaString("prefix:"), "prefix:{0}:$");
});

test("should get undefined for unset values", async (t) => {
  const key = cacheKey`${randomId()}:$`;

  t.is(await cache.get(key), undefined);
});

test("should be able to put and get strings", async (t) => {
  const key = cacheKey`${randomId()}:$`;

  await cache.put(key, "foo", 5000);

  t.is(await cache.get(key), "foo");
});

test("should be able to put and get numbers", async (t) => {
  const key = cacheKey`${randomId()}:$`;

  await cache.put(key, 1, 5000);

  t.is(await cache.get(key), 1);
});

test("should be able to put and get objects", async (t) => {
  const key = cacheKey`${randomId()}:$`;

  await cache.put(key, { a: 1 }, 5000);

  t.deepEqual(await cache.get(key), { a: 1 });
});

test("should be able to put and get objects with a reviver", async (t) => {
  const key = cacheKey`${randomId()}:$`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reviver: Reviver = (key: string, value: any): any => {
    switch (key) {
      case "d":
        return new Date(value);
    }
    return value;
  };

  t.deepEqual(
    await cache.put(
      key,
      { d: new Date("2020-11-18T22:36:10Z") },
      5000,
      reviver
    ),
    {
      d: new Date("2020-11-18T22:36:10Z"),
    }
  );

  t.deepEqual(await cache.get(key, reviver), {
    d: new Date("2020-11-18T22:36:10Z"),
  });
});

test("should be able to clear values", async (t) => {
  const key = cacheKey`${randomId()}:$`;

  await cache.put(key, "foo", 5000);
  await cache.clear(key);

  t.is(await cache.get(key), undefined);
});

test("should be able to apply caching to a function", async (t) => {
  const key = cacheKey`${randomId()}:$`;
  let callCount = 0;

  const testFn = async () => {
    callCount++;
    return "bar";
  };

  t.is(await cache.apply(key, 30000, testFn), "bar");
  t.is(callCount, 1);
  t.is(await cache.apply(key, 30000, testFn), "bar");
  t.is(callCount, 1);
});

test("should only need to call service once in parallel (single flight)", async (t) => {
  const key = cacheKey`${randomId()}:$`;
  let applyCount = 0;
  let callCount = 0;

  let resolveAllApplied: () => void;
  const allApplied = new Promise((r) => (resolveAllApplied = r));

  async function testFn() {
    const p = cache.apply(key, 30000, async () => {
      callCount++;

      await allApplied;

      return "bar";
    });

    // Wait till all 5 requests are queued before resolving the first one
    if (++applyCount === 5) setTimeout(resolveAllApplied, 10);

    return p;
  }

  const [first, , , , last] = await Promise.all([
    testFn(),
    testFn(),
    testFn(),
    testFn(),
    testFn(),
  ]);

  t.is(first, "bar");
  t.is(last, "bar");
  t.is(callCount, 1);
});
