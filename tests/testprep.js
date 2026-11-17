// For the pre-1.3 suites: their seeded single-profile data would trigger the one-time
// "Who's this?" upgrade sheet. Convert it into a named profile before the app starts.
const pw = require('playwright');
const SKIP_INTRO = `(() => {
  try {
    const legacy = localStorage.getItem('dailyTracker:data');
    const idx = JSON.parse(localStorage.getItem('dailyTracker:profiles') || 'null');
    if (legacy !== null && !idx) {
      localStorage.setItem('dailyTracker:data:ptest', legacy);
      localStorage.removeItem('dailyTracker:data');
      localStorage.setItem('dailyTracker:profiles', JSON.stringify({ version: 1, activeId: 'ptest', profiles: [{ id: 'ptest', name: 'Me', avatar: { type: 'emoji', emoji: '', color: '#6366f1' } }] }));
    } else if (legacy !== null && idx) {
      localStorage.removeItem('dailyTracker:data'); // a test's seed script re-adding it is ignored
    }
  } catch (e) {}
})();`;
const origLaunch = pw.chromium.launch.bind(pw.chromium);
pw.chromium.launch = async (...a) => {
  const b = await origLaunch(...a);
  const origNewContext = b.newContext.bind(b);
  b.newContext = async (...c) => {
    const ctx = await origNewContext(...c);
    const origNewPage = ctx.newPage.bind(ctx);
    let added = false;
    ctx.newPage = async () => { if (!added) { await ctx.addInitScript(SKIP_INTRO); added = true; } return origNewPage(); };
    return ctx;
  };
  return b;
};
module.exports = pw;
