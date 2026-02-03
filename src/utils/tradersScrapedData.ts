import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import * as cheerio from 'cheerio';
import * as path from 'path';
import type { ScraperTraderData, ScrapingResult, SocialLookup } from './types';

class KOLScanScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private logger: Logger;

  constructor() {
    this.logger = new Logger();
  }

  private async setupBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
    this.logger.info("Setting up Chromium browser with Playwright");
    
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    this.page = await this.context.newPage();
    
    this.logger.info("Playwright browser initialized");
    return { browser: this.browser, context: this.context, page: this.page };
  }

  private async clickTimeFilter(page: Page, period: 'Daily' | 'Weekly' | 'Monthly'): Promise<void> {
    this.logger.info(`Attempting to click ${period} filter button`);
    await page.waitForTimeout(5000);

    const selectors = {
      Daily: [`text=${period}`, `xpath=//*[contains(text(), '${period}')]`],
      Weekly: [`text=${period}`, `xpath=//*[contains(text(), '${period}')]`],
      Monthly: [`text=${period}`, `xpath=//*[contains(text(), '${period}')]`]
    }[period];

    for (const selector of selectors) {
      try {
        this.logger.info(`Trying selector: ${selector}`);

        await page.waitForSelector(selector, { timeout: 15000, state: 'visible' });
        
        const button = page.locator(selector).first();
        
        await button.scrollIntoViewIfNeeded();
        await page.waitForTimeout(1000);

        try {
          await button.click();
          this.logger.info(`Clicked ${period} button (regular click)`);
        } catch {
          await button.evaluate(el => (el as HTMLElement).click());
          this.logger.info(`Clicked ${period} button (JS click)`);
        }

        await page.waitForTimeout(3000);
        return;
      } catch (err) {
        this.logger.warn(`Selector ${selector} failed: ${err}`);
      }
    }

    const pageContent = await page.content();
    writeFileSync(`debug_page_${period}.html`, pageContent, 'utf-8');
    throw new Error(`Could not click ${period} button`);
  }

  private async extractData(page: Page, period: 'Daily' | 'Weekly' | 'Monthly'): Promise<ScraperTraderData[]> {
    this.logger.info(`Extracting data for ${period}`);
    const periodDays = { Daily: 1, Weekly: 7, Monthly: 30 };
    const pageSource = await page.content();
    const $ = cheerio.load(pageSource);

    const socialLookup = this.extractSocialLookup($);
    const users = $('div.leaderboard_leaderboardUser__8OZpJ');
    const data: ScraperTraderData[] = [];

    users.each((index, userEl) => {
      try {
        const $user = $(userEl);
        const accountLink = $user.find('a').first();
        const walletName = accountLink.find('h1').text().trim();
        const walletAddress = accountLink.attr('href')?.split('/account/')[1]?.split('?')[0] || '';
        const walletAvatar = accountLink.find('img').attr('src') || '';
        const accountName = $user.find('p.remove-mobile').text().trim();

        const winLossTags = $user.find('div.remove-mobile p');
        const wins = winLossTags.eq(0).text().trim();
        const losses = winLossTags.eq(1).text().trim();

        const pnlTags = $user.find('div.leaderboard_totalProfitNum__HzfFO h1');
        const pnlSol = pnlTags.eq(0).text().trim();
        const pnlUsd = pnlTags.eq(1).text().trim();

        const socialInfo = socialLookup[walletAddress];
        data.push({
          period: periodDays[period],
          walletName,
          walletAddress,
          walletAvatar,
          accountName,
          wins,
          losses,
          pnlUsd,
          pnlSol,
          telegram: socialInfo?.telegram || null,
          twitter: socialInfo?.twitter || null,
          rank: index + 1
        });
      } catch (err) {
        this.logger.warn(`Failed user extraction [${index}]: ${err}`);
      }
    });

    this.logger.info(`Extracted ${data.length} users for ${period}`);
    return data;
  }

  private extractSocialLookup($: cheerio.CheerioAPI): SocialLookup {
    const socialLookup: SocialLookup = {};
    try {
      const scripts = $('script').toArray();
      let combinedPushContent = '';
      for (const script of scripts) {
        const scriptContent = $(script).html();
        if (scriptContent && scriptContent.includes('self.__next_f.push')) {
          combinedPushContent += scriptContent;
        }
      }
      if (combinedPushContent.includes("wallet_address")) {
        const matches = combinedPushContent.match(/{.*?wallet_address.*?}/g);
        if (matches) {
          for (const raw of matches) {
            try {
              const item = JSON.parse(raw);
              socialLookup[item.wallet_address] = {
                telegram: item.telegram || null,
                twitter: item.twitter || null
              };
            } catch {}
          }
        }
      }
    } catch (err) {
      this.logger.error(`Failed social media parse: ${err}`);
    }
    return socialLookup;
  }

  async scrapeKOLScan(): Promise<ScrapingResult[]> {
    this.logger.info("Starting KOLScan scrape");
    const { browser, context, page } = await this.setupBrowser();
    const allResults: ScrapingResult[] = [];

    try {
      await page.goto("https://kolscan.io/leaderboard", { waitUntil: 'networkidle' });
      await page.waitForTimeout(5000);

      for (const period of ['Daily', 'Weekly', 'Monthly'] as const) {
        if (period !== 'Daily') {
          await this.clickTimeFilter(page, period);
        }
        const periodData = await this.extractData(page, period);
        allResults.push({
          traders: periodData,
          timestamp: new Date().toISOString(),
          totalTraders: periodData.length,
          period
        });
      }
    } finally {
      await this.cleanup();
    }

    this.logger.info(`Scrape finished, got ${allResults.length} periods`);
    return allResults;
  }

  async scrapeLiveActivity(): Promise<any[]> {
    const page = this.page || (await this.setupBrowser()).page;
    this.logger.info("Scraping live activity");
    
    await page.goto("https://kolscan.io", { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    const pageSource = await page.content();
    const activities: any[] = [];
    const matches = pageSource.match(/\[(.*?)\]\s+(bought|sold)\s+([\d.]+)\s+sol.*?(\w+)/gi);
    
    if (matches) {
      matches.forEach(m => {
        const parts = m.match(/\[(.*?)\]\s+(bought|sold)\s+([\d.]+)\s+sol.*?(\w+)/i);
        if (parts) {
          activities.push({
            trader: parts[1],
            action: parts[2],
            solAmount: parseFloat(parts[3]),
            token: parts[4],
            timestamp: new Date().toISOString()
          });
        }
      });
    }
    
    this.logger.info(`Found ${activities.length} activities`);
    return activities;
  }

  async startMonitoring(intervalMs = 60000): Promise<void> {
    this.logger.info(`Monitoring every ${intervalMs / 1000}s`);
    
    const monitor = async () => {
      try {
        const results = await this.scrapeKOLScan();
        const live = await this.scrapeLiveActivity();
        this.logger.info(`Cycle done: ${results.length} periods, ${live.length} live`);
      } catch (err) {
        this.logger.error(`Monitor error: ${err}`);
        await this.cleanup();
      }
    };

    await monitor();
    setInterval(monitor, intervalMs);
  }

  async cleanup(): Promise<void> {
    try {
      if (this.page) {
        await this.page.close();
        this.page = null;
      }
      if (this.context) {
        await this.context.close();
        this.context = null;
      }
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      this.logger.info("Browser cleaned up");
    } catch (err) {
      this.logger.error(`Cleanup error: ${err}`);
    }
  }
}

class Logger {
  private logDir = 'logs';
  
  constructor() {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir);
    }
  }
  
  private log(level: string, message: string) {
    const ts = new Date().toISOString();
    const msg = `${ts} - ${level} - ${message}`;
    console.log(msg);
    const file = path.join(this.logDir, `gmgn_scraper_${ts.split('T')[0]}.log`);
    writeFileSync(file, msg + '\n', { flag: 'a' });
  }
  
  info(msg: string) { this.log('INFO', msg); }
  warn(msg: string) { this.log('WARN', msg); }
  error(msg: string) { this.log('ERROR', msg); }
}

