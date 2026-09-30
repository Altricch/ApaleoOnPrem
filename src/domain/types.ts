import type { LocalizedText } from '../core/localized';
import type { AmountModel, MonetaryValue, VatType } from '../core/money';
import type { BusinessDate, Instant } from '../core/dates';

/**
 * The entities the clone persists. These are storage shapes, close to but not
 * identical to the wire models: text is kept as a language dictionary and
 * embedded references are stored as plain ids, then resolved when a response
 * is assembled.
 */

/* --------------------------------------------------------------- account */

export type AccountType = 'Trial' | 'Live' | 'Suspended' | 'Development';

export interface Account {
  id: string;
  code: string;
  name: string;
  description?: string;
  defaultLanguage?: string;
  logoUrl?: string;
  location?: Address;
  type?: AccountType;
  additionallySupportedCountries?: string[];
  created: Instant;
  subscriptionPlan: string;
}

export interface User {
  id: string;
  subjectId: string;
  email: string;
  firstName: string;
  lastName: string;
  roles: string[];
}

/* ------------------------------------------------------------- inventory */

export type PropertyStatus = 'Test' | 'Live';

export interface Address {
  addressLine1: string;
  addressLine2?: string;
  postalCode: string;
  city: string;
  regionCode?: string;
  countryCode: string;
}

export interface BankAccount {
  iban?: string;
  bic?: string;
  bank?: string;
}

export interface Property {
  id: string;
  code: string;
  propertyTemplateId?: string;
  isTemplate: boolean;
  name: LocalizedText;
  description: LocalizedText;
  companyName: string;
  managingDirectors?: string;
  commercialRegisterEntry: string;
  taxId: string;
  location: Address;
  bankAccount?: BankAccount;
  paymentTerms: LocalizedText;
  timeZone: string;
  currencyCode: string;
  created: Instant;
  status: PropertyStatus;
  isArchived: boolean;
  defaultCheckInTime: string;
  defaultCheckOutTime: string;
  /** The date the property is currently operating on; advanced by night audit. */
  businessDate: BusinessDate;
}

export type UnitGroupType = 'BedRoom' | 'MeetingRoom' | 'EventSpace' | 'ParkingLot' | 'Other';

export interface UnitGroup {
  id: string;
  code: string;
  propertyId: string;
  name: LocalizedText;
  description: LocalizedText;
  maxPersons: number;
  rank?: number;
  type: UnitGroupType;
  connectedUnitGroups: { unitGroupId: string; memberCount: number }[];
}

export type UnitCondition = 'Clean' | 'CleanToBeInspected' | 'Dirty';

export interface Unit {
  id: string;
  propertyId: string;
  unitGroupId?: string;
  name: string;
  description: LocalizedText;
  maxPersons: number;
  condition: UnitCondition;
  attributes: string[];
  connectedUnitIds: string[];
  created: Instant;
  archived?: Instant;
  isArchived: boolean;
}

export interface UnitAttributeDefinition {
  id: string;
  name: string;
  description?: string;
}

/* ------------------------------------------------------------- rate plans */

export interface AgeCategory {
  id: string;
  propertyId: string;
  code: string;
  name: LocalizedText;
  minAge: number;
  maxAge: number;
  rank?: number;
}

export type TimeSliceTemplate = 'OverNight' | 'DayUse';

export interface TimeSliceDefinition {
  id: string;
  propertyId: string;
  name: LocalizedText;
  template: TimeSliceTemplate;
  checkInTime: string;
  checkOutTime: string;
}

export type PricingRuleType = 'Absolute' | 'Percent';
export type PriceCalculationMode = 'Truncate' | 'Round';

/** An ISO-ish period, as apaleo's `PeriodModel`. */
export interface Period {
  hours?: number;
  days?: number;
  months?: number;
}

export interface BookingRestrictions {
  minAdvance?: Period;
  maxAdvance?: Period;
  /** Time of day after which same-day bookings are refused. */
  lateBookingUntil?: string;
}

/** Restrictions attached to an individual nightly rate. */
export interface RateRestrictions {
  minLengthOfStay?: number;
  maxLengthOfStay?: number;
  closed: boolean;
  closedOnArrival: boolean;
  closedOnDeparture: boolean;
}

