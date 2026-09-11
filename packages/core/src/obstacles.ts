/**
 * A refusal with an address on it.
 *
 * The translator has always known exactly why it stopped — `Untranslatable`
 * carries the construct, the member and the line — and every one of those
 * facts was thrown away one layer up. `ForeignFormatError` kept the deduped
 * *kinds*, because that is what the scoreboard ranks on, and the sentence a
 * person reads names members without lines and lines without files. So the
 * report could say "250 listings use `object_literal`" and could not say
 * *where*, and widening the translator started with a grep.
 *
 * This is the missing half: the same obstacles, each carrying the file, the
 * member, the line and the line's own text, so the next construct to support
 * can be read off the console instead of hunted for.
 *
 * It is a diagnostic and nothing else. Nothing decides anything on it, no
 * verdict changes because of it, and a caller that ignores it loses only
 * detail — which is the property that lets it be built cheaply on the failure
 * path and never on the success path.
 *
 * **Rule 9.** A site carries one line of somebody else's Kotlin, at runtime,
 * to a console. Anything URL-shaped in it is replaced before it goes anywhere,
 * on the same reasoning as `bucketMessage`: the construct is what makes this
 * useful and the address is what must not be written down.
 */

import type { KotlinConversion } from './kotlin/pipeline';
import type { Refusal } from './kotlin/subset';

/** One obstacle, with enough address to open a file at it. */
export interface ObstacleSite {
	/** The translator's own word for the construct: `object_literal`, `WebView`. */
	readonly kind: string;
	/** The file inside the extension's source it sits in. */
	readonly file: string;
	/** The member it sits in, or the file's own name for a header. */
	readonly member: string;
	/** 1-based, as an editor counts. */
	readonly line: number;
	/** That line, trimmed and redacted. Empty when the source was not to hand. */
	readonly text: string;
	/**
	 * Whether this is one of the refusals that stopped the conversion.
	 *
	 * A refused `getFilterList` is reported and does not block — `pipeline.ts`
	 * draws that line and this carries it, because a reader ranking work off a
	 * list where the two are mixed would spend an afternoon on a member the
	 * host never calls.
	 */
	readonly blocking: boolean;
}

/** How much of one line is worth carrying. Long enough for a real expression. */
const LINE_CAP = 160;

/**
 * One line of foreign Kotlin, reduced to what is safe and useful to print.
 *
 * Tabs become spaces because a console does not honour a tab stop the way the
 * file meant it, and everything URL-shaped becomes `<url>` — see the rule 9
 * note above. A bare quoted path (`"/search?q="`) is left alone: it is a
 * fragment, it names nothing, and redacting it would take the shape of the
 * request away from the person trying to see the shape of the request.
 */
export function redactLine(line: string): string {
	const flattened = line.replace(/\t/g, '    ').trim();
	const redacted = flattened
		.replace(/https?:\/\/[^\s"'`)]+/g, '<url>')
		.replace(/(["'`])\/\/[a-z0-9.-]+\.[a-z]{2,}[^"'`]*\1/gi, '$1<url>$1');
	return redacted.length > LINE_CAP ? `${redacted.slice(0, LINE_CAP - 1)}…` : redacted;
}

/**
 * Every obstacle in a conversion, addressed.
 *
 * Walks `refusals` rather than `perFile`, because `refusals` is the list the
 * verdict was computed from and a diagnostic that walked a different one could
 * disagree with it. `perFile` is consulted only to answer *which file*, by
 * object identity — the same `Refusal` objects are in both, so no name
 * matching is involved and two files declaring one member cannot be confused.
 *
 * The one refusal that is synthesised rather than emitted is the unparseable
 * class header, which appears in `refusals` and `blocking` as two separately
 * built objects and in no file's list at all. Its member *is* the path, so it
 * addresses itself; identity having failed, it falls back to matching on the
 * member name, which for that case is exact.
 */
export function obstacleSites(
	conversion: Pick<KotlinConversion, 'perFile' | 'refusals' | 'blocking'>,
	files: readonly { readonly path: string; readonly source: string }[]
): ObstacleSite[] {
	const lines = new Map<string, readonly string[]>();
	for (const file of files) lines.set(file.path, file.source.split('\n'));

	const fileOf = new Map<Refusal, string>();
	for (const one of conversion.perFile) {
		for (const refusal of one.refusals) fileOf.set(refusal, one.path);
	}

	const blocking = new Set(conversion.blocking);
	const blockingMembers = new Set(conversion.blocking.map((one) => one.member));

	const sites: ObstacleSite[] = [];
	for (const refusal of conversion.refusals) {
		const file = fileOf.get(refusal) ?? refusal.member;
		const source = lines.get(file);
		const stops =
			blocking.has(refusal) || (!fileOf.has(refusal) && blockingMembers.has(refusal.member));
		for (const obstacle of refusal.obstacles) {
			const text = source?.[obstacle.line - 1];
			sites.push({
				kind: obstacle.kind,
				file,
				member: refusal.member,
				line: obstacle.line,
				text: text === undefined ? '' : redactLine(text),
				blocking: stops
			});
		}
	}
	return sites;
}
