/**
 * Convertit un nombre entier en toutes lettres, en français — utilisé pour
 * les documents officiels (demande de paiement, bulletin...) où le montant
 * doit apparaître à la fois en chiffres ET en toutes lettres, conformément
 * aux exigences des bailleurs (USAID, UE...).
 *
 * Exemple : 138666000 -> "Cent Trente-Huit Millions Six Cent Soixante-Six Mille"
 */

const UNITS = ["", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf"];
const TEENS = ["dix", "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf"];
const TENS = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante", "soixante-dix", "quatre-vingt", "quatre-vingt-dix"];

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Convertit un nombre de 0 à 999 en lettres. */
function convertHundreds(n: number): string {
  if (n === 0) return "";
  const hundreds = Math.floor(n / 100);
  const remainder = n % 100;
  let result = "";

  if (hundreds > 0) {
    result += hundreds === 1 ? "cent" : `${UNITS[hundreds]} cent`;
    if (hundreds > 1 && remainder === 0) result += "s"; // "deux cents" mais "deux cent un"
    if (remainder > 0) result += " ";
  }

  if (remainder > 0) {
    if (remainder < 10) {
      result += UNITS[remainder];
    } else if (remainder < 20) {
      result += TEENS[remainder - 10];
    } else {
      const tensDigit = Math.floor(remainder / 10);
      const unitsDigit = remainder % 10;
      if (tensDigit === 7 || tensDigit === 9) {
        // soixante-dix, quatre-vingt-dix : construits sur soixante/quatre-vingt + dix-neuf
        result += TENS[tensDigit - 1];
        result += unitsDigit === 1 && tensDigit === 7 ? " et " : "-";
        result += TEENS[unitsDigit];
      } else {
        result += TENS[tensDigit];
        if (unitsDigit === 1 && tensDigit !== 8) result += " et un";
        else if (unitsDigit > 0) result += `-${UNITS[unitsDigit]}`;
        else if (tensDigit === 8) result += "s"; // "quatre-vingts" seul
      }
    }
  }
  return result;
}

/** Convertit un entier positif en toutes lettres françaises, avec la première lettre en majuscule. */
export function numberToFrenchWords(n: number): string {
  const num = Math.round(Math.abs(n));
  if (num === 0) return "Zéro";

  const billions = Math.floor(num / 1_000_000_000);
  const millions = Math.floor((num % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((num % 1_000_000) / 1_000);
  const units = num % 1_000;

  const parts: string[] = [];
  if (billions > 0) parts.push(`${convertHundreds(billions)} milliard${billions > 1 ? "s" : ""}`);
  if (millions > 0) parts.push(`${convertHundreds(millions)} million${millions > 1 ? "s" : ""}`);
  if (thousands > 0) parts.push(thousands === 1 ? "mille" : `${convertHundreds(thousands)} mille`);
  if (units > 0) parts.push(convertHundreds(units));

  return capitalize(parts.join(" ").trim());
}

/** Montant en toutes lettres suivi de la devise, format standard des documents officiels. */
export function amountToFrenchWords(amount: number, currency: string): string {
  const currencyLabel: Record<string, string> = {
    GNF: "Francs Guinéens",
    USD: "Dollars Américains",
    EUR: "Euros",
  };
  return `${numberToFrenchWords(amount)} ${currencyLabel[currency] ?? currency}`;
}

/**
 * Variante utilisée sur les demandes de paiement et documents bancaires
 * ouest-africains : chaque mot avec une majuscule initiale, sans tirets
 * entre les mots composés — ex. "Cent Trente-Huit Millions" devient
 * "Cent Trente Huit Millions". Convention distincte de l'orthographe
 * française standard, mais c'est celle attendue sur ces documents précis.
 */
export function amountToFrenchWordsAdministrative(amount: number, currency: string): string {
  const standard = amountToFrenchWords(amount, currency);
  return standard
    .split(/[\s-]+/)
    .map((word) => (word.length ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}
