// The seeded generator and the reserved ranges every planted value is drawn from.
// corpus.ts states the provenance rules these implement.
import { createHash } from 'node:crypto';
import { Faker, base, en, en_US } from '@faker-js/faker';
import { plant, type Planted } from './case.ts';
import type { Sub } from './taxonomy.ts';

/** "Today" for relative dates, so the corpus does not drift with the wall clock. */
const REFERENCE_DATE = '2026-10-01T00:00:00Z';

export const faker = new Faker({ locale: [en_US, en, base] });
faker.setDefaultRefDate(REFERENCE_DATE);

/** Seeds from the case id, so adding a case never changes another case. */
export function seedFor(id: string): void {
  faker.seed(createHash('sha256').update(id).digest().readUInt32BE(0));
}

/** Published card-network and payment-provider test numbers, all Luhn-valid. */
export const TEST_PANS = [
  '4242424242424242',
  '4111111111111111',
  '4012888888881881',
  '4000056655665556',
  '5555555555554444',
  '5105105105105100',
  '378282246310005',
  '6011111111111117',
  '30569309025904',
  '3530111333300000',
] as const;

/** Email domains reserved for documentation and testing (RFC 2606, RFC 6761). */
export const RESERVED_EMAIL_DOMAINS = ['example.com', 'example.org', 'clinic.test'] as const;

const AREA_CODES = ['212', '303', '312', '404', '415', '512', '602', '617', '713', '206'] as const;
const DOCUMENTATION_NETWORKS = ['192.0.2', '198.51.100', '203.0.113'] as const;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
const DAY_MS = 86_400_000;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const digits = (length: number) => faker.string.numeric({ length, allowLeadingZeros: true });
const letters = (length: number, casing: 'lower' | 'upper') => faker.string.alpha({ length, casing });
const word = () => letters(faker.number.int({ min: 4, max: 8 }), 'lower');

export type DateStyle = 'iso' | 'us' | 'long' | 'compact';
type Dates = Record<DateStyle, Planted>;

function datesOf(kind: Sub<'date'>, date: Date): Dates {
  const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
  return {
    iso: plant('date', kind, `${year}-${pad(month)}-${pad(day)}`),
    us: plant('date', kind, `${pad(month)}/${pad(day)}/${year}`),
    long: plant('date', kind, `${MONTHS[month - 1]} ${day}, ${year}`),
    compact: plant('date', kind, `${year}${pad(month)}${pad(day)}`),
  };
}

// 555-0100 to 555-0199 are the numbers reserved for fiction.
function reservedPhone(): string {
  const area = faker.helpers.arrayElement(AREA_CODES);
  const line = `01${pad(faker.number.int({ max: 99 }))}`;
  return faker.helpers.arrayElement([
    `(${area}) 555-${line}`,
    `${area}-555-${line}`,
    `${area}.555.${line}`,
    `+1 ${area} 555 ${line}`,
  ]);
}

const deviceSerial = () => `SN-${faker.string.hexadecimal({ length: 10, casing: 'upper', prefix: '' })}`;
const portalUrl = () =>
  `https://portal.example.org/patients/${faker.string.alphanumeric({ length: 12, casing: 'lower' })}/chart`;
const documentationIp = () =>
  `${faker.helpers.arrayElement(DOCUMENTATION_NETWORKS)}.${faker.number.int({ min: 1, max: 254 })}`;

const reservedEmail = () => `${word()}.${word()}@${faker.helpers.arrayElement(RESERVED_EMAIL_DOMAINS)}`;

// Areas 001 to 899 except 666, nonzero group and serial. Areas from 900 are left out
// because Bedrock treats those with a fourth digit of 7 or 8 as ITINs.
function ssnParts(): [area: string, group: string, serial: string] {
  const area = faker.number.int({ min: 1, max: 898 });
  return [
    pad(area >= 666 ? area + 1 : area, 3),
    pad(faker.number.int({ min: 1, max: 99 })),
    pad(faker.number.int({ min: 1, max: 9999 }), 4),
  ];
}

// Generated to look issued, so it could coincide with a real number. That is why it is
// a sub-category of its own, next to the numbers that can never have been issued.
const formatValidSsn = () => ssnParts().join('-');

// Area 000 or 666, group 00 and serial 0000 are never issued.
function neverIssuedSsn(): string {
  const parts = ssnParts();
  const [position, value] = faker.helpers.arrayElement([
    [0, '000'],
    [0, '666'],
    [1, '00'],
    [2, '0000'],
  ] as const);
  parts[position] = value;
  return parts.join('-');
}

/** One generated person and every identifier the evals plant for them. */
export interface Subject {
  firstName: Planted;
  lastName: Planted;
  street: Planted;
  city: Planted;
  zip: Planted;
  birth: Dates;
  admission: Dates;
  discharge: Dates;
  service: Dates;
  death: Dates;
  phone: Planted;
  fax: Planted;
  email: Planted;
  neverIssuedSsn: Planted;
  formatValidSsn: Planted;
  card: Planted;
  bankAccount: Planted;
  patientAccount: Planted;
  driversLicense: Planted;
  passport: Planted;
  vin: Planted;
  plate: Planted;
  mrn: Planted;
  deviceSerial: Planted;
  portalUrl: Planted;
  ip: Planted;
  age: Planted;
}

export function makeSubject(): Subject {
  const admitted = faker.date.recent({ days: 365 });
  const discharged = new Date(admitted.getTime() + faker.number.int({ min: 1, max: 14 }) * DAY_MS);
  return {
    firstName: plant('name', 'first', faker.person.firstName()),
    lastName: plant('name', 'last', faker.person.lastName()),
    street: plant('geographic', 'street', faker.location.streetAddress()),
    city: plant('geographic', 'city', faker.location.city()),
    zip: plant('geographic', 'zip', faker.location.zipCode('#####')),
    birth: datesOf('birth', faker.date.birthdate({ mode: 'year', min: 1925, max: 2004 })),
    admission: datesOf('admission', admitted),
    discharge: datesOf('discharge', discharged),
    service: datesOf('service', faker.date.recent({ days: 365 })),
    death: datesOf('death', faker.date.recent({ days: 365 })),
    phone: plant('phone', 'phone', reservedPhone()),
    fax: plant('fax', 'fax', reservedPhone()),
    email: plant('email', 'email', reservedEmail()),
    neverIssuedSsn: plant('ssn', 'never-issued', neverIssuedSsn()),
    formatValidSsn: plant('ssn', 'format-valid', formatValidSsn()),
    card: plant('account', 'card', faker.helpers.arrayElement(TEST_PANS)),
    bankAccount: plant('account', 'bank', faker.finance.accountNumber(10)),
    driversLicense: plant('certificate-license', 'drivers-license', `${letters(1, 'upper')}${digits(7)}`),
    passport: plant('certificate-license', 'passport', digits(9)),
    vin: plant('vehicle', 'vin', faker.vehicle.vin()),
    plate: plant('vehicle', 'plate', `${letters(3, 'upper')}${digits(4)}`),
    mrn: plant('mrn', 'mrn', digits(8)),
    deviceSerial: plant('device', 'serial', deviceSerial()),
    portalUrl: plant('url', 'url', portalUrl()),
    ip: plant('ip', 'ip', documentationIp()),
    age: plant('age-over-89', 'age', `${faker.number.int({ min: 90, max: 99 })} years old`),
    patientAccount: plant('patient-account', 'account', digits(10)),
  };
}
