const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.js'), 'utf8');

test('PDF inspection uses resolved PMID for its stem and source Markdown', () => {
  const sent = [];
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      checked: false, value: 'Neurology', textContent: '',
      classList: { add() {}, remove() {} },
      addEventListener() {}, querySelector() { return { textContent: '' }; },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element, addEventListener() {} },
    chrome: {}, URL, console,
  });
  vm.runInContext(script, context);
  vm.runInContext(`nativePort = { postMessage: (message) => sent.push(message) };`, Object.assign(context, { sent }));

  vm.runInContext(`handleNativeResponse({
    status: 'ok', pdf_inspection: true,
    metadata: { title: 'Clinicopathological correlations', authors: 'Perry D.', journal: 'Brain', year: 2017,
      doi: '10.1093/brain/awx254', pmid: '29106509', url: 'https://example.org/paper.pdf',
      pdf_url: 'https://example.org/paper.pdf' },
    sections: [{ heading: 'PDF 全文', level: 2, text: 'Article body' }],
    downloaded_file_path: '/tmp/inspection.pdf'
  })`, context);

  assert.equal(element('opt-source').checked, true);
  assert.equal(element('art-pmid').textContent, 'PMID: 29106509');
  assert.equal(vm.runInContext('computeStem(currentArticleData.metadata)', context),
    '29106509_Perry_Clinicopathological_correlations_2017');
  assert.equal(vm.runInContext('currentArticleData.downloaded_file_path', context), '/tmp/inspection.pdf');
  assert.equal(sent[0].action, 'check_status');
  assert.equal(sent[0].payload.pmid, '29106509');
});

test('Complex DOI stem sanitization, custom vault PDF link, and browser-only Markdown generation', () => {
  const sent = [];
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      checked: false, value: 'Neurology', textContent: '', href: '',
      classList: { add() {}, remove() {} },
      addEventListener() {}, querySelector() { return { textContent: '' }; },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: {
      getElementById: element,
      querySelector: () => ({ value: 'note' }),
      addEventListener() {},
    },
    chrome: {}, URL, console,
  });
  vm.runInContext(script, context);
  vm.runInContext(`nativePort = { postMessage: (message) => sent.push(message) };`, Object.assign(context, { sent }));

  // Ping sets custom vault name
  vm.runInContext(`handleNativeResponse({ status: 'ok', version: '1.0.0', vault_name: 'MyCustomVault', zotero_indexed_dois: 12 })`, context);

  const stem = vm.runInContext(`computeStem({
    title: 'Trial of "Novel" Therapy',
    authors: 'McDonald R.',
    year: 2026,
    doi: '10.1016/s0140-6736(24)00123-4'
  })`, context);
  assert.equal(stem, '10.1016_s0140-6736_24_00123-4_McDonald_Trial_of_Novel_Therapy_2026');

  vm.runInContext(`currentArticleData = {
    metadata: { title: 'Trial of "Novel" Therapy', authors: 'McDonald R.', year: 2026, doi: '10.1016/s0140-6736(24)00123-4' },
    sections: [{ heading: 'Results', level: 2, text: 'Significant benefit.' }],
    figures: [], tables: []
  }`, context);

  vm.runInContext(`handleNativeResponse({
    status: 'success',
    stem: '39999999_McDonald_Trial_of_Novel_Therapy_2026',
    metadata: { title: 'Trial of "Novel" Therapy', citekey: 'mcdonald2026trial', doi: '10.1016/s0140-6736(24)00123-4', pmid: '39999999' },
    source: { created: true, path: 'Research/Neurology/sources/39999999_McDonald_Trial_of_Novel_Therapy_2026.md' },
    pdf: { saved: true, source: 'browser_capture', path: 'Research/Neurology/sources/etc/39999999_McDonald_Trial_of_Novel_Therapy_2026.pdf',
           obsidian_uri: 'obsidian://open?vault=MyCustomVault&file=Research%2FNeurology%2Fsources%2Fetc%2F39999999_McDonald_Trial_of_Novel_Therapy_2026.pdf' },
    note: { created: false, updated: false },
    zotero: { key: 'ZKEY1' }
  })`, context);

  assert.equal(
    element('link-ob-pdf').href,
    'obsidian://open?vault=MyCustomVault&file=Research%2FNeurology%2Fsources%2Fetc%2F39999999_McDonald_Trial_of_Novel_Therapy_2026.pdf',
  );
  assert.equal(vm.runInContext('currentArticleData.ingested_stem', context), '39999999_McDonald_Trial_of_Novel_Therapy_2026');

  const md = vm.runInContext(`buildStructuredMarkdown(currentArticleData, 'Neurology')`, context);
  assert.equal(md.includes('title: "Trial of \\"Novel\\" Therapy"'), true);
  assert.equal(md.includes('## Results\nSignificant benefit.'), true);
});

