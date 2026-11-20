// Only send a small number of requests across IPC at once, even when the
// user scrolls quickly or switches dates while previews are being read.
export function thumbnailQueue(load, limit = 2) {
  const pending = new Set();
  let running = 0;

  function drain() {
    while (running < limit && pending.size) {
      const job = pending.values().next().value;
      pending.delete(job);
      running++;
      void run(job);
    }
  }

  async function run({ id, done }) {
    let image = null;
    try { image = await load(id); }
    catch { /* Leave an unavailable-thumbnail placeholder. */ }
    try { done(image); }
    finally { running--; drain(); }
  }

  return (id, done) => {
    const job = { id, done };
    pending.add(job);
    drain();
    return () => pending.delete(job);
  };
}
