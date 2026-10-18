// What a record shows, independent of the format that prints it. Most scenarios isolate
// one kind of identifier; member-record puts a whole member row in one place.
import type { Recipe } from './compose.ts';
import { RENDERERS, ROW_FORMATS, type Row } from './render.ts';
import { makeSubject, type Subject } from './synthetic.ts';

interface Scenario {
  name: string;
  row(subject: Subject): Row;
}

const SCENARIOS: readonly Scenario[] = [
  { name: 'name-parts', row: (s) => [['first_name', s.firstName], ['last_name', s.lastName]] },
  { name: 'name-combined', row: (s) => [['patient_name', [s.lastName, ', ', s.firstName]]] },
  { name: 'home-address', row: (s) => [['address_line1', s.street], ['city', s.city], ['zip', s.zip]] },
  { name: 'birth-date-iso', row: (s) => [['dob', s.birth.iso]] },
  { name: 'birth-date-us', row: (s) => [['birth_date', s.birth.us]] },
  { name: 'birth-date-long', row: (s) => [['date_of_birth', s.birth.long]] },
  { name: 'stay-dates', row: (s) => [['admission_date', s.admission.iso], ['discharge_date', s.discharge.us]] },
  { name: 'service-date', row: (s) => [['date_of_service', s.service.iso]] },
  { name: 'death-date', row: (s) => [['date_of_death', s.death.iso]] },
  { name: 'phone', row: (s) => [['phone', s.phone]] },
  { name: 'fax', row: (s) => [['fax', s.fax]] },
  { name: 'email', row: (s) => [['email', s.email]] },
  { name: 'ssn-never-issued', row: (s) => [['ssn', s.neverIssuedSsn]] },
  { name: 'ssn-format-valid', row: (s) => [['social_security_number', s.formatValidSsn]] },
  { name: 'card', row: (s) => [['card_number', s.card]] },
  { name: 'bank-account', row: (s) => [['account_number', s.bankAccount]] },
  { name: 'patient-account', row: (s) => [['patient_account_number', s.patientAccount]] },
  { name: 'drivers-license', row: (s) => [['drivers_license', s.driversLicense]] },
  { name: 'passport', row: (s) => [['passport_number', s.passport]] },
  { name: 'vehicle', row: (s) => [['vin', s.vin], ['license_plate', s.plate]] },
  { name: 'mrn', row: (s) => [['mrn', s.mrn]] },
  { name: 'device', row: (s) => [['device_serial', s.deviceSerial]] },
  { name: 'portal-url', row: (s) => [['portal_url', s.portalUrl]] },
  { name: 'ip', row: (s) => [['last_login_ip', s.ip]] },
  { name: 'age-over-89', row: (s) => [['age', s.age]] },
  {
    name: 'member-record',
    row: (s) => [
      ['first_name', s.firstName],
      ['last_name', s.lastName],
      ['dob', s.birth.iso],
      ['address_line1', s.street],
      ['city', s.city],
      ['zip', s.zip],
      ['phone', s.phone],
      ['email', s.email],
      ['ssn', s.formatValidSsn],
    ],
  },
];

export const rowRecipes: Recipe[] = SCENARIOS.flatMap((scenario) =>
  ROW_FORMATS.map((format) => ({
    format,
    name: scenario.name,
    count: 3,
    build: (index: number) => {
      const { rows, render } = RENDERERS[format];
      return render(Array.from({ length: rows }, () => scenario.row(makeSubject())), index);
    },
  })),
);