export const openRestrictions = (): RateRestrictions => ({
  closed: false,
  closedOnArrival: false,
  closedOnDeparture: false,
});

/** VAT and ledger routing for a rate plan or service, valid from a date. */
export interface AccountingConfig {
  vatType: VatType;
  serviceType: ServiceType;
  subAccountId?: string;
  validFrom: BusinessDate;
}

export type ServicePricingMode = 'Included' | 'Additional';

export interface RatePlanService {
  serviceId: string;
  grossPrice: number;
  pricingMode: ServicePricingMode;
}

/** Surcharge for a given total adult count. */
export interface Surcharge {
  adults: number;
  type: PricingRuleType;
  value: number;
}

/** Per-age-category surcharge, keyed by the accompanying adult count. */
export interface AgeCategorySurcharge {
  adults: number;
  value: number;
}

export interface RatePlanAgeCategory {
  ageCategoryId: string;
  surcharges: AgeCategorySurcharge[];
}

export interface RatePlan {
  id: string;
  code: string;
  propertyId: string;
  unitGroupId: string;
  name: LocalizedText;
  description: LocalizedText;
  minGuaranteeType: GuaranteeType;
  priceCalculationMode: PriceCalculationMode;
  timeSliceDefinitionId: string;
  cancellationPolicyId?: string;
  noShowPolicyId?: string;
  channelCodes: ChannelCode[];
  promoCodes: string[];
  restrictions?: BookingRestrictions;
  bookingPeriods: { from: Instant; to: Instant }[];
  includedServices: RatePlanService[];
  /** Companies allowed to book, with the corporate code for each pairing. */
  companies: { companyId: string; corporateCode: string }[];
  ageCategories: RatePlanAgeCategory[];
  surcharges: Surcharge[];
  accountingConfigs: AccountingConfig[];
  isSubjectToCityTax: boolean;
  /** Derived plans take their price from a base plan plus a rule. */
  isDerived: boolean;
  derivationLevel: number;
  pricingRule?: { baseRatePlanId: string; type: PricingRuleType; value: number };
  marketSegmentId?: string;
  isArchived: boolean;
  created: Instant;
  updated: Instant;
}

/** A nightly price for one rate plan on one date. */
export interface Rate {
  id: string;
  ratePlanId: string;
  propertyId: string;
  date: BusinessDate;
  price: number;
  currency: string;
  restrictions: RateRestrictions;
}

export type PolicyReference = 'PriorToArrival' | 'AfterBooking';

/** A percentage penalty: percent of the stay, optionally capped in nights. */
export interface PercentValue {
  percent: number;
  /** Limit the base to the first N time slices. */
  limit?: number;
  /** Services whose charges count toward the base. */
  includeServiceIds: string[];
}

export interface FeeDetails {
  vatType: VatType;
  fixedValue?: MonetaryValue;
  percentValue?: PercentValue;
}

export interface CancellationPolicy {
  id: string;
  propertyId: string;
  code: string;
  name: LocalizedText;
  description: LocalizedText;
  /** How long before the reference point the policy becomes binding. */
  periodFromReference: Period;
  reference: PolicyReference;
  fee: FeeDetails;
}

export interface NoShowPolicy {
  id: string;
  propertyId: string;
  code: string;
  name: LocalizedText;
  description: LocalizedText;
  fee: FeeDetails;
}

export interface CapturePolicy {
  id: string;
  propertyId: string;
  code: string;
  captureNoShowFee: boolean;
  captureCancellationFee: boolean;
  capturePrepayment: boolean;
  postOtaBankTransferOnCheckOut: boolean;
  capturePayment: 'Manual' | 'CheckIn' | 'CheckOut';
}

export type ServicePricingUnit = 'Person' | 'Room';
export type ServiceAvailabilityMode = 'Arrival' | 'Departure' | 'Daily';

export interface ServiceAvailabilityConfig {
  mode: ServiceAvailabilityMode;
  /** Optional cap on how many can be sold per date. */
  quantity?: number;
  daysOfWeek?: string[];
}

