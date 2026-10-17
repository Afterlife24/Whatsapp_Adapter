/**
 * Exact decimal money helpers for the browser.
 *
 * JavaScript numbers are binary floats and cannot represent most decimal
 * fractions (0.1 + 0.2 !== 0.3). Every amount here is handled as a BigInt
 * scaled to a fixed number of decimal places, with the same ROUND_HALF_UP the
 * AgentX backend uses on its Decimal values. Amounts are never passed through
 * parseFloat or Number().
 */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type PaymentCurrency = "INR" | "USD";

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const HUNDRED = BigInt(100);

/** Decimal places used internally for every comparison and sum. */
export const MONEY_SCALE = 6;

/** The backend stores FX rates as Numeric(18, 6). */
export const RATE_MAX_DECIMALS = 6;

function pow10(exponent: number): bigint {
  return BigInt("1" + "0".repeat(exponent));
}

/** Divide two positive BigInts, rounding half up. */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return (numerator % denominator) * TWO >= denominator ? quotient + ONE : quotient;
}

/**
 * Parse a decimal string (or a plain JSON number) into an integer scaled by
 * 10^scale, rounding half away from zero. Returns null for anything that is
 * not a plain decimal.
 */
export function toScaled(value: unknown, scale = MONEY_SCALE): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!DECIMAL_RE.test(text)) return null;

  const negative = text.startsWith("-");
  const [intPart, fracPart = ""] = (negative ? text.slice(1) : text).split(".");
  let scaled = BigInt(intPart + fracPart.padEnd(scale, "0").slice(0, scale));
  if (fracPart.length > scale && Number(fracPart[scale]) >= 5) scaled += ONE;
  return negative ? -scaled : scaled;
}

/** Change the scale of a value, rounding half away from zero. */
function rescale(value: bigint, from: number, to: number): bigint {
  if (to >= from) return value * pow10(to - from);
  const negative = value < ZERO;
  const rounded = divideHalfUp(negative ? -value : value, pow10(from - to));
  return negative ? -rounded : rounded;
}

/** Render a scaled integer back to a plain decimal string, e.g. "5.620000". */
export function scaledToString(value: bigint, scale = MONEY_SCALE): string {
  const negative = value < ZERO;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = scale > 0 ? `.${digits.slice(digits.length - scale)}` : "";
  return `${negative ? "-" : ""}${intPart}${fracPart}`;
}

export function localeFor(currency: string): string {
  return currency.toUpperCase() === "INR" ? "en-IN" : "en-US";
}

const symbolCache = new Map<string, string>();

export function currencySymbol(currency: string): string {
  const code = currency.toUpperCase();
  const cached = symbolCache.get(code);
  if (cached) return cached;

  let symbol = code;
  try {
    const part = new Intl.NumberFormat(localeFor(code), {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
    })
      .formatToParts(0)
      .find((p) => p.type === "currency");
    if (part) symbol = part.value;
  } catch {
    // Unknown currency code: fall back to the code itself.
  }
  symbolCache.set(code, symbol);
  return symbol;
}

interface FormatOptions {
  /** Fewest decimal places to show. */
  minPlaces?: number;
  /** Most decimal places to show; extra precision is rounded half up. */
  maxPlaces?: number;
  /** Prefix positive values with "+". */
  signed?: boolean;
}

/**
 * Format a decimal as money: "₹1,00,000.00", "$5.62", "−$0.019201".
 * Grouping follows the currency (lakh/crore for INR). Returns "—" for
 * missing or malformed input so a bad value never renders as NaN.
 */
export function formatMoney(
  value: unknown,
  currency: string,
  { minPlaces = 2, maxPlaces = 2, signed = false }: FormatOptions = {}
): string {
  const scaled = typeof value === "bigint" ? value : toScaled(value);
  if (scaled === null) return "—";

  const rounded = rescale(scaled, MONEY_SCALE, maxPlaces);
  const negative = rounded < ZERO;
  const [intPart, rawFrac = ""] = scaledToString(negative ? -rounded : rounded, maxPlaces).split(".");

  let fracPart = rawFrac;
  while (fracPart.length > minPlaces && fracPart.endsWith("0")) {
    fracPart = fracPart.slice(0, -1);
  }

  const grouped = BigInt(intPart).toLocaleString(localeFor(currency));
  const sign = negative ? "−" : signed && rounded > ZERO ? "+" : "";
  return `${sign}${currencySymbol(currency)}${grouped}${fracPart ? `.${fracPart}` : ""}`;
}