test('Browser File System Access API mode writes source, figures, PDF, and reading notes directly to Vault directory handle', async () => {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      checked: true, value: 'Neurology', textContent: '', href: '', disabled: false,
      style: {},
      classList: { add() {}, remove() {} },
      addEventListener() {}, querySelector() { return { textContent: '' }; },
    });
    return elements.get(id);
  };

  function createMockDir(name) {
    const dirs = new Map();
    const files = new Map();
    return {
      name,
      _dirs: dirs,
      _files: files,
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
      async getDirectoryHandle(childName, opts = {}) {
        if (!dirs.has(childName)) {
          if (!opts.create) throw new Error(`Dir not found: ${childName}`);
          dirs.set(childName, createMockDir(childName));
        }
        return dirs.get(childName);
      },
      async getFileHandle(fileName, opts = {}) {
        if (!files.has(fileName)) {
          if (!opts.create) throw new Error(`File not found: ${fileName}`);
          files.set(fileName, { content: '' });
        }
        const entry = files.get(fileName);
        return {
          async createWritable() {
            return {
              async write(data) {
                entry.content = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
              },
              async close() {},
            };
          },
          async getFile() {
            return {
              async text() {
                return String(entry.content);
              },
            };
          },
        };
      },
      async *entries() {
        for (const [k, v] of dirs.entries()) yield [k, v];
        for (const [k, v] of files.entries()) yield [k, v];
      },
    };
  }

  const rootDir = createMockDir('ObsidianVault');
  const context = vm.createContext({
    document: {
      getElementById: element,
      querySelector: () => ({ value: 'note' }),
      addEventListener() {},
    },
    chrome: {},
    URL,
    Blob,
    console,
    fetch: async (url) => {
      if (url.endsWith('.pdf')) {
        return {
          ok: true,
          headers: { get: () => 'application/pdf' },
          arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 mock pdf content ' + 'x'.repeat(1100)).buffer,
        };
      }
      return {
        ok: true,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0]).buffer,
      };
    },
  });
  vm.runInContext(script, context);
  context.rootDir = rootDir;
  vm.runInContext(`
    nativePort = null;
    isNativeHostOnline = false;
    vaultDirHandle = rootDir;
    currentVaultName = rootDir.name;
    currentArticleData = {
      metadata: {
        title: 'Direct Browser Vault Test',
        authors: 'Lin T.',
        journal: 'Lancet Neurol',
        year: 2026,
        doi: '10.1016/j.test.2026.01',
        pmid: '40123456',
        url: 'https://example.org/article',
        pdf_url: 'https://example.org/article.pdf'
      },
      sections: [{ heading: 'Findings', level: 2, text: 'Browser FS API works.' }],
      figures: [{ label: 'Figure 1', caption: 'Study flow', src: 'https://example.org/fig1.png' }],
      tables: []
    };
  `, context);

  await vm.runInContext(`ingestViaBrowserFileSystem()`, context);

  const stem = '40123456_Lin_Direct_Browser_Vault_Test_2026';
  const topicDir = rootDir._dirs.get('Research')._dirs.get('Neurology');
  const sourceFile = topicDir._dirs.get('sources')._files.get(`${stem}.md`);
  const pdfFile = topicDir._dirs.get('sources')._dirs.get('etc')._files.get(`${stem}.pdf`);
  const assetDir = topicDir._dirs.get('sources')._dirs.get('_assets')._dirs.get(stem);

  assert.ok(sourceFile, 'Source markdown file should be created in Vault');
  assert.equal(sourceFile.content.includes('## Findings\nBrowser FS API works.'), true);
  assert.equal(sourceFile.content.includes(`![Figure 1](_assets/${stem}/Figure_1_1.png)`), true);
  assert.ok(pdfFile, 'PDF file should be saved in sources/etc/');
  assert.equal(pdfFile.content.startsWith('%PDF-'), true);
  assert.ok(assetDir._files.get('Figure_1_1.png'), 'Figure image should be saved in sources/_assets/<stem>/');

  // Now test saving reading note and preserving existing frontmatter
  await vm.runInContext(`saveReadingNoteViaBrowserFileSystem({
    topic: 'Neurology',
    stem: '${stem}',
    citekey: 'lin2026direct',
    doi: '10.1016/j.test.2026.01',
    pmid: '40123456',
    target_type: 'note',
    content: '## 臨床重點\\n\\n這是一段閱讀筆記。',
    is_html: false,
    is_pdf: false
  })`, context);
  const noteFile = topicDir._dirs.get('notes')._files.get(`${stem}.md`);
  assert.ok(noteFile, 'Reading note should be created in notes/');
  assert.equal(noteFile.content.includes('pmid: 40123456'), true);
  assert.equal(noteFile.content.includes('這是一段閱讀筆記。'), true);

  // Inject custom frontmatter field and verify subsequent save preserves it
  noteFile.content = noteFile.content.replace('type: reading-note\n', 'type: reading-note\ncustom_tag: keep-me\n');
  await vm.runInContext(`saveReadingNoteViaBrowserFileSystem({
    topic: 'Neurology',
    stem: '${stem}',
    citekey: 'lin2026direct',
    doi: '10.1016/j.test.2026.01',
    pmid: '40123456',
    target_type: 'note',
    content: '## 更新後的筆記\\n\\n第二版內容。',
    is_html: false,
    is_pdf: false
  })`, context);
  assert.equal(noteFile.content.includes('custom_tag: keep-me'), true);
  assert.equal(noteFile.content.includes('第二版內容。'), true);

  // Check status updates UI elements
  await vm.runInContext(`checkBrowserVaultStatus(currentArticleData.metadata, 'Neurology')`, context);
  assert.equal(element('status-source').textContent, '已有全文快照 ✓');
  assert.equal(element('status-pdf').textContent, '已有原廠 PDF ✓');
  assert.equal(element('status-note').textContent, '已建立筆記 ✓');
});