export interface Service {
  id: string;
  code: string;
  propertyId: string;
  name: LocalizedText;
  description: LocalizedText;
  defaultGrossPrice: number;
  currency: string;
  pricingUnit: ServicePricingUnit;
  postNextDay: boolean;
  availability: ServiceAvailabilityConfig;
  channelCodes: ChannelCode[];
  accountingConfigs: AccountingConfig[];
  ageCategoryId?: string;
}

export type ServiceType =
  | 'Other' | 'Accommodation' | 'FoodAndBeverages' | 'CancellationFees' | 'NoShow'
  | 'CityTax' | 'SecondCityTax' | 'LocalTax' | 'ConsumptionTax';

export interface Company {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  invoicingEmail?: string;
  phone?: string;
  taxId?: string;
  additionalTaxId?: string;
  additionalTaxId2?: string;
  invoiceNetworkIdentity?: { networkId?: string; participantId?: string };
  address: Address;
  /** May settle on accounts receivable rather than paying at departure. */
  canCheckOutOnAr: boolean;
  ratePlans: { ratePlanId: string; corporateCode: string }[];
}

/* --------------------------------------------------------------- settings */

export type CityTaxType =
  | 'PercentOfGross'
  | 'PercentOfNet'
  | 'PerRoomPerNight'
  | 'PerPersonPerNight'
  | 'PerPersonPerNightBasedOnNetPrice'
  | 'PerPersonPerNightBasedOnGrossPrice';

/** Whether the configured value is a pre-VAT or post-VAT figure. */
export type TaxHandlingType = 'BeforeTax' | 'AfterTax';

/** A reduced fixed rate for an age band, e.g. children pay less. */
export interface CityTaxSubcategory {
  name: LocalizedText;
  value: number;
  age: { min: number; max: number };
}

/** A fixed tax amount for room prices up to a threshold. */
export interface CityTaxPricingRule {
  value: number;
  maxPrice: number;
}

export interface DistributionChannelTaxConfig {
  channelCode: string;
  sources?: string[];
  remittanceResponsibility?: 'Hotel' | 'Ota';
}

export interface CityTax {
  id: string;
  propertyId: string;
  code: string;
  name: LocalizedText;
  description: LocalizedText;
  type: CityTaxType;
  taxHandlingType: TaxHandlingType;
  value: number;
  /** Cap the tax to the first N nights of a stay. */
  limit?: number;
  subcategories: CityTaxSubcategory[];
  pricingRules: CityTaxPricingRule[];
  vatType: VatType;
  /** Lower numbers are applied first; later taxes can build on earlier ones. */
  priority: number;
  includeCityTaxInRateAmount: boolean;
  /** Channels and sources this tax is not charged for. */
  ignoredFor: { distributionChannel?: DistributionChannelTaxConfig }[];
}

export interface MarketSegment {
  id: string;
  code: string;
  name: string;
  description?: string;
  /** Market segments are account-wide and opted into per property. */
  propertyIds: string[];
}

export type FinanceAccountType =
  | 'Revenues' | 'Payments' | 'Liabilities' | 'Receivables' | 'Vat' | 'House'
  | 'AccountsReceivable' | 'CityTaxes' | 'TransitoryItems' | 'VatOnLiabilities'
  | 'LossOfAccountsReceivable' | 'SecondCityTax' | 'GuestLevies';

export type AccountScope = 'Global' | 'Guest' | 'External' | 'Booking';

/** A node in the property's chart of accounts. */
export interface FinanceAccount {
  id: string;
  propertyId: string;
  number: string;
  name: LocalizedText;
  type: FinanceAccountType;
  parentNumber?: string;
  scope: AccountScope;
  /** Reservation id for guest accounts, folio id for external accounts. */
  reference?: string;
  isArchived: boolean;
}

export type AccountingCommand =
  | 'PostCharge' | 'PostPayment' | 'MoveLineItem' | 'PostPrepayment'
  | 'PostToAccountsReceivables' | 'PostPrepaymentVat'
  | 'PostToLossOfAccountsReceivables' | 'System';