/** USD at full ledger precision: "$5.62", "$0.019201". */
export function formatUsdPrecise(value: unknown, signed = false): string {
  return formatMoney(value, "USD", { minPlaces: 2, maxPlaces: MONEY_SCALE, signed });
}

/** Format integer minor units (paise/cents) as money. */
export function formatMinor(minor: number, currency: string): string {
  // Guard: BigInt(undefined/NaN/1.5) throws and would crash the whole page.
  if (!Number.isSafeInteger(minor)) return "—";
  return formatMoney(scaledToString(BigInt(minor), 2), currency);
}

/** Exact sum of decimal strings; values that fail to parse are skipped. */
export function sumDecimals(values: unknown[]): bigint {
  return values.reduce<bigint>((total, value) => total + (toScaled(value) ?? ZERO), ZERO);
}

export function isPositive(value: unknown): boolean {
  const scaled = toScaled(value);
  return scaled !== null && scaled > ZERO;
}

/**
 * Validate what the operator typed and convert it to integer minor units:
 * "500" -> 50000, "499.5" -> 49950. Thousands separators are tolerated.
 */
export function parseAmountToMinor(input: string): ParseResult<number> {
  const text = input.replace(/[,\s_]/g, "");
  if (!text) return { ok: false, error: "Enter the amount received." };
  if (!/^\d+(\.\d*)?$/.test(text)) {
    return { ok: false, error: "Use digits only, like 500 or 499.50." };
  }

  const [intPart, fracPart = ""] = text.split(".");
  if (fracPart.length > 2) {
    return { ok: false, error: "Use at most 2 decimal places." };
  }

  const minor = BigInt(intPart) * HUNDRED + BigInt(fracPart.padEnd(2, "0"));
  if (minor <= ZERO) return { ok: false, error: "The amount must be greater than zero." };
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: "That amount is too large." };
  }
  // Safe to convert: an integer below 2^53 is exact in a JS number.
  return { ok: true, value: Number(minor) };
}

/** Validate an FX rate (1 INR = X USD). Returns the trimmed decimal string. */
export function parseRate(input: string): ParseResult<string> {
  const text = input.trim();
  if (!text) return { ok: false, error: "Enter the exchange rate." };
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return { ok: false, error: "Use a decimal rate, like 0.0112." };
  }
  if ((text.split(".")[1] ?? "").length > RATE_MAX_DECIMALS) {
    return { ok: false, error: `Use at most ${RATE_MAX_DECIMALS} decimal places.` };
  }
  const scaled = toScaled(text, RATE_MAX_DECIMALS);
  if (scaled === null || scaled <= ZERO) {
    return { ok: false, error: "The rate must be greater than zero." };
  }
  return { ok: true, value: text };
}

/**
 * The USD AgentX will credit, at 6 decimal places. Mirrors the backend's
 * compute_credited_usd exactly: (minor / 100) * rate, ROUND_HALF_UP.
 * This is a preview only; the server recomputes and its figure is final.
 */
export function previewCreditUsd(
  minor: number,
  currency: PaymentCurrency,
  rate: string | null
): bigint | null {
  const minorUnits = BigInt(minor);
  if (currency === "USD") return minorUnits * pow10(MONEY_SCALE - 2);

  const rateScaled = rate ? toScaled(rate, RATE_MAX_DECIMALS) : null;
  if (rateScaled === null || rateScaled <= ZERO) return null;

  const numerator = minorUnits * rateScaled * pow10(MONEY_SCALE);
  const denominator = HUNDRED * pow10(RATE_MAX_DECIMALS);
  return divideHalfUp(numerator, denominator);
}

/** "1 INR = 0.0112 USD" -> "89.29" (rupees per dollar), for display only. */
export function inverseRate(rate: string): string | null {
  const rateScaled = toScaled(rate, RATE_MAX_DECIMALS);
  if (rateScaled === null || rateScaled <= ZERO) return null;
  return scaledToString(divideHalfUp(pow10(RATE_MAX_DECIMALS + 2), rateScaled), 2);
}

/** Drop trailing zeros from a rate for display: "0.011240" -> "0.01124". */
export function trimRate(rate: unknown): string {
  const scaled = toScaled(rate, RATE_MAX_DECIMALS);
  if (scaled === null) return "—";
  return scaledToString(scaled, RATE_MAX_DECIMALS).replace(/\.?0+$/, "");
}
