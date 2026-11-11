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
        classList: { add() {}, remove() {} },
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
  let executeCalled = false;
  let permissionRequested = false;
  const logs = { warnings: [], errors: [] };
  const { context, element } = loadSidePanel({
    tabs: { query: async () => [{ id: 7 }] },
    scripting: { executeScript: async () => { executeCalled = true; return []; } },
    permissions: { request: async () => { permissionRequested = true; return true; } },
  }, logs);

  await vm.runInContext('detectActiveTab(false)', context);

  const hint = emptyMessage(element);
  assert.equal(hint, vm.runInContext('TAB_URL_UNAVAILABLE_HINT', context));
  assert.match(hint, /檢測/);
  assert.match(hint, /重新整理/);
  assert.match(hint, /允許存取此網站/);
  assert.equal(executeCalled, false);
  assert.equal(permissionRequested, false);
  assert.equal(element('btn-detect').disabled, false);
  assert.equal(element('btn-detect').textContent, '🔄 重新整理');
  assert.equal(element('status-note').textContent, '未核對');
  assert.equal(logs.errors.some((line) => line.includes('Detection error') || line.includes('startsWith')), false);
});

test('refresh click asks for optional host access and detects once the url is available', async () => {
  const queriedTabs = [
    [{ id: 7 }],
    [{ id: 7, url: 'https://example.com/' }],
  ];
  let queryCount = 0;
  let executeCalled = false;
  const requested = [];
  const logs = { warnings: [], errors: [] };
  const { context, element } = loadSidePanel({
    tabs: {
      query: async () => queriedTabs[Math.min(queryCount++, queriedTabs.length - 1)],
    },
    scripting: {
      executeScript: async () => {
        executeCalled = true;
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

  assert.deepEqual(requested.map((origins) => [...origins]), [['https://*/*', 'http://*/*']]);
  assert.equal(executeCalled, true);
  assert.equal(element('art-title').textContent, 'Example Domain');
  assert.equal(emptyMessage(element).includes('無法讀取此分頁的網址'), false);
  assert.equal(logs.errors.some((line) => line.includes('Detection error')), false);
});

test('denied optional host access keeps the hint and does not throw', async () => {
  let executeCalled = false;
  const logs = { warnings: [], errors: [] };
  const { context, element } = loadSidePanel({
    tabs: { query: async () => [{ id: 7 }] },
    scripting: { executeScript: async () => { executeCalled = true; return []; } },
    permissions: { request: async () => false },
  }, logs);

  await vm.runInContext('detectActiveTab(true)', context);

  assert.equal(emptyMessage(element), vm.runInContext('TAB_URL_UNAVAILABLE_HINT', context));
  assert.equal(executeCalled, false);
  assert.equal(logs.errors.length, 0);
});

test('a thrown permission prompt still degrades to the hint', async () => {
  const logs = { warnings: [], errors: [] };
  const { context, element } = loadSidePanel({
    tabs: { query: async () => [{ id: 7, title: 'Example Domain' }] },
    scripting: { executeScript: async () => { throw new Error('should not inject'); } },
    permissions: { request: async () => { throw new Error('gesture consumed'); } },
  }, logs);

  await vm.runInContext('detectActiveTab(true)', context);

  assert.equal(emptyMessage(element), vm.runInContext('TAB_URL_UNAVAILABLE_HINT', context));
  assert.equal(logs.errors.some((line) => line.includes('startsWith') || line.includes('Detection error')), false);
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

test('toolbar click opens the side panel and the manifest does not request tabs', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.permissions.includes('tabs'), false);
  assert.equal(manifest.permissions.includes('activeTab'), true);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*']);
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.equal(backgroundScript.includes('setPanelBehavior'), false);

  let listener = null;
  const opened = [];
  const context = vm.createContext({
    chrome: {
      action: { onClicked: { addListener(fn) { listener = fn; } } },
      runtime: { onMessage: { addListener() {} } },
      sidePanel: {
        open(options) {
          opened.push(options);
          return Promise.resolve();
        },
        setPanelBehavior() {
          throw new Error('openPanelOnActionClick must not be used');
        },
      },
    },
    console,
  });
  vm.runInContext(backgroundScript, context);
  assert.equal(typeof listener, 'function');
  listener({ id: 3, windowId: 9 });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].windowId, 9);
});