/** One double-entry line: money moves from the debited to the credited account. */
export interface AccountingTransaction {
  id: string;
  propertyId: string;
  timestamp: Instant;
  date: BusinessDate;
  debitedAccount: string;
  creditedAccount: string;
  command: AccountingCommand;
  amount: MonetaryValue;
  receipt?: string;
  entryNumber: string;
  /** Transactions posted together share a group number. */
  entryGroupNumber: string;
  reference: string;
  referenceType: 'House' | 'Guest' | 'External' | 'Booking';
}

/** Custom revenue sub-accounts, on top of the built-in chart of accounts. */
export interface SubAccount {
  id: string;
  propertyId: string;
  number: string;
  code: string;
  name: string;
  type: 'Other' | 'Accommodation' | 'FoodAndBeverages';
  isCustom: boolean;
}

export interface InvoiceAddress {
  propertyId: string;
  id: string;
  addressLine1: string;
  addressLine2?: string;
  postalCode: string;
  city: string;
  regionCode?: string;
  countryCode: string;
}

/** Account-wide language configuration. */
export interface LanguageSetting {
  code: string;
  default: boolean;
  mandatory: boolean;
}

export interface FeatureSettings {
  id: string;
  propertyId: string;
  areCustomRevenueSubAccountsEnabled: boolean;
  performAccountingForOpenInvoiceActions: boolean;
  showRecipientForEachLineItemOnTheInvoice: boolean;
  maxAmountForMinimalInvoices?: number;
  invoiceNumberPattern: string;
  advanceInvoiceNumberPattern: string;
}

export interface PropertySettings {
  id: string;
  propertyId: string;
  /** Per-unit-group overbooking defaults, used when no dated override exists. */
  overbookingByUnitGroup: Record<string, number>;
  globalOverbooking: number;
  languages: string[];
  defaultLanguage: string;
}

/** Per-date overbooking allowance, at house or unit-group level. */
export interface Overbooking {
  id: string;
  propertyId: string;
  /** Absent means the house-wide limit. */
  unitGroupId?: string;
  date: BusinessDate;
  unitGroupType?: UnitGroupType;
  limit: number;
}

/* ---------------------------------------------------------------- booking */

export type ReservationStatus = 'Confirmed' | 'InHouse' | 'CheckedOut' | 'Canceled' | 'NoShow';
export type GuaranteeType = 'PM6Hold' | 'CreditCard' | 'Prepayment' | 'Company' | 'Ota';
export type TravelPurpose = 'Business' | 'Leisure';
export type ChannelCode =
  | 'Direct' | 'BookingCom' | 'Ibe' | 'ChannelManager' | 'Expedia' | 'Homelike'
  | 'Hrs' | 'AltoVita' | 'DesVu' | 'Sabre' | 'Amadeus' | 'Travelport'
  | 'Airbnb' | 'Agoda' | 'Hostelworld' | 'Other';

export type PersonTitle = 'Mr' | 'Ms' | 'Dr' | 'Prof' | 'Mrs' | 'Other';
export type Gender = 'Female' | 'Male' | 'Other' | 'Unknown';

export interface PersonAddress {
  addressLine1?: string;
  addressLine2?: string;
  postalCode?: string;
  city?: string;
  regionCode?: string;
  countryCode?: string;
}

export interface Person {
  title?: PersonTitle;
  gender?: Gender;
  firstName?: string;
  middleInitial?: string;
  lastName?: string;
  secondLastName?: string;
  email?: string;
  phone?: string;
  address?: PersonAddress;
  nationalityCountryCode?: string;
  identificationNumber?: string;
  identificationAdditionalNumber?: string;
  identificationIssueDate?: BusinessDate;
  identificationExpiryDate?: BusinessDate;
  identificationIssuePlace?: string;
  identificationType?: string;
  personalTaxId?: string;
  company?: { name?: string; taxId?: string };
  preferredLanguage?: string;
  birthDate?: BusinessDate;
  birthPlace?: string;
  birthFirstName?: string;
  birthLastName?: string;
  motherFirstName?: string;
  motherLastName?: string;
  borderCrossingPlace?: string;
  borderCrossingDate?: BusinessDate;
  nextDestination?: string;
  relationshipToPrimaryGuest?: string;
  vehicleRegistration?: { number?: string; countryCode?: string };
}

