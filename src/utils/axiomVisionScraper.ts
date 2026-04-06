import { chromium, Browser, Page, BrowserContext } from 'playwright';

export interface AxiomTraderData {
  address: string;
  name: string | null;
  imageUrl: string | null;
}

export interface AxiomScrapeResult {
  traders: AxiomTraderData[];
  timestamp: string;
  totalTraders: number;
}

class AxiomVisionScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  private async setupBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      },
    });

    this.page = await this.context.newPage();
    return { browser: this.browser, context: this.context, page: this.page };
  }

  private attachResponseListener(page: Page, captured: AxiomTraderData[]): void {
    page.on('response', async (response) => {
      try {
        const contentType = response.headers()['content-type'] ?? '';
        if (!contentType.includes('application/json')) return;

        const text = await response.text().catch(() => null);
        if (!text) return;

        if (
          !text.includes('"address"') &&
          !text.includes('"wallet"') &&
          !text.includes('"trader"')
        ) return;

        let json: unknown;
        try { json = JSON.parse(text); } catch { return; }

        const found = this.parseTraderJson(json);
        if (found.length > 0) {
          console.log(`[AxiomScraper] ${found.length} traders from: ${response.url()}`);
          captured.push(...found);
        }
      } catch { /* ignore */ }
    });
  }

  private parseTraderJson(json: unknown): AxiomTraderData[] {
    const results: AxiomTraderData[] = [];
    const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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
        (typeof obj['publicKey'] === 'string' && SOL_ADDR_RE.test(obj['publicKey']) && obj['publicKey']) ||
        null;

      if (addr) {
        const name =
          (typeof obj['name'] === 'string' && obj['name']) ||
          (typeof obj['username'] === 'string' && obj['username']) ||
          (typeof obj['handle'] === 'string' && obj['handle']) ||
          (typeof obj['label'] === 'string' && obj['label']) ||
          (typeof obj['displayName'] === 'string' && obj['displayName']) ||
          (typeof obj['display_name'] === 'string' && obj['display_name']) ||
          null;

        const imageUrl =
          (typeof obj['imageUrl'] === 'string' && obj['imageUrl']) ||
          (typeof obj['image'] === 'string' && obj['image']) ||
          (typeof obj['avatar'] === 'string' && obj['avatar']) ||
          (typeof obj['pfp'] === 'string' && obj['pfp']) ||
          (typeof obj['profileImage'] === 'string' && obj['profileImage']) ||
          null;

        results.push({ address: addr, name: name || null, imageUrl: imageUrl || null });
        return;
      }

      Object.values(obj).forEach(walk);
    };

    walk(json);
    return results;
  }

  private async extractFromDOM(page: Page): Promise<AxiomTraderData[]> {
    const SOL_ADDR_SOURCE = '[1-9A-HJ-NP-Za-km-z]{32,44}';

    return page.evaluate((pattern: string) => {
      const re = new RegExp(`^${pattern}$`);
      const results: Array<{ address: string; name: string | null; imageUrl: string | null }> = [];
      const seen = new Set<string>();

      document.querySelectorAll('a[href]').forEach((el) => {
        const segments = (el as HTMLAnchorElement).href.split('/');
        for (const seg of segments) {
          const cleaned = seg.split('?')[0];
          if (re.test(cleaned) && !seen.has(cleaned)) {
            seen.add(cleaned);
            const text = el.textContent?.trim() || null;
            const name = text && !re.test(text) ? text : null;
            const img = el.querySelector('img');
            results.push({ address: cleaned, name, imageUrl: img?.src || null });
          }
        }
      });

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent?.trim() || '';
        if (re.test(text) && !seen.has(text)) {
          seen.add(text);
          results.push({ address: text, name: null, imageUrl: null });
        }
      }

      return results;
    }, SOL_ADDR_SOURCE);
  }

  private async scrollToLoadAll(page: Page, passes = 5, delayMs = 2000): Promise<void> {
    for (let i = 0; i < passes; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
      await page.waitForTimeout(delayMs);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);
  }

  private dedupeByAddress(traders: AxiomTraderData[]): AxiomTraderData[] {
    const seen = new Map<string, AxiomTraderData>();
    for (const t of traders) {
      const existing = seen.get(t.address);
      if (!existing) {
        seen.set(t.address, t);
      } else {
        seen.set(t.address, {
          address: t.address,
          name: existing.name || t.name,
          imageUrl: existing.imageUrl || t.imageUrl,
        });
      }
    }
    return Array.from(seen.values());
  }

  async scrapeAxiomVision(): Promise<AxiomScrapeResult> {
    const { page } = await this.setupBrowser();
    const networkCapture: AxiomTraderData[] = [];

    try {
      this.attachResponseListener(page, networkCapture);

      console.log('[AxiomScraper] Navigating to axiom.trade/vision...');
      await page.goto('https://axiom.trade/vision?chain=sol', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      await page.waitForTimeout(6000);
      await this.scrollToLoadAll(page, 5, 2000);

      let traders: AxiomTraderData[];

      if (networkCapture.length > 0) {
        console.log(`[AxiomScraper] Network captured ${networkCapture.length} raw entries`);
        traders = this.dedupeByAddress(networkCapture);
      } else {
        console.log('[AxiomScraper] No network data — falling back to DOM extraction');
        const domTraders = await this.extractFromDOM(page);
        console.log(`[AxiomScraper] DOM extracted ${domTraders.length} entries`);
        traders = this.dedupeByAddress(domTraders);
      }

      console.log(`[AxiomScraper] Final unique traders: ${traders.length}`);

      return {
        traders,
        timestamp: new Date().toISOString(),
        totalTraders: traders.length,
      };
    } finally {
      await this.cleanup();
    }
  }

  async cleanup(): Promise<void> {
    try {
      if (this.page) { await this.page.close(); this.page = null; }
      if (this.context) { await this.context.close(); this.context = null; }
      if (this.browser) { await this.browser.close(); this.browser = null; }
    } catch (err) {
      console.error('[AxiomScraper] Cleanup error:', err);
    }
  }
}

export { AxiomVisionScraper };
