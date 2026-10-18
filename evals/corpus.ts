// The labelled detection corpus, generated deterministically.
//
// Every value is synthetic by provenance, never taken from a real record:
//   - people, streets and cities come from the seeded generator (@faker-js/faker, en_US);
//   - emails use reserved domains (example.com, example.org, .test), phones the fictional
//     555-0100 to 555-0199 range, IPs the documentation networks, URLs example.org;
//   - card numbers come from the published test list and are Luhn-valid;
//   - SSNs are either never issued (area 000 or 666, group 00 or serial 0000) or generated
//     to look issued, in two labelled sub-categories;
//   - dates, plates, VINs and account numbers are generated, and relative dates use a
//     fixed reference date.
// Each case seeds from its own id, so adding a case never changes another one.
import { caseProblem, type Case } from './case.ts';
import { flatten, type Recipe } from './compose.ts';
import { largeRecipes } from './large.ts';
import { messageRecipes } from './messages.ts';
import { negativeRecipes } from './negatives.ts';
import { rowRecipes } from './scenarios.ts';
import { seedFor } from './synthetic.ts';

// A draw can put a planted value inside another planted value or the surrounding text.
// Redrawing is deterministic because the seeded stream just continues.
const MAX_DRAWS = 50;

function generate(recipe: Recipe, index: number): Case {
  const id = `${recipe.format}/${recipe.name}-${String(index + 1).padStart(3, '0')}`;
  seedFor(id);
  let problem: string | undefined;
  for (let draw = 0; draw < MAX_DRAWS; draw++) {
    const candidate = { id, format: recipe.format, ...flatten(recipe.build(index)) };
    problem = caseProblem(candidate);
    if (problem === undefined) return candidate;
  }
  throw new Error(`${id}: no valid draw in ${MAX_DRAWS} attempts (${problem})`);
}

export function buildCorpus(): Case[] {
  return [...rowRecipes, ...messageRecipes, ...negativeRecipes, ...largeRecipes].flatMap((recipe) =>
    Array.from({ length: recipe.count }, (_, index) => generate(recipe, index)),
  );
}
