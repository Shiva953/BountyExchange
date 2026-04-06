import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AxiomVisionScraper } from "@/utils/axiomVisionScraper";

export async function POST() {
  const scraper = new AxiomVisionScraper();

  try {
    const result = await scraper.scrapeAxiomVision();

    // Safety guard: do not touch the DB if the scraper returned nothing
    if (result.totalTraders === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "Scraper returned 0 traders — DB not modified",
        },
        { status: 422 }
      );
    }

    let inserted = 0;
    let updated = 0;

    for (const trader of result.traders) {
      const existing = await prisma.trader.findFirst({
        where: { address: trader.address },
      });

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

    return NextResponse.json({
      success: true,
      message: `Processed ${result.totalTraders} traders from Axiom Vision`,
      inserted,
      updated,
      traders: result.traders.slice(0, 10),
    });
  } catch (error) {
    console.error("Error initializing traders:", error);
    return NextResponse.json(
      {
        error: "Failed to initialize traders",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  } finally {
    await scraper.cleanup();
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
