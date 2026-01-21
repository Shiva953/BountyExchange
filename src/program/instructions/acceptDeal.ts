import { Connection, PublicKey } from "@solana/web3.js";
import { getProgram } from "./createDeal";

export async function buildAcceptDealInstruction(
  connection: Connection,
  trader: PublicKey,
  dealPubkey: PublicKey
) {
  const program = getProgram(connection);

  const instruction = await program.methods
    .acceptDeal()
    .accountsStrict({
      trader: trader,
      deal: dealPubkey,
    })
    .instruction();

  return {
    instruction,
    dealPubkey,
  };
}

export function logAcceptDealDetails(
  trader: PublicKey,
  dealPubkey: PublicKey
) {
  console.log("=== Accept Deal Details ===");
  console.log("Trader:", trader.toBase58());
  console.log("Deal:", dealPubkey.toBase58());
  console.log("===========================");
}
