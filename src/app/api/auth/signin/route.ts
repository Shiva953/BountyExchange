import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

const SIGN_MESSAGE = "Sign in to Bounty Exchange";

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

    // Find or create trader
    // Use findFirst since the Prisma client may not recognize address as unique
    let trader = await prisma.trader.findFirst({
      where: { address: walletAddress },
    });

    if (!trader) {
      try {
        trader = await prisma.trader.create({
          data: {
            address: walletAddress,
            // name and imageUrl are null for new users
          },
        });
        console.log(`Created new trader: ${walletAddress}`);
      } catch (createError: any) {
        // Handle race condition: if trader was created between findFirst and create
        if (createError?.code === "P2002" || createError?.message?.includes("Unique constraint")) {
          // Trader was created by another request, fetch it
          trader = await prisma.trader.findFirst({
            where: { address: walletAddress },
          });
          console.log(`Trader created concurrently, fetched: ${walletAddress}`);
        } else {
          throw createError;
        }
      }
    } else {
      console.log(`Existing trader signed in: ${walletAddress}`);
    }

    return NextResponse.json({
      success: true,
      trader: {
        id: trader.id,
        address: trader.address,
        name: trader.name,
        imageUrl: trader.imageUrl,
      },
    });
  } catch (error) {
    console.error("Auth error:", error);
    return NextResponse.json(
      {
        error: "Authentication failed",
        details: error instanceof Error ? error.message : "Unknown error",
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

    // Use findFirst as fallback if findUnique doesn't work with address
    const trader = await prisma.trader.findFirst({
      where: { address: walletAddress },
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
    return NextResponse.json(
      { error: "Failed to check authentication" },
      { status: 500 }
    );
  }
}
