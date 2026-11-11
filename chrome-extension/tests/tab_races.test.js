const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.js'), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function article(name) {
  return {
    metadata: {
      title: `Paper ${name}`, authors: 'Tester A.', year: 2026,
      doi: `10.1000/${name}`, pmid: name === 'A' ? '40000001' : '40000002',
      url: `https://example.org/${name}`, pdf_url: `https://example.org/${name}.pdf`,
    },
    sections: [{ heading: 'Results', level: 2, text: `Body of ${name}` }],
    figures: [{ label: 'Figure 1', src: `https://example.org/${name}.png`, caption: `Figure of ${name}` }],
    tables: [{ caption: `Table of ${name}`, markdown: `| ${name} |` }],
  };
}

function loadPanel() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      const message = { textContent: '' };
      elements.set(id, {
        checked: true, value: 'Neurology', textContent: '', href: '', disabled: false,
        classList: {
          add(name) { classes.add(name); },
          remove(name) { classes.delete(name); },
          contains(name) { return classes.has(name); },
        },
        addEventListener() {}, querySelector() { return message; },
      });
    }
    return elements.get(id);
  }
  const sent = [];
  const state = { tab: { id: 1, url: 'https://example.org/A' }, data: article('A') };
  const chrome = {
    tabs: { query: async () => [state.tab] },
    scripting: { executeScript: async () => [{ result: state.data }] },
    downloads: { download: async () => { throw new Error('blocked'); } },
  };
  const context = vm.createContext({
    document: { getElementById: element, addEventListener() {} },
    chrome, URL, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    fetch: async () => { throw new Error('HTTP 403'); },
    sent,
  });
  const run = (code) => vm.runInContext(code, context);
  vm.runInContext(script, context);
  run('nativePort = { postMessage: message => sent.push(message) };');
  async function switchToB() {
    state.tab = { id: 2, url: 'https://example.org/B' };
    state.data = article('B');
    await run('handleTabActivated()');
  }
  return { context, element, state, sent, run, switchToB };
}

for (const destination of ['another article', 'an internal page']) {
  test(`native import keeps its original data after switching to ${destination}`, async () => {
    const panel = loadPanel();
    const started = deferred();
    const download = deferred();
    const original = article('A');
    Object.assign(panel.context, {
      original,
      capturePdf: async () => { started.resolve(); return download.promise; },
    });
    panel.run('currentArticleData = original; downloadAndUploadPdf = capturePdf;');
    const pending = panel.run('startIngestion()');
    await started.promise;

    if (destination === 'another article') {
      await panel.switchToB();
    } else {
      panel.state.tab = { id: 2, url: 'chrome://extensions/' };
      await panel.run('handleTabActivated()');
    }
    assert.equal(panel.element('btn-ingest').disabled, true);
    panel.element('topic-select').value = 'Other';
    panel.element('opt-source').checked = false;
    // Even an in-place status update must not change the captured metadata.
    original.metadata.pmid = '49999999';
    download.resolve({ ok: true, uploadedStem: 'original-pdf' });
    await pending;

    const payload = panel.sent.find((message) => message.action === 'ingest_webpage').payload;
    assert.equal(payload.metadata.title, 'Paper A');
    assert.equal(payload.metadata.pmid, '40000001');
    assert.equal(payload.pdf_url, 'https://example.org/A.pdf');
    assert.equal(payload.uploaded_pdf_stem, 'original-pdf');
    assert.match(payload.stem, /^40000001_/);
    assert.equal(payload.sections[0].text, 'Body of A');
    assert.equal(payload.figures[0].src, 'https://example.org/A.png');
    assert.equal(payload.tables[0].caption, 'Table of A');
    assert.equal(payload.options.topic, 'Neurology');
    assert.equal(payload.options.save_source, true);

    panel.context.reply = {
      status: 'success', stem: 'resolved-A',
      metadata: { title: 'Resolved A', pmid: '40000001' },
    };
    panel.run('handleNativeResponse(reply)');
    assert.equal(original.metadata.title, 'Resolved A');
    assert.equal(original.ingested_stem, 'resolved-A');
    assert.equal(panel.run('isIngesting'), false);
    if (destination === 'another article') {
      assert.equal(panel.run('currentArticleData.metadata.title'), 'Paper B');
      assert.equal(panel.run('currentArticleData.ingested_stem'), undefined);
      assert.equal(panel.element('art-title').textContent, 'Paper B');
      assert.equal(panel.element('btn-ingest').disabled, false);
    } else {
      assert.equal(panel.run('currentArticleData'), null);
      assert.equal(panel.element('btn-ingest').disabled, true);
    }
  });
}

