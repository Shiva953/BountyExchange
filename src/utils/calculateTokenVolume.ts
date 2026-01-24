/**
 * Token Volume Calculator
 *
 * Calculates the total trading volume of a specific token by a given wallet.
 * Uses Helius Enhanced Transactions API to fetch and parse swap transactions.
 *
 * Flow:
 * 1. Get token account for wallet + token mint
 * 2. Fetch all transactions for the wallet
 * 3. Filter for swap/DEX transactions involving the target token
 * 4. Calculate total volume: SUM(token amount * price) for all swaps
 */

import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { getTokenPrice } from "./getTokenPrice";

interface TokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  fromTokenAccount: string;
  toTokenAccount: string;
  tokenAmount: number;
  mint: string;
  tokenStandard: string;
}

interface NativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number;
}

interface EnhancedTransaction {
  signature: string;
  type: string;
  source: string;
  fee: number;
  feePayer: string;
  slot: number;
  timestamp: number;
  description: string;
  tokenTransfers: TokenTransfer[];
  nativeTransfers: NativeTransfer[];
  accountData: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: Array<{
      mint: string;
      rawTokenAmount: {
        decimals: number;
        tokenAmount: string;
      };
      tokenAccount: string;
      userAccount: string;
    }>;
  }>;
}

interface SwapTransaction {
  signature: string;
  timestamp: number;
  tokenAmount: number;
  tokenMint: string;
  source: string;
}

interface VolumeResult {
  success: boolean;
  walletAddress: string;
  tokenMint: string;
  tokenAccount: string | null;
  totalSwapTransactions: number;
  totalVolume: number;
  volumeUSD: number;
  tokenPrice: number | null;
  swaps: SwapTransaction[];
  error?: string;
}

const HELIUS_API_BASE = "https://api-mainnet.helius-rpc.com/v0";
const DEBUG = true;

function debug(step: string, message: string, data?: unknown) {
  if (DEBUG) {
    console.log(`[VOLUME DEBUG][${step}] ${message}`);
    if (data !== undefined) {
      console.log(JSON.stringify(data, null, 2));
    }
  }
}

/**
 * Gets the associated token account for a wallet and token mint
 */
export async function getTokenAccount(
  walletAddress: string,
  tokenMint: string
): Promise<string | null> {
  debug("getTokenAccount", `Finding token account for wallet: ${walletAddress}, mint: ${tokenMint}`);

  try {
    const walletPubkey = new PublicKey(walletAddress);
    const mintPubkey = new PublicKey(tokenMint);

    const tokenAccount = await getAssociatedTokenAddress(
      mintPubkey,
      walletPubkey
    );

    const tokenAccountStr = tokenAccount.toBase58();
    debug("getTokenAccount", `Found token account: ${tokenAccountStr}`);

    return tokenAccountStr;
  } catch (error) {
    debug("getTokenAccount", `Error finding token account: ${error}`);
    return null;
  }
}

/**
 * Fetches all transactions for a wallet address using Helius getTransactionsForAddress
 * Uses pagination to get complete history within the specified time range.
 *
 * @param walletAddress - The wallet address to fetch transactions for
 * @param limit - Number of transactions per page (max 1000)
 * @param startTime - Optional start timestamp (unix seconds). Only include txns after this time.
 * @param endTime - Optional end timestamp (unix seconds). Only include txns before this time.
 *
 * If neither startTime nor endTime is provided, fetches ALL transactions (lifetime).
 */
