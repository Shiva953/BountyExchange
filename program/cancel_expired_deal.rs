use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    close_account, transfer_checked, CloseAccount, Mint, TokenAccount, TokenInterface,
    TransferChecked,
};

use crate::constants::USDC_MINT;
use crate::errors::BountyError;
use crate::instructions::Ixn;
use crate::state::Deal;

#[derive(Accounts)]
pub struct CancelExpiredDeal<'info> {
    /// Permissionless — anyone can pay gas to trigger this.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: The deal creator who receives the refund - validated against deal.creator
    #[account(mut)]
    pub creator: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"deal", creator.key().as_ref(), deal.deal_id.to_le_bytes().as_ref()],
        bump = deal.bump,
        constraint = deal.creator == creator.key() @ BountyError::InvalidCreator,
        constraint = deal.is_active @ BountyError::DealNotActive,
        constraint = !deal.is_accepted @ BountyError::DealAlreadyAccepted,
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

impl<'info> Ixn<'info> for CancelExpiredDeal<'info> {
    type Args = ();

    fn handler(ctx: Context<Self>, _args: Self::Args) -> Result<()> {
        let deal = &ctx.accounts.deal;

        let current_time = Clock::get()?.unix_timestamp;
        let expiration_seconds = (deal.expiration_window_in_hours as i64)
            .checked_mul(3600)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let expiration_time = deal.created_at
            .checked_add(expiration_seconds)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        require!(current_time >= expiration_time, BountyError::DealNotExpired);

        let creator_key = ctx.accounts.creator.key();
        let deal_id_bytes = deal.deal_id.to_le_bytes();
        let bump = deal.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"deal",
            creator_key.as_ref(),
            deal_id_bytes.as_ref(),
            &[bump],
        ]];

        let transfer_accounts = TransferChecked {
            from: ctx.accounts.escrow_vault.to_account_info(),
            mint: ctx.accounts.usdc_mint.to_account_info(),
            to: ctx.accounts.creator_token_account.to_account_info(),
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

        let close_accounts = CloseAccount {
            account: ctx.accounts.escrow_vault.to_account_info(),
            destination: ctx.accounts.creator.to_account_info(),
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

        Ok(())
    }
}
