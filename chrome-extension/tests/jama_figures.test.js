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
  assert.equal('cookies' in data, false);
});

test('Wrapped tables are extracted only once and not duplicated by inner table selector', () => {
  const makeCell = (text) => ({ textContent: text });
  const makeRow = (cells) => ({
    querySelectorAll: () => cells.map(makeCell),
  });
  const tableEl = {
    tagName: 'TABLE',
    querySelectorAll: (sel) => sel === 'tr' ? [
      makeRow(['Characteristic', 'Treatment (n=100)', 'Placebo (n=100)']),
      makeRow(['Age, mean (SD), y', '68.4 (7.2)', '68.1 (7.5)']),
    ] : [],
  };
  const wrapEl = {
    tagName: 'DIV',
    querySelector: (sel) => {
      if (sel === 'table') return tableEl;
      if (sel.includes('caption')) return { textContent: 'Table 1. Baseline Characteristics' };
      return null;
    },
  };
  const document = {
    cookie: 'session=secret', contentType: 'text/html',
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector.includes('.table-wrap')) return [wrapEl, tableEl];
      return [];
    },
  };
  const data = vm.runInNewContext(script, {
    document,
    window: { location: new URL('https://jamanetwork.com/journals/jamaneurology/fullarticle/2854364') },
    URL,
  });
  assert.equal(data.tables.length, 1);
  assert.equal(data.tables[0].caption, 'Table 1. Baseline Characteristics');
});
