/**
 * Reference data served by the `/types/...` endpoints. The enum members are
 * taken verbatim from the apaleo specs so clients validating against the
 * documented lists see exactly what they expect.
 */

export const SERVICE_TYPES = [
  'Other', 'Accommodation', 'FoodAndBeverages', 'CancellationFees', 'NoShow',
  'CityTax', 'SecondCityTax', 'LocalTax', 'ConsumptionTax',
] as const;
export type ServiceTypeName = (typeof SERVICE_TYPES)[number];

export const PAYMENT_METHODS = [
  'Cash', 'BankTransfer', 'CreditCard', 'Amex', 'VisaCredit', 'VisaDebit', 'MasterCard',
  'MasterCardDebit', 'Maestro', 'GiroCard', 'DiscoverCard', 'Diners', 'Jcb', 'BookingCom',
  'VPay', 'PayPal', 'Postcard', 'Reka', 'Twint', 'Lunchcheck', 'Voucher', 'ChinaUnionPay',
  'Other', 'Cheque', 'Airbnb', 'HolidayCheck', 'Representation', 'IDeal',
] as const;
export type PaymentMethodName = (typeof PAYMENT_METHODS)[number];

export const VAT_TYPES = [
  'Null', 'VeryReduced', 'Reduced', 'Normal', 'Without', 'Special', 'ReducedCovid19', 'NormalCovid19',
] as const;

export const CHANNEL_CODES = [
  'Direct', 'BookingCom', 'Ibe', 'ChannelManager', 'Expedia', 'Homelike', 'Hrs', 'AltoVita',
  'DesVu', 'Sabre', 'Amadeus', 'Travelport', 'Airbnb', 'Agoda', 'Hostelworld', 'Other',
] as const;

export const GENDERS = ['Female', 'Male', 'Other'] as const;

export const IDENTIFICATION_TYPES = [
  'PassportNumber', 'DriverLicenseNumber', 'IdentityCardNumber', 'ResidencePermitNumber',
  'MilitaryIdNumber', 'SeamanBookNumber', 'VisaNumber', 'Other',
] as const;

/** Sources commonly seen on reservations; free text is also accepted. */
export const SOURCES = [
  'Direct', 'Website', 'Phone', 'Email', 'Walk-in', 'Booking.com', 'Expedia',
  'Airbnb', 'HRS', 'Agoda', 'Hostelworld', 'Travel agent', 'Corporate', 'Other',
] as const;

/** ISO 3166-1 alpha-2. */
export const COUNTRY_CODES = [
  'AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ',
  'BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ',
  'CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CU','CV','CW','CX','CY','CZ',
  'DE','DJ','DK','DM','DO','DZ',
  'EC','EE','EG','EH','ER','ES','ET',
  'FI','FJ','FK','FM','FO','FR',
  'GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY',
  'HK','HM','HN','HR','HT','HU',
  'ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT',
  'JE','JM','JO','JP',
  'KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ',
  'LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY',
  'MA','MC','MD','ME','MF','MG','MH','MK','ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ',
  'NA','NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ',
  'OM',
  'PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PW','PY',
  'QA',
  'RE','RO','RS','RU','RW',
  'SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SY','SZ',
  'TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ',
  'UA','UG','UM','US','UY','UZ',
  'VA','VC','VE','VG','VI','VN','VU',
  'WF','WS','YE','YT','ZA','ZM','ZW',
] as const;

/** ISO 4217 codes apaleo transacts in. */
export const CURRENCY_CODES = [
  'AED','ARS','AUD','BGN','BHD','BRL','CAD','CHF','CLP','CNY','COP','CZK','DKK','EGP',
  'EUR','GBP','HKD','HRK','HUF','IDR','ILS','INR','ISK','JPY','KES','KRW','KWD','MAD',
  'MXN','MYR','NGN','NOK','NZD','OMR','PEN','PHP','PLN','QAR','RON','RSD','RUB','SAR',
  'SEK','SGD','THB','TRY','TWD','UAH','USD','UYU','VND','XCD','ZAR',
] as const;

/** Languages the localized text dictionaries commonly carry. */
export const LANGUAGE_CODES = [
  'bg','cs','da','de','el','en','es','et','fi','fr','he','hr','hu','it','ja','ko',
  'lt','lv','nl','no','pl','pt','ro','ru','sk','sl','sr','sv','th','tr','uk','zh',
] as const;

export function isCountryCode(code: string): boolean {
  return (COUNTRY_CODES as readonly string[]).includes(code.toUpperCase());
}

export function isCurrencyCode(code: string): boolean {
  return (CURRENCY_CODES as readonly string[]).includes(code.toUpperCase());
}

/**
 * Which service types a city tax of type `Percent` is calculated on by default.
 */
export const DEFAULT_CITY_TAX_BASE: ServiceTypeName[] = ['Accommodation'];
