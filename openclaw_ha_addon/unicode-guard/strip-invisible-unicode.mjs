// [openclaw-ha-addon unicode-guard v1] Context-sensitive invisible-Unicode stripping.
//
// Implements OWASP LLM01:2026 Control #5 for the External-Content ingest path:
// web_fetch/web_search results and every wrapExternalContent() boundary
// (email, webhook, API, browser, channel metadata) before content is rendered
// into a model prompt.
//
// Replaces OpenClaw's naive `INVISIBLE_UNICODE_RE` char-class strip, which
// (a) always removed U+200D ZWJ and thereby destroyed valid ZWJ emoji
//     sequences such as 👨‍👩‍👧 (U+1F468 U+200D U+1F469 U+200D U+1F467), and
// (b) never removed isolated variation selectors U+FE00–U+FE0F, which are a
//     documented invisible-Unicode smuggling channel.
//
// Canonical implementation for the add-on build patch. `apply-unicode-guard-patch.mjs`
// splices the `//#region` block below verbatim into the OpenClaw dist bundle
// at build time; this file is the single source of truth for that code.
//
// Behavior contract — see README.md (test vector 8) for the full matrix:
//   * Strip, always: U+200B, U+200C, U+200E, U+200F (LRM/RLM), U+202A–U+202E,
//     U+2060–U+2064, U+206A–U+206F, U+FEFF, and the complete Tag block
//     U+E0000–U+E007F (including ASCII tag combinations).
//   * Strip U+200D (ZWJ) only outside valid emoji sequences.
//   * Strip U+FE00–U+FE0F (VS1..VS16) only without a valid emoji base before.
//   * Keep U+FE0F/U+FE0E after an Extended_Pictographic base (e.g. ❤️) and in
//     keycap sequences (#|*|0-9 + VS + U+20E3, e.g. 1️⃣).
//   * Keep U+200D when it joins emoji bases (optionally via a variation
//     selector or a skin-tone modifier, e.g. 👨🏻‍⚕️, ❤️‍🔥, 🏳️‍🌈).
//   * Everything else — visible text, umlauts, accents, valid emoji — unchanged.
//
// Idempotent: strip(strip(x)) === strip(x). Fast path: a single non-global
// regex scan returns clean input untouched (no allocation), so a ≥50 KB web
// article pays no measurable overhead (test vector 7).

//#region openclaw-ha-addon-unicode-guard-impl
// [openclaw-ha-addon unicode-guard v1] Context-sensitive invisible-Unicode stripping (OWASP LLM01:2026 Control #5).
const UNICODE_GUARD_SCAN_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}]/u;
const UNICODE_GUARD_EXT_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;
function unicodeGuardIsEmojiBase(codePoint) {
	return UNICODE_GUARD_EXT_PICTOGRAPHIC_RE.test(String.fromCodePoint(codePoint));
}
function unicodeGuardIsSkinToneModifier(codePoint) {
	return codePoint >= 0x1F3FB && codePoint <= 0x1F3FF;
}
function unicodeGuardIsKeycapAscii(codePoint) {
	return codePoint === 0x23 || codePoint === 0x2A || (codePoint >= 0x30 && codePoint <= 0x39);
}
/** Code point that ends immediately before `endIndex` (surrogate-pair aware), or undefined. */
function unicodeGuardPrevCodePoint(text, endIndex) {
	if (endIndex <= 0) return void 0;
	const prev = text.charCodeAt(endIndex - 1);
	if (prev >= 0xDC00 && prev <= 0xDFFF && endIndex >= 2) {
		const high = text.charCodeAt(endIndex - 2);
		if (high >= 0xD800 && high <= 0xDBFF) return text.codePointAt(endIndex - 2);
	}
	return prev;
}
/** Code point starting at `index`, or undefined past the end. */
function unicodeGuardNextCodePoint(text, index) {
	if (index >= text.length) return void 0;
	return text.codePointAt(index);
}
/** Keep a variation selector only behind a valid emoji base (or inside a keycap sequence). */
function unicodeGuardKeepVariationSelector(text, index) {
	const prev = unicodeGuardPrevCodePoint(text, index);
	if (prev === void 0) return false;
	if (unicodeGuardIsEmojiBase(prev)) return true;
	if (unicodeGuardIsKeycapAscii(prev)) {
		const next = unicodeGuardNextCodePoint(text, index + 1);
		return next === 0x20E3;
	}
	return false;
}
/** Keep ZWJ only when it joins an emoji base/VS/skin-tone element with a following emoji base. */
function unicodeGuardKeepZwj(text, index) {
	const prev = unicodeGuardPrevCodePoint(text, index);
	if (prev === void 0) return false;
	let base = prev;
	if (prev >= 0xFE00 && prev <= 0xFE0F) {
		const before = unicodeGuardPrevCodePoint(text, index - 1);
		if (before === void 0) return false;
		base = before;
	}
	if (!(unicodeGuardIsEmojiBase(base) || unicodeGuardIsSkinToneModifier(base))) return false;
	const next = unicodeGuardNextCodePoint(text, index + 1);
	return next !== void 0 && unicodeGuardIsEmojiBase(next);
}
/** Targeted code points that are always stripped: no legitimate context exists. */
function unicodeGuardIsAlwaysStrip(codePoint) {
	return (
		(codePoint >= 0x200B && codePoint <= 0x200F) ||
		(codePoint >= 0x202A && codePoint <= 0x202E) ||
		(codePoint >= 0x2060 && codePoint <= 0x2064) ||
		(codePoint >= 0x206A && codePoint <= 0x206F) ||
		codePoint === 0xFEFF ||
		(codePoint >= 0xE0000 && codePoint <= 0xE007F)
	);
}
/**
 * Remove invisible-Unicode smuggling characters from `text` while preserving
 * visible text and valid emoji sequences (VS16 and ZWJ contexts).
 * Non-string input is returned unchanged (defensive; original threw).
 */
function stripInvisibleUnicode(text) {
	if (typeof text !== "string" || text.length === 0) return text;
	if (!UNICODE_GUARD_SCAN_RE.test(text)) return text;
	let out = "";
	let flushFrom = 0;
	let strippedAny = false;
	for (let index = 0; index < text.length; ) {
		const codePoint = text.codePointAt(index);
		const width = codePoint >= 0x10000 ? 2 : 1;
		if (codePoint === 0x200D) {
			if (!unicodeGuardKeepZwj(text, index)) {
				out += text.slice(flushFrom, index);
				flushFrom = index + 1;
				strippedAny = true;
			}
		} else if (codePoint >= 0xFE00 && codePoint <= 0xFE0F) {
			if (!unicodeGuardKeepVariationSelector(text, index)) {
				out += text.slice(flushFrom, index);
				flushFrom = index + 1;
				strippedAny = true;
			}
		} else if (unicodeGuardIsAlwaysStrip(codePoint)) {
			out += text.slice(flushFrom, index);
			flushFrom = index + width;
			strippedAny = true;
		}
		index += width;
	}
	if (!strippedAny) return text;
	return out + text.slice(flushFrom);
}
//#endregion

export { stripInvisibleUnicode };