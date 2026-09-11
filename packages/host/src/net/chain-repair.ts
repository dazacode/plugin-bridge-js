/**
 * Repairing a certificate chain a source under-sent, as a capability.
 *
 * ## The failure, in one paragraph
 *
 * TLS asks a server to present its leaf certificate *and* every intermediate
 * above it. A great many content sources present the leaf alone. Browsers and
 * curl paper over it — the leaf carries an Authority Information Access
 * extension naming a URL where its issuer can be downloaded, and both go and
 * fetch it — while Node's TLS stack does not, and neither does Bun's. So the
 * same source that loads in a tab fails in a server-side host with
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, and a perfectly good source is reported
 * as broken.
 *
 * ## Why it is an interface here rather than an implementation
 *
 * Fixing it means opening a raw TLS socket, reading an X.509 extension and
 * making a request with an amended trust store. None of that exists in a
 * browser, and a certificate stack is the single least portable thing a host
 * can own — so the relay, which must travel anywhere, states what it would
 * need and takes it from whoever runs it. `@plugin-bridge/host-node` supplies
 * the one implementation there is (`net/aia.ts`); a browser supplies none,
 * because in a browser the problem does not arise.
 *
 * A host that supplies nothing is a supported state, not a degraded one: the
 * relay then reports the transport failure it got, which is exactly what it
 * did before any repair existed.
 */

/** What a retried request needs to be made again, unchanged. */
export interface ChainRepairRetry {
	readonly method: string;
	readonly headers: Headers;
	readonly body: string | null;
	readonly signal: AbortSignal;
	readonly maxBytes: number;
}

export interface ChainRepair {
	/**
	 * Whether this failure is the one repairing a chain can fix.
	 *
	 * Asked before anything is spent, because most failures are *conclusions*
	 * — an expired certificate, a name mismatch, a host that does not resolve
	 * — and fetching another certificate cannot change any of them. Retrying
	 * those would only turn one clear failure into two slow ones.
	 */
	chainIsIncomplete(error: unknown): boolean;

	/** The certificates a host omitted, in PEM, or an empty array. */
	issuersFor(target: URL): Promise<string[]>;

	/**
	 * The request again, with those certificates added to the trust store.
	 *
	 * Verification stays on. The only thing that changes is that a certificate
	 * the server omitted is supplied from the URL the server's own certificate
	 * named — which is why this is not the same as trusting less.
	 */
	fetchTrusting(target: URL, extraCa: readonly string[], init: ChainRepairRetry): Promise<Response>;
}
