const Promise = require('bluebird');
const assert  = require('assert');
const setup   = require('./setup.js');
const buildCron = require('../../lib/cron.js');

describe('cron', () => {

  const { config, redis, cache, log, getAllData } = setup();
  const cron = buildCron(config, log, redis, cache);

  describe('#startClearNowProcess', () => {

    it('should move all the keys from the clear-later set to the clear-now set', (done) => {
      const cronInstance = buildCron(config, log, redis, cache);
      let clearNowCalled = false;
      const clearNowOld = cronInstance.clearNow;
      const clearKeys = ['a', 'b', 'c'];
      const clearNowDone = new Promise((resolve) => {
        cronInstance.clearNow = () => {
          clearNowCalled = true;
          return redis('smembers', config.clearNowSet).then((clearNowSet) => {
            assert.deepEqual(clearKeys, clearNowSet.sort());
            clearNowOld().then(resolve);
          });
        };
      });
      redis.clearAllKeys()
        .then(() => cache.clearLater({ keys: clearKeys }))
        .then(() => redis('smembers', config.clearLaterSet))
        .then((members) => {
          assert.deepEqual(clearKeys, members.sort());
          return cronInstance.startClearNowProcess();
        })
        .then((success) => {
          assert(clearNowCalled);
          assert(success);
          return clearNowDone;
        })
        .then(() => Promise.all([
          redis('smembers', config.clearLaterSet),
          redis('smembers', config.clearNowSet),
        ]))
        .then((clearSets) => {
          assert.deepEqual([], clearSets[0]);
          assert.deepEqual([], clearSets[1]);
        })
        .then(done);
    });
  });

  describe('#clearNow', () => {

    it('should empty the clear-now set and clear all those keys', (done) => {
      redis.clearAllKeys()
        .then(() => Promise.all([
          cache.set({ key: 'A', data: '_', millis: 10000 }),
          cache.set({ key: 'B', data: '_', millis: 10000 }),
          cache.set({ key: 'C', data: '_', millis: 10000 }),
          cache.set({ key: 'D', data: '_', millis: 10000, associations: ['B', 'C'] }),
          cache.set({ key: 'E', data: '_', millis: 10000 }),
          cache.set({ key: 'F', data: '_', millis: 10000 }),
          cache.set({ key: 'G', data: '_', millis: 10000, associations: ['A'] }),
          redis('sadd', config.clearNowSet, 'B', 'C'),
        ]))
        .then(() => cron.clearNow()).then(() => getAllData())
        .then((allData) => {
          assert.deepEqual(allData, {
            'c:A': ['G'],
            'd:A': '_',
            'd:E': '_',
            'd:G': '_',
            'i:G': ['A'],
            'd:F': '_',
          });
        })
        .then(done);
    });
  });


  describe('#listenForMessages', () => {

    it('should run clearNow when it receives a "startClear" message', function testListenForMessagesSuccess(done) {
      this.timeout(3000);
      this.slow(2000);
      const cronInstance = buildCron(config, log, redis, cache);
      cronInstance.listenForMessages();
      let startedClear = false;
      cronInstance.clearNow = () => {
        startedClear = true;
      };
      redis.publish(config.cronChannel, 'startClear');
      Promise.delay(700).then(() => {
        assert(startedClear);
      }).then(done);
    });

    it('should do nothing if it receives an invalid message', function testListenForMessagesInvalid(done) {
      this.timeout(3000);
      this.slow(2000);
      const cronInstance = buildCron(config, log, redis, cache);
      cronInstance.listenForMessages();
      let startedClear = false;
      cronInstance.clearNow = () => {
        startedClear = true;
      };
      redis.publish(config.cronChannel, 'invalidMessage');
      Promise.delay(700).then(() => {
        assert(!startedClear);
        redis.unsubscribe();
        return null;
      }).then(done);
    });
  });

  describe('#checkSyncKey', () => {

    it('should set the sync key if it is not already set and start the clear process', (done) => {
      const clearIntervalMillis = config.clearLaterIntervalSeconds * 1000;
      const syncKey = config.clearLaterSyncKey;
      const cronInstance = buildCron(config, log, redis, cache);
      let startedClearNow = false;
      cronInstance.startClearNowProcess = () => {
        startedClearNow = true;
      };
      redis.clearAllKeys()
        .then(() => cronInstance.checkSyncKey())
        .then((success) => {
          assert(!!success);
          assert(startedClearNow);
          return Promise.all([
            redis('pttl', syncKey),
            redis('get', syncKey),
          ]);
        })
        .then((result) => {
          assert(result[0] && Number(result[1]) === clearIntervalMillis);
        })
        .then(done);
    });

    it('should fail to set the sync key if it is already set and NOT start the clear process', (done) => {
      const syncKey = config.clearLaterSyncKey;
      const cronInstance = buildCron(config, log, redis, cache);
      let startedClearNow = false;
      cronInstance.startClearNowProcess = () => { startedClearNow = true; };
      redis.clearAllKeys()
        .then(() => redis('set', syncKey, 'foo', 'px', 3000, 'nx'))
        .then(() => cronInstance.checkSyncKey())
        .then((success) => {
          assert(!success);
          assert(!startedClearNow);
          return redis('get', syncKey);
        })
        .then((result) => {
          assert(result === 'foo');
        })
        .then(done);
    });
  });

  describe('#startCron', () => {

    it('should call #checkSyncKey at the cron interval', function startCronShouldCallCheckSyncKeyAtCron(done) {
      const c = Object.assign({}, config);
      c.clearLaterIntervalSeconds = 0.2;
      const cronInstance = buildCron(c, log, redis, cache);
      let called = 0;
      const times = 3;
      const interval = c.clearLaterIntervalSeconds * 1000;
      this.slow((interval * times) + 500);
      this.timeout((interval * times) + 5000);
      cronInstance.checkSyncKey = () => {
        called += 1;
      };
      cronInstance.startCron();
      Promise.delay((interval * times) + 100).then(() => {
        assert.equal(called, times);
      }).then(done);
    });
  });
});
