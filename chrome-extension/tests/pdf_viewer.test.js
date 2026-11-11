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