for (const pauseAt of ['permission', 'PDF download']) {
  test(`browser vault import retains its article across a switch during ${pauseAt}`, async () => {
    const panel = loadPanel();
    const started = deferred();
    const resume = deferred();
    const writes = [];
    Object.assign(panel.context, {
      original: article('A'), writes,
      root: {
        name: 'Test Vault',
        async queryPermission() {
          if (pauseAt === 'permission') { started.resolve(); await resume.promise; }
          return 'granted';
        },
      },
      async capturePdf(url, doi) {
        assert.equal(url, 'https://example.org/A.pdf');
        assert.equal(doi, '10.1000/A');
        if (pauseAt === 'PDF download') { started.resolve(); await resume.promise; }
        return { bytes: new Uint8Array([37, 80, 68, 70]), source: 'browser_capture' };
      },
    });
    panel.run(`
      currentArticleData = original;
      nativePort = null;
      vaultDirHandle = root;
      getSubDirHandle = async (_root, parts) => ({ path: parts.join('/') });
      writeFileToDir = async (dir, name, data) => writes.push({ path: dir.path + '/' + name, data });
      checkBrowserVaultStatus = async () => {};
      fetchPdfBytesForBrowserVault = capturePdf;
    `);
    panel.element('opt-figures').checked = false;
    const pending = panel.run('startIngestion()');
    await started.promise;
    await panel.switchToB();
    panel.element('topic-select').value = 'Other';
    panel.element('opt-source').checked = false;
    resume.resolve();
    await pending;

    const source = writes.find((entry) => entry.path.endsWith('.md'));
    assert.ok(source, 'The source requested at the start must still be written');
    assert.match(source.path, /^Research\/Neurology\/sources\/40000001_/);
    assert.match(source.data, /Body of A/);
    assert.match(source.data, /Figure of A/);
    assert.match(source.data, /Table of A/);
    assert.doesNotMatch(source.data, /Body of B|Figure of B|Table of B/);
    assert.ok(writes.some((entry) => /\/40000001_.*\.pdf$/.test(entry.path)));
    assert.equal(panel.run('currentArticleData.metadata.title'), 'Paper B');
    assert.equal(panel.run('currentArticleData.ingested_stem'), undefined);
  });
}

for (const route of ['PDF', 'empty metadata', 'missing result']) {
  for (const succeeds of [true, false]) {
    test(`stale ${route} metadata ${succeeds ? 'success' : 'failure'} preserves the newly selected article`, async () => {
      const panel = loadPanel();
      const started = deferred();
      const metadata = deferred();
      Object.assign(panel.context, {
        delayedMetadata: async () => { started.resolve(); return metadata.promise; },
      });
      panel.run('fetchBibliographicMetadata = delayedMetadata;');
      panel.state.tab.url = route === 'PDF'
        ? 'https://example.org/doi/pdf/10.1000/A'
        : 'https://example.org/doi/full/10.1000/A';
      panel.state.data = route === 'empty metadata' ? { metadata: {} } : null;
      const pending = panel.run('detectActiveTab()');
      await started.promise;
      await panel.switchToB();
      metadata.resolve(succeeds ? article('A').metadata : null);
      await pending;

      assert.equal(panel.run('currentArticleData.metadata.title'), 'Paper B');
      assert.equal(panel.element('art-title').textContent, 'Paper B');
      assert.equal(panel.element('article-content').classList.contains('hidden'), false);
      assert.equal(panel.sent.some((message) => message.action === 'check_status' && message.payload.doi === '10.1000/A'), false);
    });
  }
}

test('a stale PDF capture does not start a native inspection', async () => {
  const panel = loadPanel();
  const started = deferred();
  const capture = deferred();
  panel.context.chrome.scripting.executeScript = async (options) => {
    if (options.files) return [{ result: panel.state.data }];
    started.resolve();
    return capture.promise;
  };
  panel.state.tab.url = 'https://example.org/A.pdf';
  const pending = panel.run('detectActiveTab()');
  await started.promise;
  await panel.switchToB();
  capture.resolve([{ result: { ok: true, base64: 'JVBERg==' } }]);
  await pending;
  assert.equal(panel.sent.some((message) => message.action === 'inspect_pdf' || message.action === 'upload_pdf_chunk'), false);
  assert.equal(panel.run('currentArticleData.metadata.title'), 'Paper B');
});

test('native PDF inspection replies only update their detection generation', async () => {
  const panel = loadPanel();
  panel.state.tab.url = 'https://example.org/A.pdf';
  panel.context.chrome.scripting.executeScript = async (options) => options.files
    ? [{ result: panel.state.data }]
    : [{ result: { ok: true, base64: 'JVBERg==' } }];
  await panel.run('detectActiveTab()');
  const request = panel.sent.find((message) => message.action === 'inspect_pdf');
  assert.equal(typeof request.payload.detect_generation, 'number');

  // A response for the current detection is accepted.
  panel.context.reply = {
    status: 'ok', pdf_inspection: true, detect_generation: request.payload.detect_generation,
    metadata: article('A').metadata,
  };
  panel.run('handleNativeResponse(reply)');
  assert.equal(panel.run('currentArticleData.metadata.title'), 'Paper A');

  await panel.switchToB();
  panel.run('handleNativeResponse(reply)');
  panel.context.reply = {
    status: 'error', pdf_inspection: true, detect_generation: request.payload.detect_generation,
    message: 'Old PDF failed',
  };
  panel.run('handleNativeResponse(reply)');
  assert.equal(panel.run('currentArticleData.metadata.title'), 'Paper B');
  assert.equal(panel.element('article-content').classList.contains('hidden'), false);
});
