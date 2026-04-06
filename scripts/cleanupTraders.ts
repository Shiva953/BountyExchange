import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const dirtyTraders = await prisma.trader.findMany({
    where: { address: { contains: '?' } },
    include: { deals: { select: { id: true } } },
  });

  console.log(`Dirty addresses found: ${dirtyTraders.length}`);

  let sanitizeUpdated = 0;
  let sanitizeDeleted = 0;

  for (const dirty of dirtyTraders) {
    const cleanAddr = dirty.address.split('?')[0];
    const hasDirtyDeals = dirty.deals.length > 0;
    const clean = await prisma.trader.findUnique({ where: { address: cleanAddr } });

    if (clean) {
      const hasCleanDeals = (await prisma.deal.count({ where: { traderId: clean.id } })) > 0;

      if (!hasDirtyDeals) {
        await prisma.trader.delete({ where: { id: dirty.id } });
        sanitizeDeleted++;
      } else if (!hasCleanDeals) {
        await prisma.trader.delete({ where: { id: clean.id } });
        await prisma.trader.update({ where: { id: dirty.id }, data: { address: cleanAddr } });
        sanitizeUpdated++;
        sanitizeDeleted++;
      } else {
        console.log(`  ⚠ Both dirty (${dirty.id}) and clean (${clean.id}) have deals for ${cleanAddr} — skipped`);
      }
    } else {
      await prisma.trader.update({ where: { id: dirty.id }, data: { address: cleanAddr } });
      sanitizeUpdated++;
    }
  }

  console.log(`  Sanitized (updated): ${sanitizeUpdated}`);
  console.log(`  Removed duplicates : ${sanitizeDeleted}`);

  const [nullRows, dupeNameRows, dupeAddrRows] = await Promise.all([
    prisma.$queryRaw<{ id: number }[]>`
      SELECT t.id FROM trader t
      WHERE  t.name IS NULL
      AND    NOT EXISTS (SELECT 1 FROM deal d WHERE d."traderId" = t.id)
    `,
    prisma.$queryRaw<{ id: number }[]>`
      WITH ranked AS (
        SELECT t.id,
          ROW_NUMBER() OVER (
            PARTITION BY t.name
            ORDER BY (SELECT COUNT(*) FROM deal d WHERE d."traderId" = t.id) DESC, t.id DESC
          ) AS rn
        FROM trader t WHERE t.name IS NOT NULL
      )
      SELECT r.id FROM ranked r
      WHERE  r.rn > 1
      AND    NOT EXISTS (SELECT 1 FROM deal d WHERE d."traderId" = r.id)
    `,
    prisma.$queryRaw<{ id: number }[]>`
      WITH ranked AS (
        SELECT t.id,
          ROW_NUMBER() OVER (
            PARTITION BY t.address
            ORDER BY (SELECT COUNT(*) FROM deal d WHERE d."traderId" = t.id) DESC, t.id DESC
          ) AS rn
        FROM trader t
      )
      SELECT r.id FROM ranked r
      WHERE  r.rn > 1
      AND    NOT EXISTS (SELECT 1 FROM deal d WHERE d."traderId" = r.id)
    `,
  ]);

  const allIds = [...new Set([
    ...nullRows.map(r => r.id),
    ...dupeNameRows.map(r => r.id),
    ...dupeAddrRows.map(r => r.id),
  ])];

  console.log(`\nNULL-name to delete   : ${nullRows.length}`);
  console.log(`Dupe-name to delete   : ${dupeNameRows.length}`);
  console.log(`Dupe-address to delete: ${dupeAddrRows.length}`);
  console.log(`Total unique to delete: ${allIds.length}`);

  if (allIds.length > 0) {
    const { count } = await prisma.trader.deleteMany({ where: { id: { in: allIds } } });
    console.log(`\n✅ Deleted ${count} traders`);
  } else {
    console.log('\nNo further duplicates found.');
  }

  console.log(`Remaining in DB: ${await prisma.trader.count()}`);
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
