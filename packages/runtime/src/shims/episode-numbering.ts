/**
 * Episode numbers for a list in which some rows state one and some do not.
 *
 * Shared by the shims whose formats hand back an episode list with gaps in its
 * numbering. It was written for one of them first, and the rule it encodes —
 * a row with no number of its own is placed between its stated neighbours, so
 * it can never collide with one — is a property of numbering, not of that
 * format. Each caller decides only how a row *states* a number (a field, or its
 * own name read by the ecosystem's recognition), and which way a list with no
 * numbers at all is read.
 *
 * Literal source, as every shim fragment is: a bundle cannot import, and what
 * ships in one is what is reviewable here.
 */
export const EPISODE_NUMBERING = `
/**
 * Numbers for one list of episodes, in the order the source stated them, given
 * which rows stated a number of their own (\`null\` where one did not).
 *
 * Three rules, and the second and third exist because of the first.
 *
 * **A stated number is believed.** It is not a guess, and it is the number
 * every other client in the ecosystem shows for the same episode. Zero is an
 * answer, because a prologue numbered zero is a real episode.
 *
 * **A row that states nothing is placed between the rows that do.** It may not
 * simply be counted, because a count collides: eleven numbered episodes plus
 * one unnumbered extra, counted by position, hands that extra a number another
 * row already has, and two rows claiming the same episode is a wrong number in
 * front of a viewer. So it takes its number from its stated neighbours, shared
 * out by its position in the list, and continues the sequence by one step past
 * either end. The list's own order survives and nothing can land on a stated
 * number.
 *
 * **Only when nothing in the list states a number is the position the answer.**
 * Which end counts from one is the ecosystem's habit, not a fact this function
 * can read, so the caller says: \`'descending'\` for a format whose sites list
 * newest first, \`'ascending'\` for one whose lists run oldest first.
 */
function __placeEpisodeNumbers(stated, nameless) {
  const count = stated.length;
  let firstStated = -1;
  let lastStated = -1;
  for (let i = 0; i < count; i += 1) {
    if (stated[i] === null) continue;
    if (firstStated === -1) firstStated = i;
    lastStated = i;
  }

  const numbers = [];

  if (firstStated === -1) {
    for (let i = 0; i < count; i += 1) numbers.push(nameless === 'ascending' ? i + 1 : count - i);
    return numbers;
  }

  // Which way the stated numbers run in the list's own order: descending for a
  // newest-first listing, ascending for the other kind. Read from the first and
  // last statement rather than assumed, and falling back to newest-first when
  // there is only one statement to read.
  const step = stated[lastStated] > stated[firstStated] ? 1 : -1;

  const taken = [];
  for (let i = 0; i < count; i += 1) {
    numbers.push(stated[i]);
    if (stated[i] !== null) taken.push(stated[i]);
  }

  for (let i = 0; i < count; i += 1) {
    if (stated[i] !== null) continue;

    let before = -1;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (stated[j] !== null) { before = j; break; }
    }
    let after = -1;
    for (let j = i + 1; j < count; j += 1) {
      if (stated[j] !== null) { after = j; break; }
    }

    let local;
    let value;
    if (before !== -1 && after !== -1) {
      // Share the distance between two statements out by position, so a run of
      // unnamed rows stays in order and stays between them.
      let span = stated[after] - stated[before];
      // Two rows claiming the same number. Still move, or the fill lands on it.
      if (span === 0) span = step;
      local = span / (after - before);
      value = stated[before] + local * (i - before);
    } else if (before !== -1) {
      local = step;
      value = stated[before] + step * (i - before);
    } else {
      local = step;
      value = stated[after] - step * (after - i);
    }

    const placed = __freeEpisodeNumber(value, local, taken);
    numbers[i] = placed;
    taken.push(placed);
  }

  return numbers;
}

/**
 * \`value\`, moved off any number another row already has.
 *
 * Reachable only from a list the source made strange — two rows naming the same
 * episode with an unnamed one between them, say. The shift is halves of the
 * local step, so the row creeps toward the row after it without ever reaching
 * or passing it: each try is a new number, the sequence converges, and the
 * list's order survives the repair.
 */
function __freeEpisodeNumber(value, local, taken) {
  let candidate = value;
  let shift = local / 2;
  for (let guard = 0; guard < 24; guard += 1) {
    if (taken.indexOf(candidate) === -1) return candidate;
    candidate = candidate + shift;
    shift = shift / 2;
  }
  return candidate;
}
`;
