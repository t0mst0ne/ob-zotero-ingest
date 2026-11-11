const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const extensionDir = path.join(__dirname, '..');
const sidepanelScript = fs.readFileSync(path.join(extensionDir, 'sidepanel.js'), 'utf8');
const backgroundScript = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');

function loadSidePanel(chrome, logs = { warnings: [], errors: [] }) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      const message = { textContent: '' };
      elements.set(id, {
        id,
        checked: false,
        value: 'Neurology',
        textContent: '',
        disabled: false,
        className: '',
        href: '',
        classList: {
          hidden: false,
          add(name) { if (name === "hidden") this.hidden = true; },
          remove(name) { if (name === "hidden") this.hidden = false; },
          contains(name) { return name === "hidden" && this.hidden; },
        },
        addEventListener() {},
        querySelector() { return message; },
      });
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    document: {
      getElementById: element,
      querySelector() { return { value: 'note' }; },
      addEventListener() {},
    },
    chrome,
    URL,
    console: {
      log() {},
      warn(...args) { logs.warnings.push(args.map(String).join(' ')); },
      error(...args) { logs.errors.push(args.map(String).join(' ')); },
    },
  });
  vm.runInContext(sidepanelScript, context);
  vm.runInContext('nativePort = { postMessage() {}, disconnect() {} };', context);
  return { context, element, logs };
}

function articleResult() {
  return {
    result: {
      metadata: {
        title: 'Example Domain',
        authors: 'IANA',
        journal: 'Example',
        year: 1999,
        doi: '10.1000/example',
        url: 'https://example.com/',
      },
      sections: [],
      figures: [],
      tables: [],
    },
  };
}

function emptyMessage(element) {
  return element('article-empty').querySelector('p').textContent;
}

test('readTabUrl does not touch a missing url', () => {
  const { context } = loadSidePanel({});
  assert.equal(vm.runInContext('readTabUrl(undefined)', context), '');
  assert.equal(vm.runInContext('readTabUrl({ id: 1 })', context), '');
  assert.equal(vm.runInContext('readTabUrl({ id: 1, url: "" })', context), '');
  assert.equal(vm.runInContext('readTabUrl({ id: 1, url: "https://example.com/" })', context), 'https://example.com/');
  assert.equal(
    vm.runInContext('readTabUrl({ id: 1, pendingUrl: "https://example.com/pending" })', context),
    'https://example.com/pending',
  );
});

test('detectActiveTab shows a Traditional Chinese hint when tab.url is omitted', async () => {
  const requested = [];
  const logs = { warnings: [], errors: [] };
  const { context, element } = loadSidePanel({
    tabs: { query: async () => [{ id: 7 }] },
    scripting: { executeScript: async () => { throw new Error('Cannot access contents of the page'); } },
    permissions: { request: async (options) => { requested.push(options.origins); return true; } },
  }, logs);

  await vm.runInContext('detectActiveTab(false)', context);

  const hint = emptyMessage(element);
  assert.equal(hint, vm.runInContext('TAB_URL_UNAVAILABLE_HINT', context));
  assert.match(hint, /檢測/);
  assert.match(hint, /擴充功能圖示/);
  assert.equal(hint.includes('所有網站'), false);
  assert.equal(requested.length, 0);
  assert.equal(element('btn-detect').disabled, false);
  assert.equal(element('btn-detect').textContent, '🔄 重新整理');
  assert.equal(element('status-note').textContent, '未核對');
  assert.equal(logs.errors.some((line) => line.includes('Detection error') || line.includes('startsWith')), false);
});

test('refresh uses the icon-click origin and never asks for every website', async () => {
  const requested = [];
  const injected = [];
  const logs = { warnings: [], errors: [] };
  const { context, element } = loadSidePanel({
    tabs: { query: async () => [{ id: 7 }] },
    runtime: {
      sendMessage: async (message) => {
        if (message.action === 'get_invoked_tab') {
          return { tab: { id: 7, url: 'https://example.com/docs' } };
        }
        return null;
      },
    },
    scripting: {
      executeScript: async (options) => {
        injected.push(options.files ? 'files' : 'func');
        return [articleResult()];
      },
    },
    permissions: {
      request: async (options) => {
        requested.push([].concat(options.origins));
        return true;
      },
    },
  }, logs);

  await vm.runInContext('detectActiveTab(true)', context);

  assert.deepEqual(requested, []);
  assert.deepEqual(injected, ['files']);
  assert.equal(element('art-title').textContent, 'Example Domain');
  assert.equal(logs.errors.some((line) => line.includes('Detection error')), false);
});

test('a live location.href is used when the icon click did not capture a url', async () => {
  const requested = [];
  const { context, element } = loadSidePanel({
    tabs: { query: async () => [{ id: 7 }] },
    runtime: { sendMessage: async () => ({ tab: null }) },
    scripting: {
      executeScript: async (options) => {
        if (options.func) return [{ result: 'https://example.com/article' }];
        return [articleResult()];
      },
    },
    permissions: { request: async (options) => { requested.push(options.origins); return true; } },
  });

  await vm.runInContext('detectActiveTab(true)', context);

  assert.equal(requested.length, 0);
  assert.equal(element('art-title').textContent, 'Example Domain');
});

