import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { openPluginArchive } from '../archive';
import { packageBundle } from '../package';
import { measurementPrelude } from '@plugin-bridge/runtime/shims/measurement';
import { loadKotlinGrammar, type KotlinParser } from './grammar';
import { granted, measurementGrants, setMeasurementGrants } from './grants';
import { convertKotlin } from './pipeline';

/** The vendored artefacts, read the way a host reads them; see `pipeline.spec.ts`. */
async function vendorWasm(name: string): Promise<Uint8Array> {
	const { readFile } = await import('node:fs/promises');
	const { fileURLToPath } = await import('node:url');
	return new Uint8Array(
		await readFile(fileURLToPath(new URL(`./vendor/${name}`, import.meta.url)))
	);
}

let parser: KotlinParser;

beforeAll(async () => {
	parser = await loadKotlinGrammar(vendorWasm);
}, 60_000);

// Process state, so every test leaves it as a host would find it.
afterEach(() => setMeasurementGrants([]));

const WEBVIEW = [
	'class Demo : HttpSource() {',
	'    override val baseUrl = "https://example.invalid"',
	'    override fun popularMangaRequest(page: Int) = GET(baseUrl)',
	'    override fun popularMangaParse(response: Response): MangasPage {',
	'        val view = WebView(context)',
	'        return MangasPage(emptyList(), false)',
	'    }',
	'}'
].join('\n');

async function bundle(): Promise<Uint8Array> {
	return await packageBundle({
		id: 'org.example.measured',
		name: 'Measured',
		description: 'A bundle built under a grant.',
		version: '1.0.0',
		author: 'example',
		hosts: ['example.invalid'],
		origin: {
			format: 'mihon',
			artifactUrl: 'https://example.invalid/a.apk',
			foreignId: 'measured',
			foreignVersion: '1',
			mediaKind: 'manga',
			isNsfw: false
		},
		entrypointSource: 'export default {};'
	});
}

describe('measurement grants', () => {
	it('are off unless a measuring process turns them on', () => {
		expect(measurementGrants()).toEqual([]);
		expect(granted('WebView')).toBe(false);
		expect(measurementPrelude()).toBe('');
	});

	it('refuse a name that is not a grant, rather than measuring the baseline under it', () => {
		expect(() => setMeasurementGrants(['webviews'])).toThrow(/Not a boundary grant: webviews/);
		expect(measurementGrants()).toEqual([]);
	});

	it('set aside exactly the refusals that name their boundary', async () => {
		const refused = await convertKotlin([{ path: 'Demo.kt', source: WEBVIEW }], { parser });
		expect(refused.complete).toBe(false);

		setMeasurementGrants(['image']);
		expect((await convertKotlin([{ path: 'Demo.kt', source: WEBVIEW }], { parser })).complete).toBe(
			false
		);

		setMeasurementGrants(['webview']);
		const measured = await convertKotlin([{ path: 'Demo.kt', source: WEBVIEW }], { parser });
		expect(measured.complete).toBe(true);
	});

	it('mark every bundle packaged under them, and a host will not open one', async () => {
		setMeasurementGrants(['webview']);
		const measured = await bundle();
		// The measuring process can read what it built…
		const opened = await openPluginArchive(measured);
		expect(new TextDecoder().decode(opened.files.get('measurement.json')!)).toContain('webview');

		// …and no other process can.
		setMeasurementGrants([]);
		await expect(openPluginArchive(measured)).rejects.toMatchObject({
			rejection: 'measurementBuild'
		});
		// A bundle built with none on is untouched by any of it.
		expect((await openPluginArchive(await bundle())).files.has('measurement.json')).toBe(false);
	});

	it("define the image group's classes as stand-ins that throw naming the boundary", async () => {
		setMeasurementGrants(['image']);
		const source = `${measurementPrelude()}\nexport const read = () => Bitmap.createBitmap(1, 1);\nexport const loaded = typeof Canvas;`;
		const module = (await import(
			/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
		)) as { read(): unknown; loaded: string };
		expect(module.loaded).toBe('function');
		expect(() => module.read()).toThrow(/built to measure a boundary, and reached it: Bitmap/);
	});
});
