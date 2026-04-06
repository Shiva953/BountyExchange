import { chromium } from 'playwright';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

interface KolEntry {
  address: string;
  name: string | null;
  imageUrl: string | null;
}

function parseKolsResponse(json: unknown): KolEntry[] {
  const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const results: KolEntry[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;

    const addr =
      (typeof obj['address'] === 'string' && SOL_ADDR_RE.test(obj['address']) && obj['address']) ||
      (typeof obj['wallet'] === 'string' && SOL_ADDR_RE.test(obj['wallet']) && obj['wallet']) ||
      (typeof obj['walletAddress'] === 'string' && SOL_ADDR_RE.test(obj['walletAddress']) && obj['walletAddress']) ||
      (typeof obj['wallet_address'] === 'string' && SOL_ADDR_RE.test(obj['wallet_address']) && obj['wallet_address']) ||
      null;

    if (addr) {
      const name =
        (typeof obj['name'] === 'string' && obj['name']) ||
        (typeof obj['username'] === 'string' && obj['username']) ||
        (typeof obj['handle'] === 'string' && obj['handle']) ||
        (typeof obj['label'] === 'string' && obj['label']) ||
        null;
      const imageUrl =
        (typeof obj['imageUrl'] === 'string' && obj['imageUrl']) ||
        (typeof obj['image'] === 'string' && obj['image']) ||
        (typeof obj['avatar'] === 'string' && obj['avatar']) ||
        (typeof obj['pfp'] === 'string' && obj['pfp']) ||
        null;
      results.push({ address: addr, name: name || null, imageUrl: imageUrl || null });
      return;
    }
    Object.values(obj).forEach(walk);
  };

  walk(json);
  return results;
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  console.log('\n🌐 Browser opened — log in to axiom.trade then go to the Vision (SOL) page.');
  console.log('   Script will auto-capture once the trader list loads (up to 3 min).\n');

  const kolsPromise = new Promise<KolEntry[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for vision-kols-v2')), 180_000);

    page.on('response', async (res) => {
      if (!res.url().includes('vision-kols-v2')) return;
      clearTimeout(timer);
      try {
        const json = await res.json();
        resolve(parseKolsResponse(json));
      } catch (err) {
        reject(err);
      }
    });
  });

  await page.goto('https://axiom.trade/vision?chain=sol', { waitUntil: 'domcontentloaded', timeout: 60_000 });

  let traders: KolEntry[];
  try {
    traders = await kolsPromise;
  } finally {
    await browser.close();
  }

  console.log(`✅ Captured ${traders.length} traders from Axiom Vision`);

  if (traders.length === 0) {
    console.error('❌ No traders returned — DB not modified.');
    process.exit(1);
  }

  const seen = new Set<string>();
  const unique = traders.filter(t => seen.has(t.address) ? false : (seen.add(t.address), true));

  console.log(`\n📝 Syncing ${unique.length} unique traders to DB...`);
  let inserted = 0;
  let updated = 0;

  for (const trader of unique) {
    const existing = await prisma.trader.findUnique({ where: { address: trader.address } });

    if (existing) {
      await prisma.trader.update({
        where: { id: existing.id },
        data: {
          name: trader.name ?? existing.name,
          imageUrl: trader.imageUrl ?? existing.imageUrl,
        },
      });
      updated++;
    } else {
      await prisma.trader.create({
        data: {
          name: trader.name,
          address: trader.address,
          imageUrl: trader.imageUrl,
        },
      });
      inserted++;
    }
  }

  await prisma.$disconnect();

  console.log(`\n✅ Done — inserted: ${inserted}, updated: ${updated}`);
  console.log('\nFirst 10 traders synced:');
  unique.slice(0, 10).forEach((t, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. ${t.name ?? '(unnamed)'}  ${t.address}`)
  );
}

main().catch(async (err) => {
  console.error('Error:', err);
  await prisma.$disconnect();
  process.exit(1);
});
