use anchor_lang::prelude::*;
use anchor_lang::Bumps;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface, TransferChecked, transfer_checked};

use crate::instructions::Ixn;
use crate::state::Deal;
use crate::constants::{FEE_WALLET, USDC_MINT};
use crate::errors::BountyError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateDealArgs {
    pub deal_id: u64,
    pub token: Pubkey,
    pub trader: Pubkey,
    pub reward_amount: u64,
    pub target_volume: u64,
    pub min_buy_volume: Option<u64>,
    pub expiration_window_in_hours: u64,
    pub hold_duration_in_hours: u64,
}

#[derive(Accounts)]
#[instruction(args: CreateDealArgs)]
pub struct CreateDeal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Deal::INIT_SPACE,
        seeds = [b"deal", payer.key().as_ref(), args.deal_id.to_le_bytes().as_ref()],
        bump
    )]
    pub deal: Account<'info, Deal>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = usdc_mint,
        associated_token::authority = deal,
        associated_token::token_program = token_program
    )]
    pub escrow_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = payer_token_account.owner == payer.key() @ BountyError::InvalidTokenAccountOwner
    )]
    pub payer_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = cfg!(feature = "testing") || fee_wallet.owner == FEE_WALLET @ BountyError::InvalidFeeWallet
    )]
    pub fee_wallet: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = cfg!(feature = "testing") || usdc_mint.key() == USDC_MINT @ BountyError::InvalidUsdcMint
    )]
    pub usdc_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> Ixn<'info> for CreateDeal<'info> {
    type Args = CreateDealArgs;

    fn handler(ctx: Context<Self>, args: Self::Args) -> Result<()> {
        require!(args.trader != ctx.accounts.payer.key(), BountyError::SelfTargetedDeal);

        const MIN_REWARD_AMOUNT: u64 = 200_000_000;
        require!(args.reward_amount >= MIN_REWARD_AMOUNT, BountyError::RewardBelowMinimum);

        if let Some(min_buy) = args.min_buy_volume {
            require!(min_buy < args.target_volume, BountyError::MinBuyVolumeExceedsTarget);
        }

        // Duration bounds validation (Helius: Input Validation)
        const MIN_EXPIRATION_HOURS: u64 = 1;
        const MAX_EXPIRATION_HOURS: u64 = 720; // 30 days
        const MIN_HOLD_DURATION_HOURS: u64 = 1;
        const MAX_HOLD_DURATION_HOURS: u64 = 720; // 30 days
        const MAX_TARGET_VOLUME: u64 = 1_000_000_000_000_000; // 1B USDC (with 6 decimals)

        require!(args.expiration_window_in_hours >= MIN_EXPIRATION_HOURS, BountyError::ExpirationTooShort);
        require!(args.expiration_window_in_hours <= MAX_EXPIRATION_HOURS, BountyError::ExpirationTooLong);
        require!(args.hold_duration_in_hours >= MIN_HOLD_DURATION_HOURS, BountyError::HoldDurationTooShort);
        require!(args.hold_duration_in_hours <= MAX_HOLD_DURATION_HOURS, BountyError::HoldDurationTooLong);
        require!(args.target_volume <= MAX_TARGET_VOLUME, BountyError::TargetVolumeTooHigh);

        let deal = &mut ctx.accounts.deal;

        deal.deal_id = args.deal_id;
        deal.creator = ctx.accounts.payer.key();
        deal.token = args.token;
        deal.trader = args.trader; 
        deal.reward_amount = args.reward_amount;
        deal.target_volume = args.target_volume;
        deal.min_buy_volume = args.min_buy_volume;
        deal.expiration_window_in_hours = args.expiration_window_in_hours;
        deal.hold_duration_in_hours = args.hold_duration_in_hours;
        deal.escrow_vault = ctx.accounts.escrow_vault.key();
        deal.bump = ctx.bumps.deal;
        deal.created_at = Clock::get()?.unix_timestamp;
        deal.is_active = true;
        deal.is_accepted = false;
        deal.outcome = None;
        deal.volume_completed_usd = None;


        const PROTOCOL_FEE_BPS: u16 = 1000; // 10% fee = 1000 basis points
        
        let fee_amount = (args.reward_amount as u128)
            .checked_mul(PROTOCOL_FEE_BPS as u128)
            .ok_or(ProgramError::ArithmeticOverflow)?
            .checked_div(10000)
            .ok_or(ProgramError::ArithmeticOverflow)? as u64;


        let fee_transfer_accounts = TransferChecked {
            from: ctx.accounts.payer_token_account.to_account_info(),
            mint: ctx.accounts.usdc_mint.to_account_info(),
            to: ctx.accounts.fee_wallet.to_account_info(),
            authority: ctx.accounts.payer.to_account_info(),
        };

        let fee_cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            fee_transfer_accounts,
        );

        transfer_checked(fee_cpi_ctx, fee_amount, ctx.accounts.usdc_mint.decimals)?;

        // USDC Transfer from USER -> escrow vault (released upon deal completion to the trader)
        let escrow_transfer_accounts = TransferChecked {
            from: ctx.accounts.payer_token_account.to_account_info(),
            mint: ctx.accounts.usdc_mint.to_account_info(),
            to: ctx.accounts.escrow_vault.to_account_info(),
            authority: ctx.accounts.payer.to_account_info(),
        };

        let escrow_cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            escrow_transfer_accounts,
        );

        transfer_checked(escrow_cpi_ctx, args.reward_amount, ctx.accounts.usdc_mint.decimals)?;

        Ok(())
    }
}