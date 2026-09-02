// host/android/work/page/app.ts
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
  made.addEventListener(event2, handler, { form: "none" });
}
function pageBody() {
  return { handle: page.body };
}
function append(parent, child) {
  const made = parent.handle;
  made.appendChild(child.handle);
}
function remove(node) {
  const made = node.handle;
  made.remove();
}
function getValue(node) {
  return node.handle.value;
}
function setValue(node, value) {
  node.handle.value = value;
}
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
var running = [];
var owners = [];
var flags = { batching: false, paused: false, queue: [] };
function makeSignal(value) {
  return { value, observers: [] };
}
function readSignal(self) {
  track(self);
  return self.value;
}
function writeSignal(self, value) {
  self.value = value;
  const subscribers = self.observers;
  self.observers = [];
  for (const observer of subscribers) {
    if (flags.batching) {
      listPush(flags.queue, observer);
    } else {
      runEffect(observer);
    }
  }
}
function makeEffect(run) {
  const own = { run, live: true };
  if (listIsEmpty(owners)) {
  } else {
    const top = listGet(owners, owners.length - 1);
    listPush(top.effects, own);
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
  }
}
function track(signal) {
  if (flags.paused) {
    const skip = 0;
  } else {
    if (listIsEmpty(running)) {
      const skip = 0;
    } else {
      const index = running.length - 1;
      const current = listGet(running, index);
      listPush(signal.observers, current);
    }
  }
}
function element(tag) {
  return createElement(tag);
}
function text(value) {
  return createText(value);
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
function each(host, items, build) {
  let mounted = [];
  makeEffect(() => {
    for (const old of mounted) {
      remove(old);
    }
    const fresh = [];
    const current = items();
    for (const item of current) {
      const node = build(item);
      append(host, node);
      listPush(fresh, node);
    }
    mounted = fresh;
  });
}
function addPost(titleField, bodyField, posts) {
  const titleText = getValue(titleField);
  const bodyText = getValue(bodyField);
  const current = readSignal(posts);
  listPush(current, { title: titleText, body: bodyText });
  writeSignal(posts, current);
  setValue(titleField, "");
  setValue(bodyField, "");
}
function blog(host) {
  const posts = makeSignal([]);
  const view0 = element("div");
  const titleInput = element("input");
  append(view0, titleInput);
  const bodyInput = element("textarea");
  append(view0, bodyInput);
  const view1 = element("button");
  event(view1, "click", () => addPost(titleInput, bodyInput, posts));
  const view2 = text("Add post");
  append(view1, view2);
  append(view0, view1);
  const postList = element("div");
  each(postList, () => readSignal(posts), (item) => {
    const view3 = element("div");
    const view4 = element("h2");
    const view5 = dynamic(() => item.title);
    append(view4, view5);
    append(view3, view4);
    const view6 = element("p");
    const view7 = dynamic(() => item.body);
    append(view6, view7);
    append(view3, view6);
    return view3;
  });
  append(view0, postList);
  append(host, view0);
}
function boot() {
  blog(pageBody());
}

// host/android/work/page/entry.ts
boot();
