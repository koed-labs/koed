const addon = require(process.argv[2]);
if (process.argv[4] === "gc") {
  (() => {
    if (!addon.tryAcquire(process.argv[3])) throw new Error("lock unavailable");
  })();
  let attempts = 0;
  const timer = setInterval(() => {
    global.gc();
    const lock = addon.tryAcquire(process.argv[3]);
    if (lock) {
      lock.release();
      clearInterval(timer);
      process.stdout.write("finalized\n");
    } else if (++attempts === 100) {
      clearInterval(timer);
      process.exitCode = 1;
    }
  }, 10);
} else {
  const lock = addon.tryAcquire(process.argv[3]);
  if (!lock) throw new Error("lock unavailable");
  process.stdout.write("ready\n");
  setInterval(() => {
    void lock;
  }, 1000);
}