/** A card or account stored against a booking, without real PAN data. */
export interface RegisteredCard {
  cardNumber?: string;
  cardHolder?: string;
  expiryMonth?: string;
  expiryYear?: string;
  paymentMethod?: string;
  payerEmail?: string;
  note?: string;
  isVirtual?: boolean;
}

export interface ExternalReferences {
  globalDistributionSystemId?: string;
  onlineTravelAgencyId?: string;
  onlineBookingToolId?: string;
  channelManagerId?: string;
  centralReservationSystemId?: string;
  legacyId?: string;
}

export interface Booking {
  id: string;
  groupId?: string;
  booker: Person;
  paymentAccountId?: string;
  registeredCard?: RegisteredCard;
  comment?: string;
  bookerComment?: string;
  created: Instant;
  updated: Instant;
  reservationIds: string[];
  /** Ordinal used to mint the next reservation id inside this booking. */
  nextReservationOrdinal: number;
  transactionReference?: string;
}

export interface ReservationTimeSlice {
  from: Instant;
  to: Instant;
  serviceDate: BusinessDate;
  ratePlanId: string;
  unitGroupId: string;
  /** Price before surcharges and included services. */
  baseAmount: AmountModel;
  /** What the guest actually pays for the night. */
  totalAmount: AmountModel;
  includedServices: { serviceId: string; amount: AmountModel; count: number }[];
}

export interface ReservationService {
  id: string;
  serviceId: string;
  /** One entry per date the service is delivered. */
  dates: { serviceDate: BusinessDate; amount: AmountModel; count: number; isMandatory: boolean }[];
  totalAmount: AmountModel;
  bookedAsExtra: boolean;
}

export interface AssignedUnit {
  unitId: string;
  /** Empty means the whole stay. */
  timeRanges: { from: Instant; to: Instant }[];
}

export interface Reservation {
  id: string;
  bookingId: string;
  blockId?: string;
  groupId?: string;
  propertyId: string;
  status: ReservationStatus;
  ratePlanId: string;
  unitGroupId: string;
  /** Currently assigned unit, if any. */
  unit?: { id: string };
  unitId?: string;
  marketSegmentId?: string;
  arrival: Instant;
  departure: Instant;
  arrivalDate: BusinessDate;
  departureDate: BusinessDate;
  created: Instant;
  updated: Instant;
  checkInTime?: Instant;
  checkOutTime?: Instant;
  cancellationTime?: Instant;
  noShowTime?: Instant;
  adults: number;
  childrenAges: number[];
  comment?: string;
  guestComment?: string;
  externalCode?: string;
  channelCode: ChannelCode;
  source?: string;
  primaryGuest?: Person;
  additionalGuests: Person[];
  guaranteeType: GuaranteeType;
  travelPurpose?: TravelPurpose;
  timeSlices: ReservationTimeSlice[];
  services: ReservationService[];
  assignedUnits: AssignedUnit[];
  companyId?: string;
  corporateCode?: string;
  promoCode?: string;
  commission?: { commissionAmount: MonetaryValue; beforeCommissionAmount: MonetaryValue };
  cancellationFee: { id?: string; code?: string; name?: LocalizedText; dueDateTime?: Instant; fee: MonetaryValue };
  noShowFee: { id?: string; code?: string; name?: LocalizedText; fee: MonetaryValue };
  isPreCheckedIn: boolean;
  isUnitAssignmentLocked: boolean;
  hasCityTax: boolean;
  /** City taxes priced onto the stay, kept so charges can be posted later. */
  cityTaxes: {
    cityTaxId: string;
    code: string;
    name: string;
    dates: { serviceDate: BusinessDate; amount: AmountModel }[];
  }[];
  registeredCard?: RegisteredCard;
  prePaymentAmount?: MonetaryValue;
  validationMessages: { category: string; code: string; message: string }[];
  currency: string;
  /** Ordinal used to mint the next folio id for this reservation. */
  nextFolioOrdinal: number;
  externalReferences?: ExternalReferences;
}

export type BlockStatus = 'Tentative' | 'Definite' | 'Canceled' | 'Optional';

