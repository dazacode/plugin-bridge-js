/**
 * Matches the settings the extracted code was written under.
 *
 * Not cosmetic: two theme specs read their own module's source text and look
 * for `'key'`, so a quote style that disagreed with the code would rewrite the
 * thing under test. The repository this came from used these; so does this one.
 */
export default {
	useTabs: true,
	singleQuote: true,
	trailingComma: 'none',
	printWidth: 100
};
