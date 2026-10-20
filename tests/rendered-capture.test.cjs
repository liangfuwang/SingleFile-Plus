const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');
const FakeTimers = require('@sinonjs/fake-timers');
const vm = require('node:vm');

const source = readFileSync(require.resolve('../extension/rendered-capture.js'), 'utf8');
const fixtureHtml = readFileSync(require.resolve('./rendered-capture.html'), 'utf8');
const fixtureSource = fixtureHtml.slice(fixtureHtml.indexOf('async function runFixture('), fixtureHtml.indexOf("\ndocument.getElementById('run').onclick"));

// JSDOM 不实现排版和滚动。只补几何与滚动事件，分页、DOM 变更、按钮点击、
// MutationObserver、序列化均使用真正的 DOM；时间由可控时钟推进，不依赖网络速度。
async function run(name, captureSource = source, configure = () => {}) {
  const nested = name === 'nested';
  const dom = new JSDOM('<!doctype html><body>' +
    (nested ? '<aside style="overflow-y:auto"><div>隐藏侧栏</div></aside>' : '') +
    '<main' + (nested ? ' style="overflow-y:auto"' : '') + '><div id="items"></div><div id="loader"></div></main>', {
    url: 'https://capture.test/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  const root = w.document.documentElement;
  const main = w.document.querySelector('main');
  const positions = new WeakMap();
  const contentHeight = () => w.document.querySelectorAll('app-comment-item').length * 78 + 80;
  Object.defineProperty(w.document, 'scrollingElement', { value: root });
  Object.defineProperty(w, 'innerHeight', { value: 360 });
  Object.defineProperty(w, 'innerWidth', { value: 700 });
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
  Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { get() {
    if (this === root || this === w.document.body) return 360;
    if (this.tagName === 'ASIDE' || (this === main && nested)) return 300;
    return contentHeight();
  } });
  Object.defineProperty(w.HTMLElement.prototype, 'scrollHeight', { get() {
    if (this.tagName === 'ASIDE') return 100000;
    if ((this === root || this === w.document.body) && nested) return 360;
    return Math.max(this.clientHeight, contentHeight());
  } });
  Object.defineProperty(w.HTMLElement.prototype, 'scrollTop', {
    get() { return positions.get(this) || 0; },
    set(top) {
      const actual = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
      if (actual === this.scrollTop) return;
      positions.set(this, actual);
      w.setTimeout(() => (this === root ? w : this).dispatchEvent(new w.Event('scroll')), 0);
    },
  });
  w.HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = top; };
  w.scrollTo = ({ top }) => { root.scrollTop = top; };
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    const x = this.tagName === 'ASIDE' ? -10000 : 0;
    return { x, y: 0, left: x, top: 0, right: x + 700, bottom: this.clientHeight, width: 700, height: this.clientHeight };
  };
  w.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  const clock = FakeTimers.withGlobal(w).install({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  let result;
  w.postMessage = (data) => { result = data; };
  try {
    configure(w);
    w.eval(captureSource);
    w.eval(fixtureSource + '\nrunFixture(' + JSON.stringify(name) + ').catch(e=>parent.postMessage({error:e.message},location.origin));');
    await clock.tickAsync(15000);
    assert.ok(result, 'capture must finish within the configured time budget');
    assert.equal(result.error, undefined);
    return result;
  } finally {
    clock.uninstall();
    w.close();
  }
}

for (const name of ['slow-text', 'spinner', 'short', 'nested', 'stalled']) {
  test(name + ': pagination, loading state and completeness', async () => {
    const result = await run(name);
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.actual, result.expected);
    if (name === 'stalled') {
      assert.equal(result.info.stopReason, 'stalled');
      assert.equal(result.info.loading, true);
    } else {
      assert.equal(result.info.stopReason, 'stable');
      assert.ok(result.info.bottomChecks >= 3);
      assert.equal(result.info.loading, false);
    }
    assert.equal(result.navigated, false, 'must not click links that leave the page');
  });
}

test('blocked scroll is reported as incomplete', async () => {
  const result = await run('slow-text', source, (w) => {
    w.HTMLElement.prototype.scrollTo = () => {};
    w.scrollTo = () => {};
  });
  assert.equal(result.info.stopReason, 'blocked');
  assert.equal(result.actual, 20);
});

test('service worker loads the capture function and prefers the active matching tab', async () => {
  const context = vm.createContext({
    chrome: {
      storage: { session: { get: async () => ({}), set: async () => {} } },
      runtime: { onMessage: { addListener() {} } },
      tabs: { query: async () => [
        { id: 1, url: 'https://capture.test/topic/1', lastAccessed: 10 },
        { id: 2, url: 'https://capture.test/topic/1', active: true, lastAccessed: 20 },
      ] },
    },
  });
  context.importScripts = (name) => vm.runInContext(readFileSync(require.resolve('../extension/' + name), 'utf8'), context);
  vm.runInContext(readFileSync(require.resolve('../extension/background.js'), 'utf8'), context);
  assert.equal(typeof context.captureRenderedDom, 'function');
  const result = await context.findOrOpenTab('https://capture.test/topic/1');
  assert.equal(result.tabId, 2);
  assert.equal(result.created, false);
});

for (const stopReason of ['stable', 'stalled', 'blocked', 'timeout', 'rounds']) {
  test('saved HTML keeps completeness metadata and warnings: ' + stopReason, async () => {
    const dom = new JSDOM('<!doctype html>', { url: 'https://capture.test/', runScripts: 'outside-only' });
    const w = dom.window;
    let saved;
    const scrollInfo = { stopReason, mainComments: 60, bottomChecks: 3 };
    try {
      w.chrome = { runtime: { onMessage: { addListener() {} } } };
      w.eval(readFileSync(require.resolve('../extension/common.js'), 'utf8'));
      w.eval(readFileSync(require.resolve('../extension/offscreen.js'), 'utf8'));
      w.log = () => {};
      w.progress = () => {};
      w.rpc = async (op) => op === 'capture' ? {
        html: '<!doctype html><html><head><title>Fixture</title></head><body><article>Saved comment</article></body></html>',
        baseUrl: 'https://capture.test/', blobs: {}, nodesBefore: 1, nodesAfter: 1, scrollInfo,
      } : {};
      w.downloadHtml = async (html) => { saved = html; };
      w.fetch = () => { throw new Error('fixture must not fetch external resources'); };
      await w.saveRendered('https://capture.test/', 'fixture');
      const doc = new w.DOMParser().parseFromString(saved, 'text/html');
      assert.deepEqual(JSON.parse(doc.querySelector('meta[name="singlefile-plus-capture"]').content), scrollInfo);
      assert.equal(Boolean(doc.querySelector('[role="alert"]')), stopReason !== 'stable');
      assert.equal(doc.querySelector('article').textContent, 'Saved comment');
    } finally { w.close(); }
  });
}

if (process.env.CAPTURE_BASELINE) {
  test('old implementation reproduces premature completion on the same slow-page fixture', async () => {
    const oldSource = readFileSync(process.env.CAPTURE_BASELINE, 'utf8');
    const result = await run('slow-text', oldSource);
    assert.equal(result.passed, false);
    assert.equal(result.actual, 20);
    assert.equal(result.info.stopReason, 'stable');
  });
}