export async function getAllTransactionsForAddress(
  walletAddress: string,
  limit: number = 100,
  startTime?: number,
  endTime?: number
): Promise<string[]> {
  debug("getAllTransactions", `Fetching transactions for wallet: ${walletAddress}`);
  debug("getAllTransactions", `Time range: ${startTime ? new Date(startTime * 1000).toISOString() : 'beginning'} to ${endTime ? new Date(endTime * 1000).toISOString() : 'now'}`);

  const allSignatures: string[] = [];
  let paginationToken: string | undefined;
  let pageCount = 0;

  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    debug("getAllTransactions", "ERROR: HELIUS_API_KEY not set");
    throw new Error("HELIUS_API_KEY environment variable is not set");
  }

  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

  try {
    while (true) {
      pageCount++;
      debug("getAllTransactions", `Fetching page ${pageCount}...`);

      const requestBody: {
        jsonrpc: string;
        id: string;
        method: string;
        params: [string, {
          transactionDetails: string;
          limit: number;
          sortOrder: string;
          paginationToken?: string;
        }];
      } = {
        jsonrpc: "2.0",
        id: "1",
        method: "getTransactionsForAddress",
        params: [
          walletAddress,
          {
            transactionDetails: "signatures",
            limit: Math.min(limit, 1000),
            sortOrder: "desc",
            ...(paginationToken && { paginationToken }),
          },
        ],
      };

      debug("getAllTransactions", "Request body:", requestBody);

      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        debug("getAllTransactions", `HTTP Error: ${response.status}`, errorText);
        throw new Error(`HTTP error: ${response.status} - ${errorText}`);
      }

      const result = await response.json();

      if (result.error) {
        debug("getAllTransactions", "RPC Error:", result.error);
        throw new Error(`RPC error: ${JSON.stringify(result.error)}`);
      }

      const data = result.result?.data || [];
      debug("getAllTransactions", `Page ${pageCount}: Found ${data.length} transactions`);

      if (data.length === 0) {
        break;
      }

      let reachedStartTime = false;
      for (const tx of data) {
        const txTimestamp = tx.timestamp;
        if (endTime && txTimestamp > endTime) continue;
        if (startTime && txTimestamp < startTime) {
          reachedStartTime = true;
          break;
        }
        allSignatures.push(tx.signature);
      }

      if (reachedStartTime) {
        debug("getAllTransactions", `Reached transactions older than startTime, stopping pagination`);
        break;
      }

      paginationToken = result.result?.paginationToken;
      if (!paginationToken) {
        debug("getAllTransactions", "No more pages available");
        break;
      }

      if (data.length < limit) {
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 50));
    }

    debug("getAllTransactions", `Total signatures fetched: ${allSignatures.length}`);
    return allSignatures;

  } catch (error) {
    debug("getAllTransactions", `Error fetching transactions: ${error}`);
    throw error;
  }
}

/**
 * Fetches enhanced/parsed transaction details from Helius
 * This gives us structured data about swaps, transfers, etc.
 */