export interface BlockTimeSlice {
  from: Instant;
  to: Instant;
  serviceDate: BusinessDate;
  blockedUnits: number;
  pickedUnits: number;
  baseAmount: AmountModel;
  totalGrossAmount: MonetaryValue;
}

export interface Block {
  id: string;
  propertyId: string;
  groupId: string;
  status: BlockStatus;
  ratePlanId: string;
  unitGroupId: string;
  marketSegmentId?: string;
  promoCode?: string;
  corporateCode?: string;
  grossDailyRate: MonetaryValue;
  from: Instant;
  to: Instant;
  fromDate: BusinessDate;
  toDate: BusinessDate;
  timeSlices: BlockTimeSlice[];
  created: Instant;
  updated: Instant;
  comment?: string;
  currency: string;
  /** Optional blocks auto-release at this point unless confirmed. */
  optionalCutoff?: Instant;
  optionalCutoffBehavior?: 'DoNothing' | 'AutoRelease';
  /** Whether an optional block still holds inventory. */
  isOptionalDeductingInventory: boolean;
}

export interface Group {
  id: string;
  name: string;
  /** Groups can span several properties. */
  propertyIds: string[];
  booker: Person;
  paymentAccountId?: string;
  registeredCard?: RegisteredCard;
  comment?: string;
  bookerComment?: string;
  created: Instant;
  updated: Instant;
  blockIds: string[];
  reservationIds: string[];
}

export type PayerInteraction = 'Terminal' | 'PaymentAccount' | 'Authorization' | 'PaymentLink';

export interface PaymentAccount {
  id: string;
  reservationId?: string;
  bookingId?: string;
  groupId?: string;
  propertyId?: string;
  accountNumber?: string;
  accountHolder?: string;
  expiryMonth?: string;
  expiryYear?: string;
  paymentMethod?: string;
  payerEmail?: string;
  payerReference?: string;
  isVirtual: boolean;
  isActive: boolean;
  inactiveReason?: string;
  payerInteraction: PayerInteraction;
  paymentLinkUrl?: string;
  expiresAt?: Instant;
  created: Instant;
  updated: Instant;
}

export type AuthorizationStatus =
  | 'Pending' | 'Success' | 'Failure' | 'Canceled' | 'Expired' | 'RefreshPending';

export interface Authorization {
  id: string;
  propertyId: string;
  /** What the authorization is held against. */
  reservationId?: string;
  folioId?: string;
  amount: MonetaryValue;
  remainingBalance: MonetaryValue;
  status: AuthorizationStatus;
  failureReason?: string;
  payerInteraction: PayerInteraction;
  externalReference?: { transactionReference?: string; schemeReference?: string };
  created: Instant;
  updated: Instant;
  expiresAt?: Instant;
  paymentLinkUrl?: string;
  paymentAccountId?: string;
}

/* --------------------------------------------------------------- finance */

export type FolioType = 'House' | 'Guest' | 'External' | 'Booking';
export type FolioStatus = 'Open' | 'Closed' | 'ClosedWithInvoice';
export type DebitorType = 'Booker' | 'PrimaryGuest' | 'Company' | 'AdditionalGuest' | 'Property';

export interface Debitor {
  type?: DebitorType;
  title?: PersonTitle;
  firstName?: string;
  name?: string;
  address?: PersonAddress;
  company?: { name: string; taxId?: string; additionalTaxId?: string; additionalTaxId2?: string };
  personalTaxId?: string;
  reference?: string;
  email?: string;
  phone?: string;
}

export interface Folio {
  id: string;
  propertyId: string;
  reservationId?: string;
  bookingId?: string;
  companyId?: string;
  type: FolioType;
  created: Instant;
  updated: Instant;
  debitor: Debitor;
  isMainFolio: boolean;
  isClosed: boolean;
  closedAt?: Instant;
  checkedOutOn?: Instant;
  /** Settled on accounts receivable rather than paid at departure. */
  checkedOutOnAccountsReceivable: boolean;
  currency: string;
  /** Ordinals used to mint charge and payment ids within this folio. */
  nextChargeOrdinal: number;
  nextPaymentOrdinal: number;
  /** Invoices raised over this folio, newest last. */
  invoiceId?: string;
  invoiceIds: string[];
  /** Caller-supplied code for folios created by an external system. */
  externalCode?: string;
  warnings: string[];
}