test('a side-panel click does not request every website when the origin is unknown', async () => {
  const requested = [];
  const logs = { warnings: [], errors: [] };
  const { context, element } = loadSidePanel({
    tabs: { query: async () => [{ id: 7 }] },
    scripting: { executeScript: async () => { throw new Error('Cannot access contents of the page'); } },
    permissions: { request: async (options) => { requested.push(options.origins); return true; } },
  }, logs);

  await vm.runInContext('detectActiveTab(true)', context);

  assert.equal(emptyMessage(element), vm.runInContext('TAB_URL_UNAVAILABLE_HINT', context));
  assert.deepEqual(requested, []);
  assert.equal(logs.errors.length, 0);
});

test('an invoked url for another tab is not reused after a switch', async () => {
  const requested = [];
  const { context, element } = loadSidePanel({
    tabs: { query: async () => [{ id: 8 }] },
    runtime: {
      sendMessage: async () => ({ tab: { id: 7, url: 'https://example.com/' } }),
    },
    scripting: { executeScript: async () => { throw new Error('Cannot access contents of the page'); } },
    permissions: { request: async (options) => { requested.push(options.origins); return true; } },
  });

  await vm.runInContext('detectActiveTab(true)', context);

  assert.equal(emptyMessage(element), vm.runInContext('TAB_URL_UNAVAILABLE_HINT', context));
  assert.deepEqual(requested, []);
});

test('pendingUrl is enough to detect without requesting every site', async () => {
  let requested = false;
  let seenTabId = null;
  const { context, element } = loadSidePanel({
    tabs: { query: async () => [{ id: 4, pendingUrl: 'https://example.com/article' }] },
    scripting: {
      executeScript: async (opts) => {
        seenTabId = opts.target.tabId;
        return [articleResult()];
      },
    },
    permissions: { request: async () => { requested = true; return true; } },
  });

  await vm.runInContext('detectActiveTab(false)', context);

  assert.equal(requested, false);
  assert.equal(seenTabId, 4);
  assert.equal(element('art-title').textContent, 'Example Domain');
});

test('a known site url requests only that origin after injection is denied', async () => {
  let injections = 0;
  const requested = [];
  const logs = { warnings: [], errors: [] };
  const { context, element } = loadSidePanel({
    tabs: { query: async () => [{ id: 3, url: 'https://example.com/paper' }] },
    scripting: {
      executeScript: async () => {
        injections += 1;
        if (injections === 1) throw new Error('Cannot access contents of the page');
        return [articleResult()];
      },
    },
    permissions: {
      request: async (options) => {
        requested.push(options.origins);
        return true;
      },
    },
  }, logs);

  await vm.runInContext('detectActiveTab(true)', context);

  assert.deepEqual(requested.map((origins) => [...origins]), [['https://example.com/*']]);
  assert.equal(injections, 2);
  assert.equal(element('art-title').textContent, 'Example Domain');
  assert.equal(logs.errors.some((line) => line.includes('Detection error')), false);
});

test('switching tabs clears the previous article and recognizes a chrome page', async () => {
  let tab = { id: 7, url: 'https://example.com/' };
  const requested = [];
  let activated = null;
  const { context, element } = loadSidePanel({
    tabs: {
      query: async () => [tab],
      onActivated: { addListener(fn) { activated = fn; } },
      onUpdated: { addListener() {} },
    },
    scripting: {
      executeScript: async () => {
        if (!tab.url || String(tab.url).startsWith('chrome')) {
          throw new Error('Cannot access a chrome:// URL');
        }
        return [articleResult()];
      },
    },
    permissions: { request: async (options) => { requested.push(options.origins); return true; } },
  });

  await vm.runInContext('detectActiveTab(false)', context);
  assert.equal(element('art-title').textContent, 'Example Domain');
  assert.equal(element('article-content').classList.contains('hidden'), false);
  assert.equal(typeof activated, 'function');

  tab = { id: 8 };
  await vm.runInContext('handleTabActivated()', context);

  assert.equal(emptyMessage(element), '無法在瀏覽器系統頁面上擷取文獻。');
  assert.equal(element('article-content').classList.contains('hidden'), true);
  assert.deepEqual(requested, []);
});

