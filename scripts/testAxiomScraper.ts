import { chromium } from 'playwright';

const LOGIN_WAIT_MS = 60_000;

async function main() {
  const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  const captured: Array<{ url: string; body: string }> = [];
  page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] ?? '';
      if (!ct.includes('application/json')) return;
      const text = await res.text().catch(() => '');
      if (text.length > 10) captured.push({ url: res.url(), body: text });
    } catch { /* ignore */ }
  });

  await page.goto('https://axiom.trade/vision?chain=sol', { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log(`\n🌐 Browser opened — you have ${LOGIN_WAIT_MS / 1000}s to:`);
  console.log('   1. Log in to axiom.trade');
  console.log('   2. Navigate to https://axiom.trade/vision?chain=sol');
  console.log('   3. Wait for the trader table to load\n');

  for (let s = LOGIN_WAIT_MS / 1000; s > 0; s -= 5) {
    await new Promise(r => setTimeout(r, 5000));
    console.log(`   ⏳ ${s - 5}s remaining...`);
  }

  console.log('\n📸 Capturing data...');

  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
    await new Promise(r => setTimeout(r, 1500));
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise(r => setTimeout(r, 1000));

  const tradersMap = new Map<string, { address: string; name: string | null; imageUrl: string | null }>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;

    const addr =
      (typeof obj['address'] === 'string' && SOL_ADDR_RE.test(obj['address']) && obj['address']) ||
      (typeof obj['wallet'] === 'string' && SOL_ADDR_RE.test(obj['wallet']) && obj['wallet']) ||
      (typeof obj['walletAddress'] === 'string' && SOL_ADDR_RE.test(obj['walletAddress']) && obj['walletAddress']) ||
      (typeof obj['wallet_address'] === 'string' && SOL_ADDR_RE.test(obj['wallet_address']) && obj['wallet_address']) ||
      (typeof obj['pubkey'] === 'string' && SOL_ADDR_RE.test(obj['pubkey']) && obj['pubkey']) ||
      null;

    if (addr) {
      const name =
        (typeof obj['name'] === 'string' && obj['name']) ||
        (typeof obj['username'] === 'string' && obj['username']) ||
        (typeof obj['handle'] === 'string' && obj['handle']) ||
        (typeof obj['label'] === 'string' && obj['label']) ||
        (typeof obj['displayName'] === 'string' && obj['displayName']) ||
        null;
      const imageUrl =
        (typeof obj['imageUrl'] === 'string' && obj['imageUrl']) ||
        (typeof obj['image'] === 'string' && obj['image']) ||
        (typeof obj['avatar'] === 'string' && obj['avatar']) ||
        (typeof obj['pfp'] === 'string' && obj['pfp']) ||
        null;

      if (!tradersMap.has(addr)) {
        tradersMap.set(addr, { address: addr, name: name || null, imageUrl: imageUrl || null });
      } else {
        const ex = tradersMap.get(addr)!;
        tradersMap.set(addr, { address: addr, name: ex.name || name || null, imageUrl: ex.imageUrl || imageUrl || null });
      }
      return;
    }
    Object.values(obj).forEach(walk);
  };

  for (const { url, body } of captured) {
    try {
      const json = JSON.parse(body);
      const before = tradersMap.size;
      walk(json);
      const added = tradersMap.size - before;
      if (added > 0) console.log(`  +${added} traders from: ${url}`);
    } catch { /* skip */ }
  }

  if (tradersMap.size === 0) {
    console.log('No API data — trying DOM extraction...');
    const domTraders = await page.evaluate((pattern: string) => {
      const re = new RegExp(`^${pattern}$`);
      const results: Array<{ address: string; name: string | null; imageUrl: string | null }> = [];
      const seen = new Set<string>();
      document.querySelectorAll('a[href]').forEach((el) => {
        (el as HTMLAnchorElement).href.split('/').forEach((seg) => {
          const cleaned = seg.split('?')[0];
          if (re.test(cleaned) && !seen.has(cleaned)) {
            seen.add(cleaned);
            const text = el.textContent?.trim() || null;
            const name = text && !re.test(text) ? text : null;
            const img = el.querySelector('img');
            results.push({ address: cleaned, name, imageUrl: img?.src || null });
          }
        });
      });
      return results;
    }, '[1-9A-HJ-NP-Za-km-z]{32,44}');
    domTraders.forEach(t => tradersMap.set(t.address, t));
  }

  await browser.close();

  const traders = Array.from(tradersMap.values());
  console.log(`\n=== RESULT ===`);
  console.log(`Total: ${traders.length} unique traders\n`);

  if (traders.length === 0) {
    console.log('❌ No traders found.');
    console.log(`   API responses captured: ${captured.length}`);
    captured.slice(0, 5).forEach(r => console.log(`   ${r.url}\n   ${r.body.slice(0, 300)}\n`));
  } else {
    traders.slice(0, 30).forEach((t, i) =>
      console.log(`  ${String(i+1).padStart(2)}. ${t.address}  name=${t.name ?? '(none)'}  img=${t.imageUrl ? 'yes' : 'no'}`)
    );
  }
}

main().catch(console.error);
