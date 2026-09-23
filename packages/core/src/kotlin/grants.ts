/**
 * Measurement grants: setting a deliberate boundary aside to count what it
 * costs, in a process that is measuring and in no other.
 *
 * `docs/phase-2-capability-map.md` is the method: grant a native capability,
 * re-measure the catalogue, and the difference is what that boundary is
 * worth. That is how every "keep refused" in this repository was decided, and
 * it has to stay repeatable as the translator improves, because a boundary
 * that cost fourteen listings when the translator was young may cost sixty
 * once everything around it converts.
 *
 * A grant does **not** implement the capability. It stops refusing the
 * constructs that need it, so the rest of the extension is translated and the
 * bundle can be counted; the construct itself becomes a value that throws,
 * naming the grant, if it is ever reached. A bundle built that way loads and
 * cannot work, which is precisely the plugin this converter exists never to
 * produce — so it is marked, and only a measuring process will open it:
 *
 * - Grants are off unless `setMeasurementGrants` turns them on. Nothing in
 *   the library does; the catalogue command does, on `--grant`.
 * - A bundle packaged while any is on carries `measurement.json`, listed and
 *   hashed like every other member, so a bundle that lost it fails the
 *   integrity check rather than opening as an ordinary plugin.
 * - `openPluginArchive` refuses a bundle carrying it unless the process
 *   opening it has grants on too. A host never does.
 *
 * Each group is matched against the refusal's own *kind* — the sentence a
 * refusal names — so a grant sets aside exactly the refusals that name its
 * boundary and nothing else.
 */

/** A boundary that can be set aside for a measurement. */
export type BoundaryGrant = 'webview' | 'js-engine' | 'cookie-store' | 'image';

/** What a group's refusals are called. Kept to names; see the header. */
const GROUPS: Readonly<Record<BoundaryGrant, RegExp>> = {
	// A WebView, and the settings and callbacks that only exist on one.
	webview:
		/WebView|webView|runWebView|addJavascriptInterface|WebSettings|WebViewClient|evaluateJavascript/,
	// An embedded JavaScript engine asked to run what it was handed.
	'js-engine':
		/embedded JavaScript engine|QuickJs|Duktape|Rhino|`\.evaluate\(\)`|evaluateJavascript/,
	// Reading the WebView's cookie store: an anti-bot clearance, usually.
	'cookie-store': /WebView cookie store|CookieManager|getCookie|reading a cookie jar/,
	// Android's graphics stack and the byte streams an image is read through:
	// what a page-descrambling interceptor is written in. `ABI.md` §8.4.
	image: new RegExp(
		'`\\.?(?:' +
			[
				'Bitmap',
				'BitmapFactory',
				'Canvas',
				'Rect',
				'RectF',
				'Paint',
				'TextPaint',
				'StaticLayout',
				'Typeface',
				'LineBreaker',
				'ImageDecoder',
				'ByteArrayOutputStream',
				'drawBitmap',
				'drawText',
				'drawColor',
				'drawRect',
				'compress',
				'recycle',
				'decodeStream',
				'decodeByteArray',
				'createBitmap',
				'createScaledBitmap',
				'getPixels',
				'setPixels',
				'getPixel',
				'setPixel',
				'measureText',
				'getTextBounds',
				'setShadowLayer',
				'decodeBitmap',
				'createSource',
				'readByteArray',
				'readIntLittleEndian',
				'readUShortLittleEndian',
				'readIntBigEndian',
				'writeIntLittleEndian',
				'byteStream',
				'inputStream',
				'outputStream',
				'asResponseBody'
			].join('|') +
			')(?:\\(\\)|\\(…\\)|\\.|`)'
	)
};

/** The globals the image group's code names, defined as throwing stand-ins. */
export const IMAGE_GRANT_GLOBALS: readonly string[] = [
	'Bitmap',
	'BitmapFactory',
	'Canvas',
	'Rect',
	'RectF',
	'Paint',
	'TextPaint',
	'StaticLayout',
	'Typeface',
	'LineBreaker',
	'ImageDecoder',
	'ByteArrayOutputStream'
];

/** Every grant there is, in a stable order. */
export const BOUNDARY_GRANTS: readonly BoundaryGrant[] = Object.keys(GROUPS) as BoundaryGrant[];

let active: readonly BoundaryGrant[] = [];

/**
 * Turns grants on for this process, or off with an empty list.
 *
 * Throws on a name that is not a grant, rather than ignoring it: a
 * measurement taken with a misspelled grant would report the baseline under
 * the grant's name.
 */
export function setMeasurementGrants(grants: readonly string[]): void {
	const unknown = grants.filter((grant) => !(grant in GROUPS));
	if (unknown.length > 0) {
		throw new Error(
			`Not a boundary grant: ${unknown.join(', ')}. The grants are ${BOUNDARY_GRANTS.join(', ')}.`
		);
	}
	active = BOUNDARY_GRANTS.filter((grant) => grants.includes(grant));
}

/** The grants on in this process; empty everywhere but a measurement. */
export function measurementGrants(): readonly BoundaryGrant[] {
	return active;
}

/** Whether a refusal of this kind is set aside by a grant that is on. */
export function granted(kind: string): boolean {
	return active.some((grant) => GROUPS[grant].test(kind));
}
