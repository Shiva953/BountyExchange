use anchor_lang::prelude::*;

use crate::errors::BountyError;
use crate::instructions::Ixn;
use crate::state::Deal;

#[derive(Accounts)]
pub struct AcceptDeal<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        mut,
        constraint = deal.trader == trader.key() @ BountyError::UnauthorizedTrader,
        constraint = deal.is_active @ BountyError::DealNotActive,
        constraint = !deal.is_accepted @ BountyError::DealAlreadyAccepted,
    )]
    pub deal: Account<'info, Deal>,
}

impl<'info> Ixn<'info> for AcceptDeal<'info> {
    type Args = ();

    fn handler(ctx: Context<Self>, _args: Self::Args) -> Result<()> {
        let deal = &mut ctx.accounts.deal;
        deal.is_accepted = true;

        Ok(())
    }
}
