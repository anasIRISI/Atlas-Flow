/**
 * Source of the worker thread that runs Code-node JavaScript inside QuickJS (WASM).
 * It is passed to `new Worker(source, { eval: true })`, so it is plain CommonJS.
 * Each task gets a fresh QuickJS runtime with a memory limit and an interrupt deadline.
 */
export const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const core = require(workerData.corePath);
const variantModule = require(workerData.variantPath);
const ready = core.newQuickJSWASMModuleFromVariant(variantModule.default || variantModule);

function dumpError(vm, handle) {
  const value = vm.dump(handle);
  handle.dispose();
  if (value && typeof value === 'object') {
    return { name: String(value.name || 'Error'), message: String(value.message || ''), stack: String(value.stack || '') };
  }
  return { name: 'Error', message: String(value), stack: '' };
}

parentPort.on('message', async (task) => {
  const QuickJS = await ready;
  let runtime;
  let vm;
  try {
    runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(task.memoryLimitBytes);
    runtime.setMaxStackSize(1024 * 1024);
    const deadline = Date.now() + task.timeoutMs;
    runtime.setInterruptHandler(core.shouldInterruptAfterDeadline(deadline));
    vm = runtime.newContext();
    const evaluated = vm.evalCode(task.source, 'code.js');
    if (evaluated.error) {
      parentPort.postMessage({ id: task.id, ok: false, error: dumpError(vm, evaluated.error) });
      return;
    }
    const promise = evaluated.value;
    let state = vm.getPromiseState(promise);
    // No deadline check here: after the deadline the interrupt handler stops any user code inside
    // the jobs, and the remaining jobs only propagate that rejection to our promise.
    let rounds = 0;
    while (state.type === 'pending' && runtime.hasPendingJob() && rounds++ < 100000) {
      const jobs = runtime.executePendingJobs();
      if (jobs.error) {
        promise.dispose();
        parentPort.postMessage({ id: task.id, ok: false, error: dumpError(vm, jobs.error) });
        return;
      }
      state = vm.getPromiseState(promise);
    }
    promise.dispose();
    if (state.type === 'pending') {
      parentPort.postMessage({
        id: task.id,
        ok: false,
        error: { name: 'Error', message: 'The code is waiting for something that never finishes (await on a promise that never resolves)', stack: '' },
      });
    } else if (state.type === 'rejected') {
      parentPort.postMessage({ id: task.id, ok: false, error: dumpError(vm, state.error) });
    } else {
      const output = vm.dump(state.value);
      state.value.dispose();
      parentPort.postMessage({ id: task.id, ok: true, output });
    }
  } catch (err) {
    parentPort.postMessage({ id: task.id, ok: false, error: { name: err.name || 'Error', message: String(err.message || err), stack: '' } });
  } finally {
    try { vm && vm.dispose(); } catch {}
    try { runtime && runtime.dispose(); } catch {}
  }
});
`;
