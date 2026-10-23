export type CardDetails = {
  cardNumber: string; cvc: string; expiryMonth: string; expiryYear: string;
  cardholder: string; billingAddress: string; postalCode: string; country: string; note: string;
};
export type CardRecord = { details: CardDetails; revision: string; updatedAt: string };
export type CardSummary = Record<number, { last4: string; updatedAt: string }>;
export const EMPTY_CARD: CardDetails = { cardNumber: "", cvc: "", expiryMonth: "", expiryYear: "", cardholder: "", billingAddress: "", postalCode: "", country: "", note: "" };