/** How a charge came to be on the folio. */
export type ChargeType =
  | 'Direct' | 'TimeSlice' | 'IncludedService' | 'ExtraService' | 'CityTax'
  | 'NoShowFee' | 'CancellationFee' | 'ServiceFee' | 'Tax' | 'SecondCityTax';

export interface Charge {
  id: string;
  folioId: string;
  propertyId: string;
  reservationId?: string;
  serviceType: ServiceType;
  type: ChargeType;
  serviceId?: string;
  subAccountId?: string;
  name: LocalizedText;
  amount: AmountModel;
  quantity: number;
  created: Instant;
  serviceDate: BusinessDate;
  /** Set when the charge was moved here from, or away to, another folio. */
  movedFromFolioId?: string;
  movedToFolioId?: string;
  movedReason?: string;
  /** Set when a routing rule pulled the charge across folios. */
  routedFromFolioId?: string;
  routedToFolioId?: string;
  sourceChargeId?: string;
  receipt?: string;
  isPosted: boolean;
  allowanceIds: string[];
}

export type PaymentMethod =
  | 'Cash' | 'BankTransfer' | 'CreditCard' | 'Invoice' | 'Amex' | 'VisaCredit' | 'VisaDebit'
  | 'MasterCard' | 'MasterCardDebit' | 'Maestro' | 'GiroCard' | 'DiscoverCard' | 'Diners'
  | 'Jcb' | 'BookingCom' | 'VPay' | 'PayPal' | 'Postcard' | 'Reka' | 'Twint' | 'Lunchcheck'
  | 'Voucher' | 'ChinaUnionPay' | 'Other' | 'Cheque' | 'Airbnb' | 'HolidayCheck'
  | 'Representation' | 'IDeal';

export type PaymentStatus = 'Pending' | 'Success' | 'Failure' | 'Canceled';

export interface Payment {
  id: string;
  folioId: string;
  propertyId: string;
  method: PaymentMethod;
  amount: MonetaryValue;
  created: Instant;
  paymentDate: Instant;
  businessDate: BusinessDate;
  settlementDate?: BusinessDate;
  receipt?: string;
  status: PaymentStatus;
  failureReason?: string;
  externalReference?: { merchantReference?: string; pspReference?: string };
  /** A split payment points back at the one it came from. */
  sourcePaymentId?: string;
  movedFromFolioId?: string;
  movedToFolioId?: string;
  movedReason?: string;
  /** Charges this payment was applied against, when the caller says. */
  paidChargeIds: string[];
  /** Pending link/terminal payments carry the URL or terminal. */
  paymentLinkUrl?: string;
  terminalId?: string;
  expiresAt?: Instant;
}

export interface Refund {
  id: string;
  folioId: string;
  propertyId: string;
  method: PaymentMethod;
  amount: MonetaryValue;
  created: Instant;
  refundDate: Instant;
  businessDate: BusinessDate;
  receipt?: string;
  status: PaymentStatus;
  failureReason?: string;
  failureCode?: 'Failed' | 'TimedOut';
  externalReference?: { merchantReference?: string; pspReference?: string };
  sourcePaymentId?: string;
  movedFromFolioId?: string;
  movedToFolioId?: string;
  movedReason?: string;
  reason?: string;
}

export interface Allowance {
  id: string;
  folioId: string;
  propertyId: string;
  chargeId?: string;
  amount: AmountModel;
  reason: string;
  created: Instant;
  serviceDate: BusinessDate;
  serviceType: ServiceType;
  name: LocalizedText;
  subAccountId?: string;
  movedFromFolioId?: string;
  movedToFolioId?: string;
  movedReason?: string;
}

export interface TransitoryCharge {
  id: string;
  folioId: string;
  propertyId: string;
  name: LocalizedText;
  amount: AmountModel;
  serviceType: ServiceType;
  quantity: number;
  created: Instant;
  serviceDate: BusinessDate;
  subAccountId?: string;
  receipt?: string;
  movedFromFolioId?: string;
  movedToFolioId?: string;
  movedReason?: string;
}

