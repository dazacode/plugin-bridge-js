/**
 * Matches a host against one manifest pattern.
 *
 * Identical to `PluginStore.hostMatchesPattern` in Dart and to the SDK's test
 * harness: a single leading `*.` matches one or more leading labels, so
 * `*.cdn.example.com` covers `a.cdn.example.com` but **not**
 * `cdn.example.com` itself, and never `evilcdn.example.com`. Three subtly
 * different host matchers would be three different answers to "may this plugin
 * talk to that server", which is why this lives on its own: the sandbox asks it
 * before a plugin may fetch, and `/api/stream` asks it again before the proxy
 * will relay — and a server route may not import the sandbox to get it.
 */
export function hostMatches(host: string, pattern: string): boolean {
	const target = host.toLowerCase();
	const rule = pattern.toLowerCase();
	if (!rule.startsWith('*.')) return target === rule;
	const suffix = rule.slice(1);
	return target.endsWith(suffix) && target.length > suffix.length;
}
