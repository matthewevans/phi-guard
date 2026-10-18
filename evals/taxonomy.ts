// The HIPAA Safe Harbor identifier list as far as the evals tell values apart. Each
// sub-category lists the guardrail types (PII entity types or regex names in
// infra/guardrail.yaml) expected to report it; test/evals.test.ts keeps this in step
// with the template.
//
//   detectable  a PII entity type or a fixed regex covers it
//   overlay     only a parameterised regex covers it, so cases come from evals/local
//   gap         nothing covers it on purpose; reported as a gap, never as a failure
export type Coverage = 'detectable' | 'overlay' | 'gap';

export const TAXONOMY = {
  name: { coverage: 'detectable', subs: { first: ['NAME'], last: ['NAME'] } },
  geographic: {
    coverage: 'detectable',
    subs: { street: ['ADDRESS'], city: ['ADDRESS'], zip: ['ADDRESS'] },
  },
  date: {
    coverage: 'detectable',
    subs: {
      birth: ['PersonDate'],
      admission: ['PersonDate'],
      discharge: ['PersonDate'],
      service: ['PersonDate'],
      death: ['PersonDate'],
    },
  },
  'age-over-89': { coverage: 'gap', subs: { age: [] } },
  phone: { coverage: 'detectable', subs: { phone: ['PHONE'] } },
  fax: { coverage: 'detectable', subs: { fax: ['PHONE'] } },
  email: { coverage: 'detectable', subs: { email: ['EMAIL'] } },
  ssn: {
    coverage: 'detectable',
    subs: { 'never-issued': ['US_SOCIAL_SECURITY_NUMBER'], 'format-valid': ['US_SOCIAL_SECURITY_NUMBER'] },
  },
  mrn: { coverage: 'gap', subs: { mrn: [] } },
  'health-plan-beneficiary': { coverage: 'overlay', subs: { 'member-id': ['MemberId'] } },
  account: {
    coverage: 'detectable',
    subs: { bank: ['US_BANK_ACCOUNT_NUMBER'], card: ['CREDIT_DEBIT_CARD_NUMBER'] },
  },
  'patient-account': { coverage: 'gap', subs: { account: [] } },
  'certificate-license': {
    coverage: 'detectable',
    subs: { 'drivers-license': ['DRIVER_ID'], passport: ['US_PASSPORT_NUMBER'] },
  },
  vehicle: {
    coverage: 'detectable',
    subs: { vin: ['VEHICLE_IDENTIFICATION_NUMBER'], plate: ['LICENSE_PLATE'] },
  },
  device: { coverage: 'gap', subs: { serial: [] } },
  url: { coverage: 'gap', subs: { url: [] } },
  ip: { coverage: 'gap', subs: { ip: [] } },
  'other-unique-id': { coverage: 'overlay', subs: { 'claim-number': ['ClaimNumber'] } },
} as const satisfies Record<string, { coverage: Coverage; subs: Record<string, readonly string[]> }>;

export type Category = keyof typeof TAXONOMY;
export type Sub<C extends Category> = keyof (typeof TAXONOMY)[C]['subs'] & string;

export const CATEGORIES = Object.keys(TAXONOMY) as Category[];

/** Looks up by plain strings, which is what a parsed overlay row has. */
export function expectedTypes(category: Category, sub: string): readonly string[] | undefined {
  const subs: Record<string, readonly string[]> = TAXONOMY[category].subs;
  return Object.hasOwn(subs, sub) ? subs[sub] : undefined;
}
