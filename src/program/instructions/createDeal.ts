import { Program, BN, AnchorProvider } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import IDL from "../IDL.json";
import { BountyExchangeProgram } from "../idl";

// Program ID from IDL
export const PROGRAM_ID = new PublicKey(
  "9c3ZGDTinPuGXxJGaN3QsNRBcDgkkjcsNgXgcoqoGW8D"
);

// Devnet USDC mint
export const USDC_MINT = new PublicKey(
  "GqiwdrC5ybCCmtvG2Yir9CVfsENjYQTHwKB9B2y3mi5f"
);

// Fee wallet - protocol fee collection wallet
export const FEE_WALLET = new PublicKey(
  "9JxBhWbrwkqX2heLq1mA3YXWKsbkCH8rE5gaVxzH7Foo"
);

export interface CreateDealArgs {
  dealId: BN;
  token: PublicKey;
  trader: PublicKey;
  rewardAmount: BN;
  targetVolume: BN;
  expirationWindowInHours: BN;
  holdDurationInHours: BN;
}

/**
 * Creates an Anchor program instance
 */
export function getProgram(connection: Connection): Program<BountyExchangeProgram> {
  // Create a read-only provider (no wallet needed for building instructions)
  const provider = new AnchorProvider(
    connection,
    {} as any, // Dummy wallet - we only need this for building, not signing
    { commitment: "confirmed" }
  );

  return new Program(IDL as BountyExchangeProgram, provider);
}

/**
 * Derives the deal PDA address
 */
export function getDealPDA(payer: PublicKey, dealId: BN, programId: PublicKey = PROGRAM_ID): [PublicKey, number] {
  const dealIdBuffer = dealId.toArrayLike(Buffer, "le", 8);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("deal"), payer.toBuffer(), dealIdBuffer],
    programId
  );
}

/**
 * Derives the escrow vault ATA address using the deal PDA
 */
export function getEscrowVaultATA(deal: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, deal, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

/**
 * Builds the createDeal instruction using Anchor's program.methods
 */
export async function buildCreateDealInstruction(
  connection: Connection,
  payer: PublicKey,
  args: CreateDealArgs,
  usdcMint: PublicKey = USDC_MINT,
  feeWallet: PublicKey = FEE_WALLET
) {
  const program = getProgram(connection);

  // Derive PDAs
  const [dealPDA] = getDealPDA(payer, args.dealId, program.programId);
  const escrowVault = getEscrowVaultATA(dealPDA, usdcMint);

  // Get payer's USDC token account
  const payerTokenAccount = getAssociatedTokenAddressSync(usdcMint, payer);

  // Get fee wallet's USDC token account (ATA)
  const feeWalletTokenAccount = getAssociatedTokenAddressSync(usdcMint, feeWallet);

  // Build the instruction using Anchor's methods API
  const instruction = await program.methods
    .createDeal({
      dealId: args.dealId,
      token: args.token,
      trader: args.trader,
      rewardAmount: args.rewardAmount,
      targetVolume: args.targetVolume,
      expirationWindowInHours: args.expirationWindowInHours,
      holdDurationInHours: args.holdDurationInHours,
    })
    .accountsStrict({
      payer: payer,
      deal: dealPDA,
      escrowVault: escrowVault,
      payerTokenAccount: payerTokenAccount,
      feeWallet: feeWalletTokenAccount,
      usdcMint: usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return {
    instruction,
    dealPDA,
    escrowVault,
    payerTokenAccount,
    feeWalletTokenAccount,
  };
}

/**
 * Logs deal creation details for debugging
 */
export function logDealDetails(
  payer: PublicKey,
  args: CreateDealArgs,
  dealPDA: PublicKey,
  escrowVault: PublicKey
) {
  console.log("=== Create Deal Details ===");
  console.log("Payer:", payer.toBase58());
  console.log("Deal PDA:", dealPDA.toBase58());
  console.log("Escrow Vault:", escrowVault.toBase58());
  console.log("Deal ID:", args.dealId.toString());
  console.log("Token:", args.token.toBase58());
  console.log("Trader:", args.trader.toBase58());
  console.log("Reward Amount:", args.rewardAmount.toString());
  console.log("Target Volume:", args.targetVolume.toString());
  console.log(
    "Expiration Window (hours):",
    args.expirationWindowInHours.toString()
  );
  console.log("Hold Duration (hours):", args.holdDurationInHours.toString());
  console.log("===========================");
}
