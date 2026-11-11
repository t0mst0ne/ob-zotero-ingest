const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.js'), 'utf8');

function loadSidePanel({ chrome, fetch, warnings }) {
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
        classList: {
          hidden: false,
          add(name) { if (name === 'hidden') this.hidden = true; },
          remove(name) { if (name === 'hidden') this.hidden = false; },
          contains(name) { return name === 'hidden' && this.hidden; },
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
    fetch,
    URL,
    setTimeout,
    clearTimeout,
    console: {
      log() {},
      warn(...args) { if (warnings) warnings.push(args.map(String).join(' ')); },
      error() {},
    },
  });
  vm.runInContext(script, context);
  vm.runInContext('nativePort = { postMessage() {}, disconnect() {} };', context);
  return { context, element };
}

test('extracts DOI and PubMed ids from publisher and viewer URLs', () => {
  const { context } = loadSidePanel({ chrome: {} });
  const cases = [
    ['https://www.neurology.org/doi/pdfdirect/10.1212/WNL.0000000000218741', '10.1212/wnl.0000000000218741', '', ''],
    ['https://www.neurology.org/doi/pdfdirect/10.1212%2FWNL.0000000000218741', '10.1212/wnl.0000000000218741', '', ''],
    ['https://www.nature.com/articles/doi/pdf/10.1038/s41586-024-07000-1', '10.1038/s41586-024-07000-1', '', ''],
    ['https://onlinelibrary.wiley.com/doi/epdf/10.1002/ana.27001', '10.1002/ana.27001', '', ''],
    ['https://www.thelancet.com/doi/full/10.1016/S0140-6736(24)00123-4', '10.1016/s0140-6736(24)00123-4', '', ''],
    ['https://doi.org/10.1212/WNL.0000000000218741', '10.1212/wnl.0000000000218741', '', ''],
    ['https://example.org/doi/pdf/10.1000/abc.pdf?download=true', '10.1000/abc', '', ''],
    ['https://example.org/doi/abs/10.1000/xyz', '10.1000/xyz', '', ''],
    ['https://pubmed.ncbi.nlm.nih.gov/38701234/', '', '38701234', ''],
    ['https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10987654/pdf/main.pdf', '', '', 'PMC10987654'],
    ['file:///Users/me/Vault/paper.pdf', '', '', ''],
  ];
  for (const [url, doi, pmid, pmcid] of cases) {
    const ids = vm.runInContext(`extractArticleIdsFromUrl(${JSON.stringify(url)})`, context);
    assert.equal(ids.doi, doi, url);
    assert.equal(ids.pmid, pmid, url);
    assert.equal(ids.pmcid, pmcid, url);
  }
  assert.equal(vm.runInContext(
    'isPdfTabUrl("https://www.neurology.org/doi/pdfdirect/10.1212/WNL.0000000000218741")', context,
  ), true);
  assert.equal(vm.runInContext('isPdfTabUrl("file:///Users/me/Vault/paper.pdf")', context), true);
  assert.equal(vm.runInContext(
    'isPdfTabUrl("https://www.thelancet.com/doi/full/10.1016/S0140-6736(24)00123-4")', context,
  ), false);
});

test('publisher PDF 403 falls back to DOI metadata without a console warning', async () => {
  const warnings = [];
  const sent = [];
  const fetched = [];
  const pdfUrl = 'https://www.neurology.org/doi/pdfdirect/10.1212/WNL.0000000000218741';
  const { context, element } = loadSidePanel({
    warnings,
    chrome: {
      scripting: {
        executeScript: async () => [{ result: { ok: false, reason: 'HTTP 403' } }],
      },
      downloads: {
        download: async () => { throw new Error('blocked'); },
      },
    },
    fetch: async (url) => {
      const href = String(url);
      fetched.push(href);
      if (href.includes('api.crossref.org')) {
        return {
          ok: true,
          json: async () => ({
            message: {
              title: ['Plasma biomarkers in neurology'],
              author: [{ family: 'Perry', given: 'David' }],
              'container-title': ['Neurology'],
              published: { 'date-parts': [[2024]] },
              DOI: '10.1212/wnl.0000000000218741',
              URL: 'https://doi.org/10.1212/wnl.0000000000218741',
              abstract: '<jats:p>Cohort study.</jats:p>',
            },
          }),
        };
      }
      if (href.includes('esearch.fcgi')) {
        return { ok: true, json: async () => ({ esearchresult: { idlist: ['39990001'] } }) };
      }
      if (href.includes('esummary.fcgi')) {
        return {
          ok: true,
          json: async () => ({
            result: {
              39990001: {
                title: 'Plasma biomarkers in neurology.',
                authors: [{ name: 'Perry D' }, { name: 'Lin T' }],
                source: 'Neurology',
                pubdate: '2024 Jan',
                articleids: [{ idtype: 'doi', value: '10.1212/wnl.0000000000218741' }],
              },
            },
          }),
        };
      }
      throw new Error('HTTP 403');
    },
  });
  vm.runInContext('nativePort = { postMessage: (message) => sent.push(message), disconnect() {} };', Object.assign(context, { sent }));

  await vm.runInContext(`inspectPdfTab({ id: 4, url: ${JSON.stringify(pdfUrl)} })`, context);

  assert.equal(element('art-title').textContent, 'Plasma biomarkers in neurology');
  assert.equal(element('art-doi').textContent, 'DOI: 10.1212/wnl.0000000000218741');
  assert.equal(element('art-pmid').textContent, 'PMID: 39990001');
  assert.match(element('art-meta').textContent, /Perry D/);
  assert.match(element('art-meta').textContent, /Neurology \(2024\)/);
  assert.match(element('pdf-fetch-note').textContent, /未能直接取得 PDF/);
  assert.equal(element('pdf-fetch-note').classList.contains('hidden'), false);
  assert.equal(element('result-error') && element('error-text').textContent, '');
  assert.equal(warnings.some((line) => line.includes('403') || line.includes('PDF fetch')), false);
  assert.equal(sent.some((message) => message.action === 'inspect_pdf'), false);
  assert.equal(sent.some((message) => message.action === 'check_status' && message.payload.doi === '10.1212/wnl.0000000000218741'), true);
  assert.equal(vm.runInContext('currentArticleData.metadata.pdf_url', context), pdfUrl);
});

test('a local file PDF still goes to the native host when the download succeeds', async () => {
  const fetched = [];
  const sent = [];
  const fileUrl = 'file:///Users/me/Vault/paper.pdf';
  const { context } = loadSidePanel({
    chrome: {
      scripting: { executeScript: async () => [{ result: { ok: false, reason: 'viewer blocked' } }] },
      downloads: {
        download: async () => 9,
        onChanged: {
          addListener(fn) { fn({ id: 9, state: { current: 'complete' } }); },
          removeListener() {},
        },
        search(_query, callback) { callback([{ filename: '/Users/me/Vault/paper.pdf' }]); },
      },
    },
    fetch: async (url) => {
      fetched.push(String(url));
      throw new Error('HTTP 403');
    },
  });
  vm.runInContext('nativePort = { postMessage: (message) => sent.push(message), disconnect() {} };', Object.assign(context, { sent }));

  await vm.runInContext(`inspectPdfTab({ id: 2, url: ${JSON.stringify(fileUrl)} })`, context);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'inspect_pdf');
  assert.equal(sent[0].payload.downloaded_file_path, '/Users/me/Vault/paper.pdf');
  assert.equal(sent[0].payload.url, fileUrl);
  assert.equal(fetched.some((url) => url.includes('api.crossref.org')), false);
});