export type InvoiceStatus = 'FullyPaid' | 'Unpaid' | 'WrittenOff';
export type InvoiceType =
  | 'Initial' | 'Cancellation' | 'Correction' | 'Advance' | 'AdvanceCancellation'
  | 'AdvanceCorrection' | 'Proforma' | 'Deposit' | 'DepositCancellation';
export type CancellationReasonCode =
  | 'ChangeOfRecipientDetails' | 'ChangeOfInvoiceRecipient' | 'ChangeOfPaymentMethod'
  | 'ChangeOfInvoiceTransactions' | 'Other';

export interface InvoiceLineItem {
  chargeId?: string;
  date: BusinessDate;
  description: string;
  price: MonetaryValue;
  vatType: VatType;
  vatPercent: number;
  isNoShowFee: boolean;
  quantity: number;
  guest?: string;
  includedLineItems?: { description: string; price: MonetaryValue; vatType: VatType; vatPercent: number }[];
}

export interface Invoice {
  id: string;
  propertyId: string;
  number: string;
  series?: string;
  type: InvoiceType;
  status: InvoiceStatus;
  created: Instant;
  invoiceDate: BusinessDate;
  folioId: string;
  reservationId?: string;
  bookingId?: string;
  companyId?: string;
  languageCode: string;
  recipient: Debitor;
  currency: string;
  /** Snapshot taken at issue time, so later folio edits do not rewrite history. */
  lineItems: InvoiceLineItem[];
  total: number;
  netTotal: number;
  paidAmount: number;
  paymentSettled: boolean;
  paymentIds: string[];
  /** Cancellations and corrections point at the invoice they supersede. */
  relatedInvoiceNumber?: string;
  cancellationReasonCode?: CancellationReasonCode;
  writeOffReason?: string;
  paymentTerms?: string;
  stayInfo?: {
    guestName: string;
    arrivalDate: BusinessDate;
    departureDate: BusinessDate;
    reservationId: string;
    roomNumber?: string;
  };
}

export interface RoutingFilter {
  folioIds: string[];
  subAccountIds: string[];
  serviceTypes: ServiceType[];
  serviceIds: string[];
  from?: BusinessDate;
  to?: BusinessDate;
}

export interface Routing {
  id: string;
  propertyId: string;
  bookingId: string;
  /** Where matching charges end up. */
  targetFolioId: string;
  filter: RoutingFilter;
  created: Instant;
  createdBy?: string;
}

/* ------------------------------------------------------------ operations */

export type MaintenanceType = 'OutOfService' | 'OutOfOrder' | 'OutOfInventory';

export interface Maintenance {
  id: string;
  propertyId: string;
  unitId: string;
  type: MaintenanceType;
  from: Instant;
  to: Instant;
  fromDate: BusinessDate;
  toDate: BusinessDate;
  description?: string;
  created: Instant;
}

export interface NightAuditLog {
  id: string;
  propertyId: string;
  businessDate: BusinessDate;
  created: Instant;
  triggeredBy: string;
  /** What the run did, for the operations log. */
  summary: {
    chargesPosted: number;
    noShowsMarked: number;
    reservationsInHouse: number;
    revenue: MonetaryValue;
  };
  warnings: string[];
}

/** One run of a Finance API export, journaled for the Logs API. */
export interface TransactionExportLog {
  id: string;
  propertyId: string;
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  type: 'Raw' | 'Aggregate' | 'AggregatePairs';
  clientId: string;
  subjectId: string;
  created: Instant;
}

/* ------------------------------------------------------------------ logs */

export interface AuditLogEntry {
  id: string;
  propertyId: string;
  reservationId?: string;
  folioId?: string;
  created: Instant;
  /** Machine-readable action name, e.g. `ReservationCreated`. */
  action: string;
  /** Who did it: a client id or user subject. */
  source: string;
  /** Human-readable summary of the change. */
  message: string;
  /** Structured before/after values where meaningful. */
  changes?: { path: string; from: unknown; to: unknown }[];
  /** Folio events: the charge/payment/allowance the entry refers to. */
  relatedEntityId?: string;
  amount?: MonetaryValue;
  serviceDate?: BusinessDate;
}
