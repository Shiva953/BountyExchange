use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    close_account, transfer_checked, CloseAccount, Mint, TokenAccount, TokenInterface,
    TransferChecked,
};

use crate::constants::{CRANK_AUTHORITY, USDC_MINT};
use crate::errors::BountyError;
use crate::instructions::Ixn;
use crate::state::Deal;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FinalizeDealArgs {
    pub volume_at_end_time: u64,
    pub hold_duration_at_end_time: u64,
}

#[derive(Accounts)]
pub struct FinalizeDeal<'info> {
    /// Only the authorized crank keypair can call this instruction.
    #[account(
        mut,
        constraint = payer.key() == CRANK_AUTHORITY @ BountyError::UnauthorizedCrank
    )]
    pub payer: Signer<'info>,

    /// CHECK: The trader who will receive the reward if they pass - validated against deal.trader
    #[account(mut)]
    pub trader: UncheckedAccount<'info>,

    /// CHECK: The deal creator who will receive funds back if trader fails - validated against deal.creator
    #[account(mut)]
    pub creator: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"deal", creator.key().as_ref(), deal.deal_id.to_le_bytes().as_ref()],
        bump = deal.bump,
        constraint = deal.trader == trader.key() @ BountyError::UnauthorizedTrader,
        constraint = deal.is_active @ BountyError::DealNotActive,
        constraint = deal.is_accepted @ BountyError::DealNotAccepted,
        constraint = deal.creator == creator.key() @ BountyError::InvalidCreator,
        constraint = trader.key() != creator.key() @ BountyError::DuplicateAccounts,
    )]
    pub deal: Account<'info, Deal>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = deal,
        associated_token::token_program = token_program,
        constraint = escrow_vault.key() == deal.escrow_vault @ BountyError::InvalidEscrowVault,
    )]
    pub escrow_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = usdc_mint,
        associated_token::authority = trader,
        associated_token::token_program = token_program,
    )]
    pub trader_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = usdc_mint,
        associated_token::authority = creator,
        associated_token::token_program = token_program,
    )]
    pub creator_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = cfg!(feature = "testing") || usdc_mint.key() == USDC_MINT @ BountyError::InvalidUsdcMint
    )]
    pub usdc_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> Ixn<'info> for FinalizeDeal<'info> {
    type Args = FinalizeDealArgs;

    fn handler(ctx: Context<Self>, args: Self::Args) -> Result<()> {
        let deal = &ctx.accounts.deal;

        let outcome = args.volume_at_end_time >= deal.target_volume
            && args.hold_duration_at_end_time >= deal.hold_duration_in_hours;

        let creator_key = ctx.accounts.creator.key();
        let deal_id_bytes = deal.deal_id.to_le_bytes();
        let bump = deal.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"deal",
            creator_key.as_ref(),
            deal_id_bytes.as_ref(),
            &[bump],
        ]];

        // if pass, escrow->trader, if fail, escrow->creator
        let destination = if outcome {
            ctx.accounts.trader_token_account.to_account_info()
        } else {
            ctx.accounts.creator_token_account.to_account_info()
        };

        let transfer_accounts = TransferChecked {
            from: ctx.accounts.escrow_vault.to_account_info(),
            mint: ctx.accounts.usdc_mint.to_account_info(),
            to: destination,
            authority: ctx.accounts.deal.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_accounts,
            signer_seeds,
        );

        transfer_checked(
            cpi_ctx,
            ctx.accounts.escrow_vault.amount,
            ctx.accounts.usdc_mint.decimals,
        )?;

        let rent_destination = if outcome {
            ctx.accounts.trader.to_account_info()
        } else {
            ctx.accounts.creator.to_account_info()
        };

        let close_accounts = CloseAccount {
            account: ctx.accounts.escrow_vault.to_account_info(),
            destination: rent_destination,
            authority: ctx.accounts.deal.to_account_info(),
        };

        let close_cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            close_accounts,
            signer_seeds,
        );

        close_account(close_cpi_ctx)?;

        let deal = &mut ctx.accounts.deal;
        deal.is_active = false;
        deal.outcome = Some(outcome);
        deal.volume_completed_usd = Some(args.volume_at_end_time);

        Ok(())
    }
}
