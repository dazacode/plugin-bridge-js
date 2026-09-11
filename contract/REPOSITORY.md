# Plugin repositories

How a plugin reaches a device. Normative, versioned by `schemaVersion`; this
describes **version 1**.

Rule 9 applies. No repository is named here, and none may be added — kuro ships
with **zero** repositories configured, and a user adds every one themselves.

---

## 1. Two ways in, deliberately

|                | What it is                                   | When                                              |
| -------------- | -------------------------------------------- | ------------------------------------------------- |
| **Sideload**   | A `.yorozoplugin` file the user opens        | Developing, or a plugin nobody publishes          |
| **Repository** | A URL the user adds, holding an `index.json` | Everything else, and the only one that can update |

Both end in the same verification and the same consent screen. A repository is
not a privileged channel; it is a bookmark that also knows about new versions.

There is no default repository and no bundled list. A build of kuro that shipped
one would be a build that ships a source, which rule 9 forbids and which is the
difference between a client and a distributor.

---

## 2. `index.json`

```json
{
	"schemaVersion": 1,
	"name": "Example plugins",
	"updatedAt": "2026-09-07",
	"signingKey": "MCowBQYDK2VwAyEA…",
	"plugins": [
		{
			"id": "com.example.plugins.example",
			"name": "Example",
			"description": "…",
			"version": "1.0.0",
			"author": "Example Co",
			"license": "Apache-2.0",
			"yorozoPluginApi": 1,
			"minimumYorozoVersion": "0.1.0",
			"platforms": ["android", "ios", "macos", "windows", "linux", "web"],
			"capabilities": ["search", "episodes", "resolve"],
			"permissions": ["network", "storage"],
			"hosts": ["api.example.com", "*.cdn.example.com"],
			"language": "en",
			"download": "https://…/example-1.0.0.yorozoplugin",
			"sha256": "9f2c8a1d…",
			"size": 41231
		}
	]
}
```

Everything the **consent screen** needs is in the index, so a user decides
whether to install _before_ anything is downloaded. `permissions` and `hosts`
in particular: "this plugin may talk to these six hosts and nothing else" is the
one sentence that makes an informed answer possible, and asking after the
download has already happened is asking too late.

The entry is a **claim**. It is checked against the archive's own `plugin.json`
after download, and a disagreement aborts the install (§4). An index that
under-reports a plugin's permissions is the attack this exists to stop.

### `signingKey`

Optional, base64 SPKI Ed25519. See §5.

---

## 3. Resolving a URL

A user pastes something. The host tries, in order, and takes the first that
returns a valid index:

1. The URL itself, if it ends in `.json`.
2. `<url>/index.json`.
3. For a GitHub repository URL — `https://github.com/<owner>/<repo>` — the
   latest release's `index.json` asset, then
   `https://raw.githubusercontent.com/<owner>/<repo>/<default branch>/index.json`.

The GitHub case is spelled out because it is what people will actually paste,
and because "paste the raw URL of the JSON file on the default branch" is a
sentence no user should have to be told. `github.com/owner/repo` is the thing
in the address bar.

**https only**, at every hop, including redirects and every `download`. A
cleartext index is one anybody on the path can rewrite, and rewriting an index
is enough to install anything.

---

## 4. Installing

In order, and every step aborts the install rather than warning:

1. **Fetch** the archive from `download`. https only.
2. **Hash** it. `sha256` must match the index entry. This is the check that
   makes a compromised mirror useless without a compromised index.
3. **Open** the ZIP, refusing traversal (`../`), absolute paths, symlinks, and
   any entry larger than the declared total. A malicious archive that writes
   outside its own directory is the oldest bug in this format.
4. **Verify `integrity.json`** — every file's SHA-256, then the canonical
   digest. The bytes that run are the bytes that were packaged.
5. **Verify `signature.json`**, if the repository pinned a key (§5).
6. **Compare** the archive's `plugin.json` against the index entry: `id`,
   `version`, `permissions` and `network.hosts` must agree. The consent the
   user gave was to the index's claims.
7. **Check compatibility** — API level, minimum version, platform — with a
   distinct, user-readable reason for each refusal.
8. **Ask.** Show name, version, author, permissions and the full host list.
   Nothing is installed without this, including an update that widens
   permissions (§6).
9. **Write** it, atomically: unpack to a temporary directory, verify, then move.
   A half-written plugin directory that a later launch tries to load is worse
   than a failed install.

**`settings` is not compared, and is not a permission.** Step 6 holds the
archive to the index's claims about `id`, `version`, `permissions` and
`network.hosts` — the four things the consent screen in step 8 renders. A
manifest's `settings` block is none of those: it says what the host will _draw_
on the plugin's behalf (`ABI.md` §1), and drawing a row grants nothing. What a
value chosen in one of those rows may do is bounded by `network.hosts`, which
_is_ compared and _is_ consented to — a setting can choose among the hosts
granted there and cannot add one (`ABI.md` §2). So an index need not carry
`settings`, a mismatch is not an install refusal, and the archive's own
declaration is what the host renders after the install.

---

## 5. Trust, honestly

Signing is real: `yorozo package --key` produces an Ed25519 signature and the host
verifies it. What signing does _not_ answer on its own is **which key**, and an
app-store-style answer (a curated list, a key server, a review process) is a
thing this project does not have and should not pretend to.

So the trust anchor is **the repository URL the user chose**, and the model is
trust-on-first-use, the same as SSH's `known_hosts`:

- Adding a repository pins its `signingKey`, if it has one, and shows its
  fingerprint.
- Every later fetch from that repository must verify against the pinned key.
  A **changed key is an error**, not a prompt with a default — a key rotation
  and a compromise look identical, and the safe reading is the second one. The
  user removes and re-adds the repository, deliberately, and sees the new
  fingerprint when they do.
- A repository with **no** key installs on integrity alone, and the host says
  so plainly at add time and at install time. That is a real and legitimate
  choice for a repository someone runs for themselves; it is not the same as
  a signed one and must not be displayed as though it were.

**Being listed in a repository means nothing about safety.** The host must
never present an index entry as vetted, verified or trusted. What is verified is
that the bytes came from the URL the user chose, unaltered. The permissions
screen is where safety is decided, by the person installing.

There is no revocation list. There is no way to distribute one yet. Saying so is
better than a mechanism that does not work.

---

## 6. Updates

A repository is re-fetched on demand — never on a timer, never in the
background, because a client that phones a source list home on a schedule is a
client with a network fingerprint its user did not ask for.

An update is an install: same verification, same comparison, same screen.

**An update that widens `permissions` or `network.hosts` requires fresh
consent**, shown as a diff against what is installed. Silently inheriting the
old answer is how a plugin a user approved for one host ends up talking to
twenty.

---

## 7. Uninstalling

Removes the bundle, the values the viewer chose for its settings, and its
`ctx.storage`. A setting left behind would be re-adopted by a reinstall nobody
configured.

It also invalidates every `SourceBinding` for that plugin — which is a cache
eviction, not user data. The library, history and progress key on canonical
metadata ids (rule 1) and are untouched. A source dying must not damage what the
user built, and this is where that promise is either kept or broken.
