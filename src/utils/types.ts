/**
 * Web scraper types
 */

/**
 * Raw trader data from web scraping (Playwright scraper output)
 */
export interface ScraperTraderData {
    period: number;
    walletName: string;
    walletAddress: string;
    walletAvatar?: string;
    accountName?: string;
    wins: string;
    losses: string;
    pnlUsd: string;
    pnlSol: string;
    telegram?: string | null;
    twitter?: string | null;
    rank?: number;
  }
  
  export interface ScrapingResult {
    traders: ScraperTraderData[];
    timestamp: string;
    totalTraders: number;
    period: string;
  }
  
  export interface SocialLookup {
    [walletAddress: string]: {
      telegram: string | null;
      twitter: string | null;
    };
  }