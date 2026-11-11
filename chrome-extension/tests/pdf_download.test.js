const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.js'), 'utf8');

for (const host of ['jamanetwork.com', 'www.nejm.org']) {
  test(`${host} HTML response does not start a Chrome download`, async () => {
    let downloadCalled = false;
    const element = { addEventListener() {}, classList: { add() {}, remove() {} } };
    const context = vm.createContext({
      document: { getElementById: () => element, addEventListener() {} },
      chrome: {
        tabs: { query: async () => [{ id: 1 }] },
        scripting: { executeScript: async () => [{ result: { ok: false, reason: 'response is not a PDF' } }] },
        downloads: { download: async () => { downloadCalled = true; } },
      },
      fetch: async () => ({ ok: true, blob: async () => new Blob(['<html>Get Access</html>']) }),
      Blob, URL, console,
    });
    vm.runInContext(script, context);
    const result = await vm.runInContext(
      `downloadAndUploadPdf('https://${host}/doi/pdf/example', { title: 'Example' }, 'Neurology')`, context,
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'publisher_rejected');
    assert.equal(downloadCalled, false);
  });
}
