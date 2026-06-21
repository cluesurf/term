// ../../../../../../../../../private/var/folders/8x/z26qdb3x465gmtqr6z4x8hgm0000gn/T/seed-web-Qr0UTL/app.ts
function listIsEmpty(self) {
  return self.length == 0;
}
function listPush(self, item) {
  return self.push(item);
}
function listPop(self) {
  return self.pop();
}
function listGet(self, index) {
  return self.at(index);
}
var page = document;
function createElement(tag) {
  const made = page.createElement(tag, { form: "none" });
  return { handle: made };
}
function createText(value) {
  const made = page.createTextNode(value);
  return { handle: made };
}
function setText(node, value) {
  node.handle.textContent = value;
}
function listen(node, event2, handler) {
  const made = node.handle;
  const listener = handler;
  made.addEventListener(event2, listener, { form: "none" });
}
function append(parent, child) {
  const made = parent.handle;
  made.appendChild(child.handle);
}
var running = [];
var owners = [];
function readSignal(self) {
  track(self);
  return self.value;
}
function writeSignal(self, value) {
  self.value = value;
  const subscribers = self.observers;
  self.observers = [];
  for (const observer of subscribers) {
    runEffect(observer);
  }
}
function makeEffect(run) {
  const own = { run, live: true };
  if (listIsEmpty(owners)) {
    const skip = 0;
  } else {
    const top = listGet(owners, owners.length - 1);
    listPush(top, own);
  }
  runEffect(own);
  return own;
}
function runEffect(effect) {
  if (effect.live) {
    listPush(running, effect);
    effect.run();
    listPop(running);
  } else {
    const skip = 0;
  }
}
function track(signal) {
  if (listIsEmpty(running)) {
    const skip = 0;
  } else {
    const index = running.length - 1;
    const current = listGet(running, index);
    listPush(signal.observers, current);
  }
}
function event(node, name, handler) {
  listen(node, name, handler);
}
function dynamic(source) {
  const host = createText("");
  makeEffect(() => {
    setText(host, source());
  });
  return host;
}
function mount(host, build) {
  append(host, build());
}
function mountApp(host) {
  const label = { value: "ready", observers: [] };
  const root = createElement("div");
  const button = createElement("button");
  event(button, "click", () => {
    writeSignal(label, "clicked");
  });
  append(button, createText("click me"));
  append(root, button);
  append(root, dynamic(() => readSignal(label)));
  mount(host, () => root);
}

// ../../../../../../../../../private/var/folders/8x/z26qdb3x465gmtqr6z4x8hgm0000gn/T/seed-web-Qr0UTL/entry.ts
mountApp({ handle: document.body });
