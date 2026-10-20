/** Shared gifting API contract. Every delivered gift grants permanent Supporter. */
export type GiftTarget =
  | { mode: "direct"; recipientId: string }
  | { mode: "lobby"; roomId: string }
  | {
      mode: "random";
      /** "public" is the global account pool, including offline players (legacy wire name). */
      scope: "lobby" | "public";
      roomId?: string;
      count: number;
    };
export interface GiftWallet {
  /** Available credits. Refund debt is retained in spentCredits and paid off before new gifts. */
  credits: number;
  earnedCredits: number;
  spentCredits: number;
  donationCents: number;
  giftsSent: number;
  tier: number;
  nextTier: number | null;
  /** Own-account guest aliases, for recovering pending deliveries after account linking. */
  mergedUserIds?: string[];
}
export interface GiftPreview {
  cost: number;
  eligibleCount: number;
  linkedCount: number;
  guestCount: number;
  credits: number;
  canDeliver: boolean;
}
export interface GiftDelivery {
  requestId: string;
  delivered: { id: string; name: string }[];
  cost: number;
  wallet: GiftWallet;
  replayed: boolean;
}
export const GIFT_TIERS = [1, 5, 25, 100] as const;
export const GIFT_CENTS = 500;
export const GIFT_MAX_RECIPIENTS = 64;
export const giftTier = (sent: number): number =>
  [...GIFT_TIERS].reverse().find((n) => sent >= n) ?? 0;
