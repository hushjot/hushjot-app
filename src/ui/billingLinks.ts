/**
 * Where money lives. The app never loads a payment script: the vault origin
 * runs only our code (docs/security.md), so buying and managing a plan
 * happens on hushjot.com and these are the only two doors to it.
 */

/** Sign in, see the plan, buy one. */
export const ACCOUNT_URL = 'https://hushjot.com/account';

/** The account page's storage panel, where the "+10 GB" add-on is set. */
export const STORAGE_URL = `${ACCOUNT_URL}#storage`;

/**
 * Paddle's hosted customer portal: cancel, change the card, download
 * invoices. Its login is a magic link sent to the account's email.
 *
 * TODO(billing): replace with the portal login URL from Paddle → Checkout →
 * Customer portal once the HushJot domain is approved; until then the
 * account page carries the same link.
 */
export const PADDLE_PORTAL_URL = 'https://customer-portal.paddle.com/cpl_01k4qf1f10pmbjd81h3jb5msr7';

/** How to have everything deleted, including the account itself. */
export const DELETE_ACCOUNT_URL = 'https://hushjot.com/support#delete';
