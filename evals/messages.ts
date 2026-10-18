// Patient demographics as an HL7 v2 ADT message and as a FHIR Patient resource.
import { compose, type Recipe } from './compose.ts';
import { makeSubject } from './synthetic.ts';

export const messageRecipes: Recipe[] = [
  {
    format: 'hl7',
    name: 'pid',
    count: 5,
    build() {
      const s = makeSubject();
      return compose`MSH|^~\\&|REG|HOSP|EHR|HOSP|20261001120000||ADT^A01|MSG0001|P|2.3
PID|1||${s.mrn}^^^HOSP^MR||${s.lastName}^${s.firstName}||${s.birth.compact}|F|||${s.street}^^${s.city}^TX^${s.zip}||${s.phone}|||||${s.patientAccount}|${s.formatValidSsn}`;
    },
  },
  {
    format: 'fhir',
    name: 'patient',
    count: 5,
    build() {
      const s = makeSubject();
      return compose`{
  "resourceType": "Patient",
  "id": "example",
  "identifier": [
    { "system": "http://hospital.example.org/mrn", "value": "${s.mrn}" },
    { "system": "http://hl7.org/fhir/sid/us-ssn", "value": "${s.formatValidSsn}" }
  ],
  "name": [{ "family": "${s.lastName}", "given": ["${s.firstName}"] }],
  "telecom": [
    { "system": "phone", "value": "${s.phone}" },
    { "system": "email", "value": "${s.email}" }
  ],
  "birthDate": "${s.birth.iso}",
  "address": [{ "line": ["${s.street}"], "city": "${s.city}", "postalCode": "${s.zip}" }]
}`;
    },
  },
];
