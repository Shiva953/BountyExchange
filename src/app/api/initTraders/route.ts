import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { KOLScanScraper } from "@/utils/tradersScrapedData";

export async function POST() {
  try {
    console.log("=== API: Init Traders - Starting scrape ===");

    const scraper = new KOLScanScraper();
    const results = await scraper.scrapeKOLScan();

    // Collect all unique traders from all periods
    const tradersMap = new Map<
      string,
      { name: string; address: string; imageUrl: string | null }
    >();

    for (const result of results) {
      for (const trader of result.traders) {
        // Use walletAddress as the unique key to avoid duplicates
        if (!tradersMap.has(trader.walletAddress)) {
          tradersMap.set(trader.walletAddress, {
            name: trader.walletName || trader.accountName || "Unknown",
            address: trader.walletAddress,
            imageUrl: trader.walletAvatar || null,
          });
        }
      }
    }

    const tradersToInsert = Array.from(tradersMap.values());
    console.log(`Found ${tradersToInsert.length} unique traders to insert`);

    // Upsert traders to avoid duplicates if run multiple times
    let inserted = 0;
    let updated = 0;

    for (const trader of tradersToInsert) {
      const existing = await prisma.trader.findFirst({
        where: { address: trader.address },
      });

      if (existing) {
        await prisma.trader.update({
          where: { id: existing.id },
          data: {
            name: trader.name,
            imageUrl: trader.imageUrl,
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

    await scraper.cleanup();

    console.log(`=== API: Init Traders Complete ===`);
    console.log(`Inserted: ${inserted}, Updated: ${updated}`);

    return NextResponse.json({
      success: true,
      message: `Initialized ${tradersToInsert.length} traders`,
      inserted,
      updated,
      traders: tradersToInsert.slice(0, 10), // Return first 10 as sample
    });
  } catch (error) {
    console.error("=== API Error ===");
    console.error(error);
    return NextResponse.json(
      {
        error: "Failed to initialize traders",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

// GET endpoint to check current traders in DB
export async function GET() {
  try {
    const traders = await prisma.trader.findMany({
      orderBy: { id: "asc" },
    });

    return NextResponse.json({
      success: true,
      count: traders.length,
      traders,
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      {
        error: "Failed to fetch traders",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
