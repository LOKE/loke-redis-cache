import crypto from 'crypto';
import test from 'ava';
import redis from 'redis';
import m from '.';

const randomId = () => crypto.randomBytes(16).toString('hex');
const redisClient = redis.createClient();
const cache = m.create({ redisClient, prefix: 'test:' });

test('should generate formatted keys', t => {
  const value = 'x';
  const key = cache.key`${value}:$`;

  t.is(key.toString(), 'test:x:$');
  t.is(key.getMetaString(), 'test:{0}:$');
});

test('should default to no prefix', t => {
  const prefixless = m.create({ redisClient });
  const value = 'x';

  const key = prefixless.key`${value}:$`;

  t.is(key.toString(), 'x:$');
  t.is(key.getMetaString(), '{0}:$');
});

test('should get undefined for unset values', async t => {
  const key = cache.key`${randomId()}:$`;

  t.is(await cache.get(key), undefined);
});

test('should be able to put and get strings', async t => {
  const key = cache.key`${randomId()}:$`;

  await cache.put(key, 'foo');

  t.is(await cache.get(key), 'foo');
});

test('should be able to put and get numbers', async t => {
  const key = cache.key`${randomId()}:$`;

  await cache.put(key, 1);

  t.is(await cache.get(key), 1);
});

test('should be able to put and get objects', async t => {
  const key = cache.key`${randomId()}:$`;

  await cache.put(key, { a: 1 });

  t.deepEqual(await cache.get(key), { a: 1 });
});

test('should be able to clear values', async t => {
  const key = cache.key`${randomId()}:$`;

  await cache.put(key, 'foo');
  await cache.clear(key);

  t.is(await cache.get(key), undefined);
});

test('should be able to apply caching to a function', async t => {
  const key = cache.key`${randomId()}:$`;
  let callCount = 0;

  const testFn = async () => {
    callCount++;
    return 'bar';
  };

  t.is(await cache.apply(key, 30, testFn), 'bar');
  t.is(callCount, 1);
  t.is(await cache.apply(key, 30, testFn), 'bar');
  t.is(callCount, 1);
});

test('should work with basic string keys', async t => {
  const key = randomId();
  const testFn = async () => 'bar';

  t.is(await cache.apply(key, 30, testFn), 'bar');
  t.is(await cache.apply(key, 30, testFn), 'bar');
});
