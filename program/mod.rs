use anchor_lang::prelude::*;
use anchor_lang::Bumps;

pub mod accept_deal;
pub mod cancel_expired_deal;
pub mod create_deal;
pub mod finalize_deal;
pub mod withdraw_from_escrow;

pub use accept_deal::*;
pub use cancel_expired_deal::*;
pub use create_deal::*;
pub use finalize_deal::*;
pub use withdraw_from_escrow::*;

pub trait Ixn<'info> {
    type Args;
    fn handler(ctx: Context<Self>, args: Self::Args) -> Result<()>
    where
        Self: Sized + Bumps;
}