export async function getEnhancedTransactions(
  signatures: string[]
): Promise<EnhancedTransaction[]> {
  debug("getEnhancedTransactions", `Parsing ${signatures.length} transactions`);

  if (signatures.length === 0) {
    return [];
  }

  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    throw new Error("HELIUS_API_KEY environment variable is not set");
  }

  const enhancedTxs: EnhancedTransaction[] = [];
  const batchSize = 100;

  try {
    for (let i = 0; i < signatures.length; i += batchSize) {
      const batch = signatures.slice(i, i + batchSize);
      debug("getEnhancedTransactions", `Processing batch ${Math.floor(i / batchSize) + 1}, size: ${batch.length}`);

      const response = await fetch(
        `${HELIUS_API_BASE}/transactions/?api-key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transactions: batch }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        debug("getEnhancedTransactions", `HTTP Error: ${response.status}`, errorText);
        throw new Error(`HTTP error: ${response.status} - ${errorText}`);
      }

      const result = await response.json();

      if (Array.isArray(result)) {
        enhancedTxs.push(...result);
        debug("getEnhancedTransactions", `Batch returned ${result.length} enhanced transactions`);
      } else {
        debug("getEnhancedTransactions", "Unexpected response format:", result);
      }

      if (i + batchSize < signatures.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    debug("getEnhancedTransactions", `Total enhanced transactions: ${enhancedTxs.length}`);
    return enhancedTxs;

  } catch (error) {
    debug("getEnhancedTransactions", `Error parsing transactions: ${error}`);
    throw error;
  }
}

const DEX_SOURCES = [
  "JUPITER",
  "RAYDIUM",
  "ORCA",
  "METEORA",
  "PHOENIX",
  "LIFINITY",
  "OPENBOOK",
  "SERUM",
  "ALDRIN",
  "SABER",
  "MARINADE",
  "STEPN",
  "PUMP_FUN",
  "MOONSHOT",
];

const SWAP_TYPES = [
  "SWAP",
  "SWAP_EXACT_TOKENS_FOR_TOKENS",
  "SWAP_TOKENS_FOR_EXACT_TOKENS",
];

/**
 * Filters transactions to find swaps involving the target token.
 *
 * IMPORTANT: A swap can have multiple transfers of the target token:
 * - User -> DEX (selling the token)
 * - DEX -> User (buying the token)
 *
 * We sum ALL transfers involving the wallet and target token to get true volume.
 */
export function filterSwapTransactions(
  transactions: EnhancedTransaction[],
  tokenMint: string,
  walletAddress: string,
  tokenAccount: string | null
): SwapTransaction[] {
  debug("filterSwapTransactions", `Filtering ${transactions.length} transactions for token: ${tokenMint}`);

  const swaps: SwapTransaction[] = [];
  const tokenMintLower = tokenMint.toLowerCase();
  const walletLower = walletAddress.toLowerCase();
  const tokenAccountLower = tokenAccount?.toLowerCase();

  for (const tx of transactions) {
    const isSwapType = SWAP_TYPES.some(type =>
      tx.type?.toUpperCase().includes(type)
    );
    const isFromDex = DEX_SOURCES.some(source =>
      tx.source?.toUpperCase().includes(source)
    );

    if (!isSwapType && !isFromDex) {
      continue;
    }

    debug("filterSwapTransactions", `Found swap tx: ${tx.signature}, type: ${tx.type}, source: ${tx.source}`);

    let totalTokenAmount = 0;
    let foundTransfers = false;

    if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
      for (const transfer of tx.tokenTransfers) {
        const mintMatch = transfer.mint?.toLowerCase() === tokenMintLower;
        const walletInvolved =
          transfer.fromUserAccount?.toLowerCase() === walletLower ||
          transfer.toUserAccount?.toLowerCase() === walletLower;
        const tokenAccountInvolved = tokenAccountLower && (
          transfer.fromTokenAccount?.toLowerCase() === tokenAccountLower ||
          transfer.toTokenAccount?.toLowerCase() === tokenAccountLower
        );

        if (mintMatch && (walletInvolved || tokenAccountInvolved)) {
          const amount = Math.abs(transfer.tokenAmount || 0);
          totalTokenAmount += amount;
          foundTransfers = true;

          debug("filterSwapTransactions", `Token transfer found:`, {
            signature: tx.signature,
            from: transfer.fromUserAccount,
            to: transfer.toUserAccount,
            amount: amount,
            mint: transfer.mint,
            runningTotal: totalTokenAmount,
          });
        }
      }
    }

    if (foundTransfers && totalTokenAmount > 0) {
      swaps.push({
        signature: tx.signature,
        timestamp: tx.timestamp,
        tokenAmount: totalTokenAmount,
        tokenMint: tokenMint,
        source: tx.source,
      });
      debug("filterSwapTransactions", `Added swap with total amount: ${totalTokenAmount}`);
      continue;
    }

    if (tx.accountData) {
      for (const account of tx.accountData) {
        if (account.tokenBalanceChanges) {
          for (const change of account.tokenBalanceChanges) {
            const mintMatch = change.mint?.toLowerCase() === tokenMintLower;
            const userMatch = account.account?.toLowerCase() === walletLower ||
              change.userAccount?.toLowerCase() === walletLower;

            if (mintMatch && userMatch) {
              const decimals = change.rawTokenAmount?.decimals || 0;
              const rawAmount = parseFloat(change.rawTokenAmount?.tokenAmount || "0");
              const tokenAmount = Math.abs(rawAmount / Math.pow(10, decimals));

              debug("filterSwapTransactions", `Balance change found:`, {
                signature: tx.signature,
                amount: tokenAmount,
                mint: change.mint,
              });

              totalTokenAmount += tokenAmount;
              foundTransfers = true;
            }
          }
        }
      }

      if (foundTransfers && totalTokenAmount > 0) {
        swaps.push({
          signature: tx.signature,
          timestamp: tx.timestamp,
          tokenAmount: totalTokenAmount,
          tokenMint: tokenMint,
          source: tx.source,
        });
        debug("filterSwapTransactions", `Added swap (from accountData) with total amount: ${totalTokenAmount}`);
      }
    }
  }

  debug("filterSwapTransactions", `Found ${swaps.length} swap transactions for target token`);
  return swaps;
}

/**
 * Calculates total volume from swap transactions
 */
export function calculateVolumeFromSwaps(
  swaps: SwapTransaction[],
  tokenPrice: number | null
): { totalVolume: number; volumeUSD: number } {
  debug("calculateVolumeFromSwaps", `Calculating volume from ${swaps.length} swaps`);

  let totalVolume = 0;

  for (const swap of swaps) {
    totalVolume += swap.tokenAmount;
    debug("calculateVolumeFromSwaps", `Swap ${swap.signature.slice(0, 8)}...: ${swap.tokenAmount} tokens`);
  }

  const volumeUSD = tokenPrice ? totalVolume * tokenPrice : 0;

  debug("calculateVolumeFromSwaps", `Total volume: ${totalVolume} tokens`);
  debug("calculateVolumeFromSwaps", `Volume in USD: $${volumeUSD.toFixed(2)}`);

  return { totalVolume, volumeUSD };
}

/**
 * Main function to calculate the total trading volume of a token by a wallet
 *
 * @param walletAddress - The wallet address to check
 * @param tokenMint - The token mint address
 * @param maxTransactions - Maximum number of transactions to fetch per page (default 500)
 * @param startTime - Optional start timestamp (unix seconds). Only count txns after this time.
 * @param endTime - Optional end timestamp (unix seconds). Only count txns before this time.
 *
 * If neither startTime nor endTime is provided, calculates volume for ALL transactions (lifetime).
 * @returns VolumeResult with total volume and swap details
 */
export async function calculateTokenVolume(
  walletAddress: string,
  tokenMint: string,
  maxTransactions: number = 500,
  startTime?: number,
  endTime?: number
): Promise<VolumeResult> {
  console.log("=".repeat(60));
  console.log("[VOLUME TRACKER] Starting volume calculation");
  console.log(`Wallet: ${walletAddress}`);
  console.log(`Token Mint: ${tokenMint}`);
  console.log(`Time Range: ${startTime ? new Date(startTime * 1000).toISOString() : 'beginning'} to ${endTime ? new Date(endTime * 1000).toISOString() : 'now'}`);
  console.log("=".repeat(60));

  try {
    console.log("\n[STEP 1] Getting token account...");
    const tokenAccount = await getTokenAccount(walletAddress, tokenMint);
    console.log(`Token Account: ${tokenAccount || "Not found"}`);

    console.log("\n[STEP 2] Fetching transactions...");
    const signatures = await getAllTransactionsForAddress(walletAddress, maxTransactions, startTime, endTime);
    console.log(`Found ${signatures.length} transactions`);

    if (signatures.length === 0) {
      console.log("No transactions found for this wallet");
      return {
        success: true,
        walletAddress,
        tokenMint,
        tokenAccount,
        totalSwapTransactions: 0,
        totalVolume: 0,
        volumeUSD: 0,
        tokenPrice: null,
        swaps: [],
      };
    }

    console.log("\n[STEP 3] Parsing transactions with Helius...");
    const enhancedTxs = await getEnhancedTransactions(signatures);
    console.log(`Parsed ${enhancedTxs.length} transactions`);

    console.log("\n[STEP 4] Filtering swap transactions...");
    const swaps = filterSwapTransactions(enhancedTxs, tokenMint, walletAddress, tokenAccount);
    console.log(`Found ${swaps.length} swap transactions for target token`);

    console.log("\n[STEP 5] Fetching token price...");
    const tokenPrice = await getTokenPrice(tokenMint);
    console.log(`Token Price: ${tokenPrice ? `$${tokenPrice}` : "Not available"}`);

    console.log("\n[STEP 6] Calculating volume...");
    const { totalVolume, volumeUSD } = calculateVolumeFromSwaps(swaps, tokenPrice);

    console.log("\n" + "=".repeat(60));
    console.log("[VOLUME TRACKER] Calculation Complete");
    console.log(`Total Swap Transactions: ${swaps.length}`);
    console.log(`Total Volume (tokens): ${totalVolume}`);
    console.log(`Total Volume (USD): $${volumeUSD.toFixed(2)}`);
    console.log("=".repeat(60));

    return {
      success: true,
      walletAddress,
      tokenMint,
      tokenAccount,
      totalSwapTransactions: swaps.length,
      totalVolume,
      volumeUSD,
      tokenPrice,
      swaps,
    };

  } catch (error) {
    console.error("\n[VOLUME TRACKER] Error:", error);
    return {
      success: false,
      walletAddress,
      tokenMint,
      tokenAccount: null,
      totalSwapTransactions: 0,
      totalVolume: 0,
      volumeUSD: 0,
      tokenPrice: null,
      swaps: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Alternative approach using Helius's transaction history endpoint with type=SWAP filter
 * This is more efficient as it pre-filters for swap transactions.
 *
 * @param walletAddress - The wallet address to fetch swap transactions for
 * @param tokenMint - Optional token mint to filter swaps by
 * @param startTime - Optional start timestamp (unix seconds). Only include txns after this time.
 * @param endTime - Optional end timestamp (unix seconds). Only include txns before this time.
 *
 * If neither startTime nor endTime is provided, fetches ALL swap transactions (lifetime).
 */
export async function getSwapTransactionsForAddress(
  walletAddress: string,
  tokenMint?: string,
  startTime?: number,
  endTime?: number
): Promise<EnhancedTransaction[]> {
  debug("getSwapTransactionsForAddress", `Fetching swap transactions for: ${walletAddress}`);
  debug("getSwapTransactionsForAddress", `Time range: ${startTime ? new Date(startTime * 1000).toISOString() : 'beginning'} to ${endTime ? new Date(endTime * 1000).toISOString() : 'now'}`);

  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    throw new Error("HELIUS_API_KEY environment variable is not set");
  }

  const allSwaps: EnhancedTransaction[] = [];
  let beforeSignature: string | undefined;
  let pageCount = 0;

  try {
    while (true) {
      pageCount++;
      // Don't use type=SWAP filter - fetch ALL transactions and filter ourselves
      // Helius's SWAP classification can miss some DEX transactions
      const url = new URL(`${HELIUS_API_BASE}/addresses/${walletAddress}/transactions`);
      url.searchParams.set("api-key", apiKey);
      // Removed: url.searchParams.set("type", "SWAP");
      if (beforeSignature) {
        url.searchParams.set("before", beforeSignature);
      }

      debug("getSwapTransactionsForAddress", `Fetching page ${pageCount}: ${url.toString()}`);

      const response = await fetch(url.toString());

      if (!response.ok) {
        const errorText = await response.text();
        debug("getSwapTransactionsForAddress", `HTTP Error: ${response.status}`, errorText);
        throw new Error(`HTTP error: ${response.status} - ${errorText}`);
      }

      const transactions: EnhancedTransaction[] = await response.json();

      if (!Array.isArray(transactions) || transactions.length === 0) {
        break;
      }

      debug("getSwapTransactionsForAddress", `Page ${pageCount}: Found ${transactions.length} swaps`);

      let reachedStartTime = false;
      for (const tx of transactions) {
        const txTimestamp = tx.timestamp;
        const txDate = new Date(txTimestamp * 1000).toISOString();

        debug("getSwapTransactionsForAddress", `Checking tx ${tx.signature.slice(0, 8)}... timestamp: ${txDate} (${txTimestamp})`);

        // Skip transactions after endTime (they're too new)
        if (endTime && txTimestamp > endTime) {
          debug("getSwapTransactionsForAddress", `  -> Skipping: after endTime`);
          continue;
        }

        // If transaction is before startTime, we've gone too far back
        // But DON'T break yet - check remaining transactions in this batch first
        // (Helius returns in descending order, so subsequent ones will also be too old)
        if (startTime && txTimestamp < startTime) {
          debug("getSwapTransactionsForAddress", `  -> Before startTime, marking to stop pagination`);
          reachedStartTime = true;
          break;
        }

        // Transaction is within time range - check if it's a swap and matches token
        // First, check if this is a swap transaction based on type or source
        const isSwapType = SWAP_TYPES.some(type =>
          tx.type?.toUpperCase().includes(type)
        );
        const isFromDex = DEX_SOURCES.some(source =>
          tx.source?.toUpperCase().includes(source)
        );
        const isSwap = isSwapType || isFromDex;

        debug("getSwapTransactionsForAddress", `  -> In time range. Type: ${tx.type}, Source: ${tx.source}, isSwap: ${isSwap}`);

        if (!isSwap) {
          debug("getSwapTransactionsForAddress", `  -> Not a swap transaction, skipping`);
          continue;
        }

        if (tokenMint) {
          const tokenMintLower = tokenMint.toLowerCase();
          const allMints = [
            ...(tx.tokenTransfers?.map(t => t.mint) || []),
            ...(tx.accountData?.flatMap(a => a.tokenBalanceChanges?.map(c => c.mint) || []) || [])
          ];

          debug("getSwapTransactionsForAddress", `  -> Mints in tx: ${JSON.stringify(allMints)}`);
          debug("getSwapTransactionsForAddress", `  -> Looking for: ${tokenMintLower}`);

          const matchesToken =
            tx.tokenTransfers?.some(t => t.mint?.toLowerCase() === tokenMintLower) ||
            tx.accountData?.some(a =>
              a.tokenBalanceChanges?.some(c => c.mint?.toLowerCase() === tokenMintLower)
            );
          if (matchesToken) {
            debug("getSwapTransactionsForAddress", `  -> TOKEN MATCH! Adding to results`);
            allSwaps.push(tx);
          } else {
            debug("getSwapTransactionsForAddress", `  -> No token match, skipping`);
          }
        } else {
          allSwaps.push(tx);
        }
      }

      if (reachedStartTime) {
        debug("getSwapTransactionsForAddress", `Reached transactions older than startTime, stopping pagination`);
        break;
      }

      beforeSignature = transactions[transactions.length - 1]?.signature;

      if (transactions.length < 100) {
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    debug("getSwapTransactionsForAddress", `Total swap transactions: ${allSwaps.length}`);
    return allSwaps;

  } catch (error) {
    debug("getSwapTransactionsForAddress", `Error: ${error}`);
    throw error;
  }
}

/**
 * Faster alternative using pre-filtered swap transactions
 *
 * @param walletAddress - The wallet address to check
 * @param tokenMint - The token mint address
 * @param startTime - Optional start timestamp (unix seconds). Only count txns after this time.
 * @param endTime - Optional end timestamp (unix seconds). Only count txns before this time.
 *
 * If neither startTime nor endTime is provided, calculates volume for ALL transactions (lifetime).
 */
export async function calculateTokenVolumeFast(
  walletAddress: string,
  tokenMint: string,
  startTime?: number,
  endTime?: number
): Promise<VolumeResult> {
  console.log("=".repeat(60));
  console.log("[VOLUME TRACKER FAST] Starting volume calculation");
  console.log(`Wallet: ${walletAddress}`);
  console.log(`Token Mint: ${tokenMint}`);
  console.log(`Time Range: ${startTime ? new Date(startTime * 1000).toISOString() : 'beginning'} to ${endTime ? new Date(endTime * 1000).toISOString() : 'now'}`);
  console.log("=".repeat(60));

  try {
    console.log("\n[STEP 1] Getting token account...");
    const tokenAccount = await getTokenAccount(walletAddress, tokenMint);
    console.log(`Token Account: ${tokenAccount || "Not found"}`);

    console.log("\n[STEP 2] Fetching swap transactions...");
    const swapTxs = await getSwapTransactionsForAddress(walletAddress, tokenMint, startTime, endTime);
    console.log(`Found ${swapTxs.length} swap transactions for token`);

    console.log("\n[STEP 3] Extracting swap amounts...");
    const swaps: SwapTransaction[] = [];
    const tokenMintLower = tokenMint.toLowerCase();
    const walletLower = walletAddress.toLowerCase();
    const tokenAccountLower = tokenAccount?.toLowerCase();

    for (const tx of swapTxs) {
      let tokenAmount = 0;
      let foundTransfers = false;

      for (const transfer of tx.tokenTransfers || []) {
        if (transfer.mint?.toLowerCase() === tokenMintLower) {
          const walletInvolved =
            transfer.fromUserAccount?.toLowerCase() === walletLower ||
            transfer.toUserAccount?.toLowerCase() === walletLower;
          const tokenAccountInvolved = tokenAccountLower && (
            transfer.fromTokenAccount?.toLowerCase() === tokenAccountLower ||
            transfer.toTokenAccount?.toLowerCase() === tokenAccountLower
          );

          if (walletInvolved || tokenAccountInvolved) {
            const amount = Math.abs(transfer.tokenAmount || 0);
            tokenAmount += amount;
            foundTransfers = true;

            debug("calculateTokenVolumeFast", `Transfer in tx ${tx.signature.slice(0, 8)}...:`, {
              from: transfer.fromUserAccount,
              to: transfer.toUserAccount,
              amount: amount,
              runningTotal: tokenAmount,
            });
          }
        }
      }

      if (!foundTransfers && tx.accountData) {
        for (const account of tx.accountData || []) {
          for (const change of account.tokenBalanceChanges || []) {
            if (change.mint?.toLowerCase() === tokenMintLower) {
              const userMatch = account.account?.toLowerCase() === walletLower ||
                change.userAccount?.toLowerCase() === walletLower;

              if (userMatch) {
                const decimals = change.rawTokenAmount?.decimals || 0;
                const rawAmount = parseFloat(change.rawTokenAmount?.tokenAmount || "0");
                const amount = Math.abs(rawAmount / Math.pow(10, decimals));
                tokenAmount += amount;
                foundTransfers = true;

                debug("calculateTokenVolumeFast", `Balance change in tx ${tx.signature.slice(0, 8)}...:`, {
                  amount: amount,
                  runningTotal: tokenAmount,
                });
              }
            }
          }
        }
      }

      if (tokenAmount > 0) {
        swaps.push({
          signature: tx.signature,
          timestamp: tx.timestamp,
          tokenAmount,
          tokenMint,
          source: tx.source,
        });
        debug("calculateTokenVolumeFast", `Added swap: ${tx.signature.slice(0, 8)}... total: ${tokenAmount}`);
      }
    }

    console.log(`Extracted ${swaps.length} swaps with amounts`);

    console.log("\n[STEP 4] Fetching token price...");
    const tokenPrice = await getTokenPrice(tokenMint);
    console.log(`Token Price: ${tokenPrice ? `$${tokenPrice}` : "Not available"}`);

    console.log("\n[STEP 5] Calculating volume...");
    const { totalVolume, volumeUSD } = calculateVolumeFromSwaps(swaps, tokenPrice);

    console.log("\n" + "=".repeat(60));
    console.log("[VOLUME TRACKER FAST] Calculation Complete");
    console.log(`Total Swap Transactions: ${swaps.length}`);
    console.log(`Total Volume (tokens): ${totalVolume}`);
    console.log(`Total Volume (USD): $${volumeUSD.toFixed(2)}`);
    console.log("=".repeat(60));

    return {
      success: true,
      walletAddress,
      tokenMint,
      tokenAccount,
      totalSwapTransactions: swaps.length,
      totalVolume,
      volumeUSD,
      tokenPrice,
      swaps,
    };

  } catch (error) {
    console.error("\n[VOLUME TRACKER FAST] Error:", error);
    return {
      success: false,
      walletAddress,
      tokenMint,
      tokenAccount: null,
      totalSwapTransactions: 0,
      totalVolume: 0,
      volumeUSD: 0,
      tokenPrice: null,
      swaps: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
