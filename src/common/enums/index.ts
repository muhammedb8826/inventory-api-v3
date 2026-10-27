export enum LocationType {
  WAREHOUSE = 'WAREHOUSE',
  SHOWROOM = 'SHOWROOM',
  /** Storage bin under a parent warehouse/showroom. */
  BIN = 'BIN',
}

export enum StocktakeStatus {
  DRAFT = 'DRAFT',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export enum PaymentMethod {
  CASH = 'CASH',
  BANK = 'BANK',
  CREDIT = 'CREDIT',
}

/** Ledger account: physical cash till vs real bank account. */
export enum BankAccountType {
  CASH = 'CASH',
  BANK = 'BANK',
}

export enum BankTransactionType {
  SALE = 'SALE',
  PURCHASE = 'PURCHASE',
  EXPENSE = 'EXPENSE',
  CREDIT_PAYMENT = 'CREDIT_PAYMENT',
  CREDIT_RECEIPT = 'CREDIT_RECEIPT',
  ADJUSTMENT = 'ADJUSTMENT',
  OPENING = 'OPENING',
}

/** Money movement relative to the bank/cash account. */
export enum BankTransactionDirection {
  IN = 'in',
  OUT = 'out',
}

export enum CreditType {
  CUSTOMER = 'CUSTOMER',
  SUPPLIER = 'SUPPLIER',
}

/** How a credit balance was created. OPENING is cutover AR/AP with no sale/purchase. */
export enum CreditSource {
  SALE = 'SALE',
  PURCHASE = 'PURCHASE',
  OPENING = 'OPENING',
}

export enum CreditStatus {
  OPEN = 'OPEN',
  PARTIAL = 'PARTIAL',
  PAID = 'PAID',
}

export enum TransferStatus {
  PENDING = 'PENDING',
  /** Left source; not yet received at destination. */
  IN_TRANSIT = 'IN_TRANSIT',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export enum DocumentStatus {
  ACTIVE = 'ACTIVE',
  VOIDED = 'VOIDED',
}

/** Whether commission is calculated on sale profit or gross subtotal. */
export enum CommissionBasis {
  PROFIT = 'PROFIT',
  SALES = 'SALES',
}

export const DEFAULT_COMMISSION_PERCENT = 10;

/** Inventory stock adjustment reasons (manual qty changes with audit). */
export enum StockAdjustmentReason {
  DAMAGE = 'DAMAGE',
  LOSS = 'LOSS',
  FOUND = 'FOUND',
  COUNT = 'COUNT',
  OPENING = 'OPENING',
  RETURN = 'RETURN',
  OTHER = 'OTHER',
}

/** Stock quantity movement for adjustments. */
export enum StockAdjustmentDirection {
  IN = 'in',
  OUT = 'out',
}

/** Immutable stock ledger movement kinds (all qty changes). */
export enum StockMovementType {
  SALE = 'SALE',
  SALE_VOID = 'SALE_VOID',
  SALE_REVERSAL = 'SALE_REVERSAL',
  SALE_RETURN = 'SALE_RETURN',
  PURCHASE = 'PURCHASE',
  PURCHASE_VOID = 'PURCHASE_VOID',
  PURCHASE_REVERSAL = 'PURCHASE_REVERSAL',
  TRANSFER_OUT = 'TRANSFER_OUT',
  TRANSFER_IN = 'TRANSFER_IN',
  ADJUSTMENT = 'ADJUSTMENT',
  PRODUCTION_ISSUE = 'PRODUCTION_ISSUE',
  PRODUCTION_RECEIPT = 'PRODUCTION_RECEIPT',
  PRODUCTION_REVERSE = 'PRODUCTION_REVERSE',
  OPENING = 'OPENING',
  IMPORT = 'IMPORT',
  STOCKTAKE = 'STOCKTAKE',
}

/** Catalog classification for manufacturing / BOM. */
export enum ItemType {
  RAW = 'RAW',
  SEMI = 'SEMI',
  FINISHED = 'FINISHED',
  OTHER = 'OTHER',
}

export enum ProductionOrderStatus {
  DRAFT = 'DRAFT',
  RELEASED = 'RELEASED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

/** In-app notification categories (matches permission modules where applicable). */
export enum NotificationType {
  LOW_STOCK = 'LOW_STOCK',
  STOCK_TRANSFER = 'STOCK_TRANSFER',
  SALE = 'SALE',
  PURCHASE = 'PURCHASE',
  CREDIT_DUE = 'CREDIT_DUE',
  EXPENSE = 'EXPENSE',
  SYSTEM = 'SYSTEM',
  INQUIRY = 'INQUIRY',
}

/** How a customer inquiry entered the system. */
export enum InquirySource {
  PUBLIC = 'PUBLIC',
  INTERNAL = 'INTERNAL',
}

export enum InquiryStatus {
  NEW = 'NEW',
  IN_PROGRESS = 'IN_PROGRESS',
  QUOTED = 'QUOTED',
  CONVERTED = 'CONVERTED',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
}

export enum InquiryPriority {
  LOW = 'LOW',
  NORMAL = 'NORMAL',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

/**
 * CRM-style ownership of an inquiry assignment.
 * Assign → PENDING (assignee must Accept or Decline).
 * Self-assign / Claim → ACCEPTED immediately.
 */
export enum InquiryAssignmentStatus {
  UNASSIGNED = 'UNASSIGNED',
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
}
