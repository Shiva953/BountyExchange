import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

const SIGN_MESSAGE = "Sign in to Bounty Exchange";

// Helper function to check if error is a database connection error
function isDbConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  return (
    message.includes("Can't reach database server") ||
    message.includes("P1001") ||
    message.includes("connection") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ETIMEDOUT") ||
    message.includes("pool")
  );
}

// Retry function with exponential backoff
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 5,
  initialDelay: number = 500
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Only retry on database connection errors
      if (!isDbConnectionError(error)) {
        throw error;
      }

      // Don't retry on last attempt
      if (attempt === maxRetries) {
        break;
      }

      // Calculate delay with exponential backoff: 500ms, 1000ms, 2000ms, 4000ms, 8000ms
      const delay = initialDelay * Math.pow(2, attempt);
      console.log(
        `Database connection error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

export async function POST(request: NextRequest) {
  try {
    const { walletAddress, signature } = await request.json();

    if (!walletAddress || !signature) {
      return NextResponse.json(
        { error: "Missing walletAddress or signature" },
        { status: 400 }
      );
    }

    // Verify the signature using Solana's standard message format
    // Solana wallets prepend a prefix to messages when signing
    const message = new TextEncoder().encode(SIGN_MESSAGE);
    const signatureBytes = bs58.decode(signature);
    
    // Create PublicKey instance to get the proper public key bytes
    let publicKey: PublicKey;
    try {
      publicKey = new PublicKey(walletAddress);
    } catch (error) {
      console.error("Invalid public key format:", error);
      return NextResponse.json(
        { error: "Invalid wallet address format" },
        { status: 400 }
      );
    }

    const publicKeyBytes = publicKey.toBytes();

    // Verify the signature
    // The wallet adapter signs the message bytes directly
    // However, some wallets may add a Solana message prefix
    // Try direct verification first (most common case)
    let isValid = nacl.sign.detached.verify(
      message,
      signatureBytes,
      publicKeyBytes
    );

    // If direct verification fails, try with Solana standard message prefix
    // Format: "Solana Signed Message:\n" + u8 array length + message
    if (!isValid) {
      const prefix = new TextEncoder().encode("Solana Signed Message:\n");
      // Encode message length as u8 array (little-endian)
      const lengthBytes = new Uint8Array(4);
      new DataView(lengthBytes.buffer).setUint32(0, message.length, true);
      const prefixedMessage = new Uint8Array(
        prefix.length + lengthBytes.length + message.length
      );
      prefixedMessage.set(prefix, 0);
      prefixedMessage.set(lengthBytes, prefix.length);
      prefixedMessage.set(message, prefix.length + lengthBytes.length);

      isValid = nacl.sign.detached.verify(
        prefixedMessage,
        signatureBytes,
        publicKeyBytes
      );
    }

    if (!isValid) {
      console.error("Signature verification failed", {
        walletAddress,
        messageLength: message.length,
        signatureLength: signatureBytes.length,
        publicKeyLength: publicKeyBytes.length,
      });
      return NextResponse.json(
        { error: "Invalid signature. Please try signing again." },
        { status: 401 }
      );
    }

    // Find or create trader with retry logic for DB connection issues
    // Use retryWithBackoff to handle pool/connection errors gracefully
    const trader = await retryWithBackoff(async () => {
      // First, try to find existing trader by address
      const existingTrader = await prisma.trader.findFirst({
        where: { address: walletAddress },
      });

      if (existingTrader) {
        console.log(`Existing trader signed in: ${walletAddress} (name: ${existingTrader.name})`);
        return existingTrader;
      }

      // Trader doesn't exist, create new one
      try {
        const newTrader = await prisma.trader.create({
          data: {
            address: walletAddress,
            // name and imageUrl are null for new users
          },
        });
        console.log(`Created new trader: ${walletAddress}`);
        return newTrader;
      } catch (createError: any) {
        // Handle race condition: if trader was created between findFirst and create
        if (
          createError?.code === "P2002" ||
          createError?.message?.includes("Unique constraint")
        ) {
          // Trader was created by another request, fetch it
          const concurrentTrader = await prisma.trader.findFirst({
            where: { address: walletAddress },
          });
          console.log(`Trader created concurrently, fetched: ${walletAddress}`);
          return concurrentTrader;
        }
        throw createError;
      }
    });

    return NextResponse.json({
      success: true,
      trader: {
        id: trader?.id,
        address: trader?.address,
        name: trader?.name,
        imageUrl: trader?.imageUrl,
      },
    });
  } catch (error) {
    console.error("Auth error:", error);

    // If it's a database connection error, indicate it's retryable
    if (isDbConnectionError(error)) {
      return NextResponse.json(
        {
          error: "Database connection failed",
          details: "Unable to reach database server after multiple retries",
          retryable: true,
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        error: "Authentication failed",
        details: error instanceof Error ? error.message : "Unknown error",
        retryable: false,
      },
      { status: 500 }
    );
  }
}

// GET endpoint to check if a wallet exists and get its data
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const walletAddress = searchParams.get("address");

    if (!walletAddress) {
      return NextResponse.json(
        { error: "Missing address parameter" },
        { status: 400 }
      );
    }

    // Use findFirst with retry logic for DB connection issues
    const trader = await retryWithBackoff(async () => {
      return await prisma.trader.findFirst({
        where: { address: walletAddress },
      });
    });

    if (!trader) {
      return NextResponse.json({ exists: false, trader: null });
    }

    return NextResponse.json({
      exists: true,
      trader: {
        id: trader.id,
        address: trader.address,
        name: trader.name,
        imageUrl: trader.imageUrl,
      },
    });
  } catch (error) {
    console.error("Auth check error:", error);

    // If it's a database connection error, indicate it's retryable
    if (isDbConnectionError(error)) {
      return NextResponse.json(
        {
          error: "Database connection failed",
          details: "Unable to reach database server after multiple retries",
          retryable: true,
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        error: "Failed to check authentication",
        retryable: false,
      },
      { status: 500 }
    );
  }
}