test('navigation of another tab does not clear the open article', async () => {
  let tab = { id: 7, url: 'https://example.com/' };
  const { context, element } = loadSidePanel({
    tabs: {
      query: async () => [tab],
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    scripting: {
      executeScript: async () => {
        if (!tab.url) throw new Error('Cannot access a chrome:// URL');
        return [articleResult()];
      },
    },
    permissions: { request: async () => true },
  });

  await vm.runInContext('detectActiveTab(false)', context);
  await vm.runInContext('handleTabUpdated(99, { status: "complete" })', context);
  assert.equal(element('art-title').textContent, 'Example Domain');
  assert.equal(element('article-content').classList.contains('hidden'), false);

  await vm.runInContext('handleTabUpdated(7, { status: "loading" })', context);
  assert.equal(emptyMessage(element), vm.runInContext('TAB_LOADING_MESSAGE', context));
  assert.equal(element('article-content').classList.contains('hidden'), true);

  tab = { id: 7 };
  await vm.runInContext('handleTabUpdated(7, { status: "complete" })', context);
  assert.equal(emptyMessage(element), '無法在瀏覽器系統頁面上擷取文獻。');
});

test('internal browser pages do not crash and do not prompt for host access', async () => {
  let requested = false;
  const { context, element } = loadSidePanel({
    tabs: { query: async () => [{ id: 2, url: 'chrome://extensions/' }] },
    scripting: { executeScript: async () => { throw new Error('should not inject'); } },
    permissions: { request: async () => { requested = true; return true; } },
  });

  await vm.runInContext('detectActiveTab(true)', context);

  assert.equal(requested, false);
  assert.equal(emptyMessage(element), '無法在瀏覽器系統頁面上擷取文獻。');
});

test('missing native host disconnect stays quiet; a live session drop still warns', () => {
  const logs = { warnings: [], errors: [] };
  let disconnectListener = null;
  const runtime = {
    connectNative() {
      return {
        onMessage: { addListener() {} },
        onDisconnect: { addListener(fn) { disconnectListener = fn; } },
        postMessage() {},
        disconnect() {},
      };
    },
    lastError: { message: 'Specified native messaging host not found.' },
  };
  const { context, element } = loadSidePanel({ runtime }, logs);

  vm.runInContext('nativePort = null; connectToNativeHost()', context);
  disconnectListener();

  assert.equal(logs.warnings.some((line) => line.includes('Native host disconnected')), false);
  assert.equal(vm.runInContext('isNativeHostOnline', context), false);
  assert.equal(vm.runInContext('nativePort', context), null);
  assert.match(element('host-badge').textContent, /選擇 Vault|連線/);

  runtime.lastError = { message: 'Native host has exited.' };
  vm.runInContext('isNativeHostOnline = true; connectToNativeHost()', context);
  disconnectListener();
  assert.equal(
    logs.warnings.some((line) => line.includes('Native host disconnected') && line.includes('Native host has exited.')),
    true,
  );
});

test('toolbar click remembers only that tab and drops the url when it navigates', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.permissions.includes('tabs'), false);
  assert.equal(manifest.permissions.includes('activeTab'), true);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*']);
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.equal(backgroundScript.includes('setPanelBehavior'), false);
  assert.equal(sidepanelScript.includes('https://*/*'), false);
  assert.equal(sidepanelScript.includes('http://*/*'), false);

  let listener = null;
  let onMessage = null;
  let onUpdated = null;
  const opened = [];
  const context = vm.createContext({
    chrome: {
      action: { onClicked: { addListener(fn) { listener = fn; } } },
      runtime: {
        onMessage: { addListener(fn) { onMessage = fn; } },
        sendMessage() { return Promise.resolve(); },
      },
      sidePanel: {
        open(options) {
          opened.push(options);
          return Promise.resolve();
        },
        setPanelBehavior() {
          throw new Error('openPanelOnActionClick must not be used');
        },
      },
      tabs: { onUpdated: { addListener(fn) { onUpdated = fn; } } },
    },
    console,
  });
  vm.runInContext(backgroundScript, context);
  assert.equal(typeof listener, 'function');
  listener({ id: 3, windowId: 9, url: 'https://example.com/' });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].windowId, 9);

  let response = null;
  onMessage({ action: 'get_invoked_tab' }, {}, (value) => { response = value; });
  assert.equal(response.tab.id, 3);
  assert.equal(response.tab.url, 'https://example.com/');

  onUpdated(3, { status: 'loading' });
  onMessage({ action: 'get_invoked_tab' }, {}, (value) => { response = value; });
  assert.equal(response.tab.url, '');

  listener({ id: 4, windowId: 9, url: 'https://www.wikipedia.org/' });
  onUpdated(3, { status: 'loading' });
  onMessage({ action: 'get_invoked_tab' }, {}, (value) => { response = value; });
  assert.equal(response.tab.id, 4);
  assert.equal(response.tab.url, 'https://www.wikipedia.org/');
});

test('icon click reads location.href when the action tab omits url', async () => {
  let listener = null;
  let onMessage = null;
  const context = vm.createContext({
    chrome: {
      action: { onClicked: { addListener(fn) { listener = fn; } } },
      runtime: {
        onMessage: { addListener(fn) { onMessage = fn; } },
        sendMessage() { return Promise.resolve(); },
      },
      sidePanel: { open() { return Promise.resolve(); } },
      tabs: { onUpdated: { addListener() {} } },
      scripting: {
        executeScript: async () => [{ result: 'https://example.com/' }],
      },
    },
    console,
  });
  vm.runInContext(backgroundScript, context);
  listener({ id: 5, windowId: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  let response = null;
  onMessage({ action: 'get_invoked_tab' }, {}, (value) => { response = value; });
  assert.equal(response.tab.id, 5);
  assert.equal(response.tab.url, 'https://example.com/');
});