export class DataProcessor {
  static filterProfitableTraders(traders: ScraperTraderData[]) {
    return traders.filter(t => parseFloat(t.pnlSol.replace(/[^\d.-]/g, '')) > 0);
  }
  
  static getTopTraders(traders: ScraperTraderData[], count = 10) {
    return traders.sort((a, b) => parseFloat(b.pnlSol) - parseFloat(a.pnlSol)).slice(0, count);
  }
  
  static calculateStats(traders: ScraperTraderData[]) {
    const totalPnL = traders.reduce((s, t) => s + parseFloat(t.pnlSol.replace(/[^\d.-]/g, '')), 0);
    const profitable = traders.filter(t => parseFloat(t.pnlSol) > 0);
    return {
      total: traders.length,
      profitable: profitable.length,
      unprofitable: traders.length - profitable.length,
      profitRate: (profitable.length / traders.length) * 100,
      totalPnL,
      avgPnL: totalPnL / traders.length
    };
  }
}

async function main() {
  const scraper = new KOLScanScraper();
  try {
    const results = await scraper.scrapeKOLScan();
    for (const result of results) {
      console.log(`\n📊 ${result.period} Results: ${result.totalTraders} traders`);
      const stats = DataProcessor.calculateStats(result.traders);
      console.log(`Profitable: ${stats.profitable}/${stats.total} (${stats.profitRate.toFixed(1)}%)`);
      console.log(`Avg PnL: ${stats.avgPnL.toFixed(2)} SOL`);
      DataProcessor.getTopTraders(result.traders, 5).forEach((t, i) =>
        console.log(`${i + 1}. ${t.walletName} (${t.walletAddress}): ${t.pnlSol}`)
      );
    }
    await scraper.startMonitoring(10000);
  } catch (err) {
    console.error("Main error:", err);
  } finally {
    await scraper.cleanup();
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export { KOLScanScraper, Logger };
