const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8');

test('JAMA View Large image is captured without a figure element', () => {
  const imageUrl = 'https://cdn.jamanetwork.com/ama/content_public/journal/neur/figure1.png?Signature=abc';
  const container = {
    textContent: 'Figure 1. Tau PET staging',
    parentElement: null,
    querySelector: () => null,
  };
  const link = {
    href: imageUrl,
    textContent: 'View Large',
    getAttribute: () => null,
    parentElement: container,
  };
  const document = {
    cookie: '', contentType: 'text/html',
    querySelector: () => null,
    querySelectorAll: selector => selector.includes('cdn.jamanetwork.com') ? [link] : [],
  };
  const data = vm.runInNewContext(script, {
    document,
    window: { location: new URL('https://jamanetwork.com/journals/jamaneurology/fullarticle/2854364') },
    URL,
  });
  assert.equal(data.figures.length, 1);
  assert.equal(data.figures[0].src, imageUrl);
  assert.equal(data.figures[0].label, 'Figure 1');
});
