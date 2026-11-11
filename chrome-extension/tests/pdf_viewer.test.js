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
