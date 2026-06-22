// Fiber runtime over the node event loop: spawn starts the async work (a promise) and returns it; wait awaits it. The
// opaque handle a seed fiber holds is the promise. Reached only through the public fiber API.
const fiber = {
  spawn: (work: () => Promise<void>): Promise<void> => work(),
  wait: (handle: Promise<void>): Promise<void> => handle,
}
