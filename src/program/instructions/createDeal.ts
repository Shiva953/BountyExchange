import { Program, BN, AnchorProvider } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import IDL from "../IDL.json";
import { BountyExchangeProgram } from "../idl";

export const PROGRAM_ID = new PublicKey(
  "9c3ZGDTinPuGXxJGaN3QsNRBcDgkkjcsNgXgcoqoGW8D"
);

export const USDC_MINT = new PublicKey(
  "GqiwdrC5ybCCmtvG2Yir9CVfsENjYQTHwKB9B2y3mi5f"
);

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

export function getProgram(connection: Connection): Program<BountyExchangeProgram> {
  const provider = new AnchorProvider(
    connection,
    {} as any,
    { commitment: "confirmed" }
  );

  return new Program(IDL as BountyExchangeProgram, provider);
}

export function getDealPDA(payer: PublicKey, dealId: BN, programId: PublicKey = PROGRAM_ID): [PublicKey, number] {
  const dealIdBuffer = dealId.toArrayLike(Buffer, "le", 8);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("deal"), payer.toBuffer(), dealIdBuffer],
    programId
  );
}

export function getEscrowVaultATA(deal: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, deal, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

export async function buildCreateDealInstruction(
  connection: Connection,
  payer: PublicKey,
  args: CreateDealArgs,
  usdcMint: PublicKey = USDC_MINT,
  feeWallet: PublicKey = FEE_WALLET
) {
  const program = getProgram(connection);

  const [dealPDA] = getDealPDA(payer, args.dealId, program.programId);
  const escrowVault = getEscrowVaultATA(dealPDA, usdcMint);
  const payerTokenAccount = getAssociatedTokenAddressSync(usdcMint, payer);
  const feeWalletTokenAccount = getAssociatedTokenAddressSync(usdcMint, feeWallet);

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
