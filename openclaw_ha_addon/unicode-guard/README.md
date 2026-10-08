# unicode-guard — Kontextsensitives Invisible-Unicode-Stripping

**OWASP LLM01:2026 Control #5** · Prompt-Injection-/Smuggling-Abwehr am External-Content-Pfad des OpenClaw-Gateways · Add-on-Build-Patch seit 2026-10-08 (Spec: `agents/prompt-engineer/findings/2026-10-08-owasp-a-unicode-stripping-spec.md` · Audit: `agents/coding-review/findings/2026-10-08-owasp-a-audit.md`)

## Bedrohungsmodell (warum das existiert)

Unsichtbare Unicode-Zeichen transportieren Instruktionen und Exfiltrations-Payloads durch Rendering-Grenzen: Modelle lesen Tag-Zeichen (U+E0000–U+E007F), isolierte Variation Selectors (U+FE00–U+FE0F), Zero-Width-Spaces und Word Joiner — während Mensch und UI nichts sehen. Belegte Angriffe (Rehberger 2024/2025, M365-Copilot-PoCs) exfiltrieren Daten allein durch das Rendern präparierter Inhalte, z. B. über präparierte Seitentitel in Suchergebnissen. Betroffen ist hier der External-Content-Ingest-Pfad: `web_fetch`/`web_search`-Outputs, Email-, Webhook-, Cron-, Browser- und Channel-Metadaten, die als Tool-Results in Prompts gerendert werden — im Gateway-Prozess **und** in den vom Gateway gespawnten Worker-Prozessen (Audit F1: `dist/worker/worker.mjs` enthält u. a. Email/Webhook-Hook-Session-Logik, `wrapExternalContent`, `buildSafeExternalPrompt`).

OpenClaw 2026.9.8 stripte bereits an der `web_fetch`-Extraktion — aber mit einer naiven Zeichenklassen-Streiche (`INVISIBLE_UNICODE_RE`), die (a) U+200D (ZWJ) immer entfernte und damit gültige Emoji-Sequenzen wie 👨‍👩‍👧 zerstörte und (b) isolierte Variation Selectors U+FE00–U+FE0F vollständig unberücksichtigt ließ (Smuggling-Lücke). `web_search`-Ergebnisse wurden gar nicht gestrippt. Die naiven Kopien existieren **vierfach** im dist-Baum: Top-Level-Modul, Gateway-Bundle und eigenständige Kopien in beiden großen Worker-Bundles (Audit-Beleg).

## Gewählter Mechanismus

Add-on-Build-Patch (Dockerfile, heredoc-Pattern wie beim node-llama-cpp-Patch) gegen die OpenClaw-dist; der Patch ersetzt **jede** naive Kopie und erweitert die Anwendung auf **jede** External-Content-Ingest-Grenze — Gateway-Prozess und Worker-Prozesse:

1. **Patch-Site A — `stripInvisibleUnicode`, ALLE 4 Kopien:** Top-Level-Modul (`unicode-visibility-*.mjs`), inline im Gateway-Bundle **und** die minifizierten eigenständigen Kopien in `dist/worker/worker.mjs` + `dist/worker/sqlite-store.worker.mjs` werden durch die kontextsensitive Implementierung aus [`strip-invisible-unicode.mjs`](strip-invisible-unicode.mjs) ersetzt (Single Source of Truth; der Patch spliced die `//#region` byte-identisch ein — auch in die Worker, die keine Top-Level-Module importieren). Wirkt an allen Call-Sites: `web_fetch`-Extraktion (Text/Title), Progress-Card-Input, Worker-seitige Hook-Session-/Transcript-Projektionen.
2. **Patch-Site B — `sanitizeExternalContentText`, ALLE 4 Kopien:** ruft zusätzlich `stripInvisibleUnicode()` auf. Diese Funktion ist der Trichter für ALLE wrapExternalContent/wrapWebContent-Konsumenten: `web_search`-Resultate (Titles, Snippets, Site-Names, Answer-Content, Citations, Error-Messages — alle Branches), `web_fetch`-Content/Spill, Email/Webhook/Cron/Browser/Channel-Metadaten inkl. Metadata-Felder (sender/subject/taskName) — im Gateway-Bundle wie in den Worker-Kopien.

**Design-Entscheidung (Audit F1):** Option „Worker-Bundles aktiv patchen" statt „Known-Exceptions-Liste". Begründung: worker.mjs enthält nachgewiesen erreichbaren External-Content-Boundary-Code (hook:gmail/webhook-Session-Logik, CRON_DIRECT_DELIVERY) — eine dokumentierte Lücke wäre eine reale Lücke; die Inventur ist endlich (4+4 Sites, namensbasiert verifiziert); die minify-toleranten Regex-Anchor erfassen beliebige Parameternamen; das Portierungsrisiko schlägt laut-failend zu Buche, nie still.

**Universalitäts-Sweep (Audit F1, das Verifikations-Axiom):** Nach dem Patchen läuft ein rekursiver Sweep über den **gesamten** dist-Baum (`.mjs`+`.js`, alle Subdirs). Er failt den Build **laut** (exit 1 mit Dateiliste), wenn IRGENDEIN Naivrest beider Targets überlebt — auch form-gedriftete Kopien, die kein Patch-Anchor mehr erkennt: Strip-Call-Marker (`.replace(INVISIBLE_UNICODE_RE,…)`), Strip-Definitions-≠-Impl-Zähler, naive-sanitize-Form und sanitize-Definitions-≠-gepatchter-Call-Zähler. Coverage ist ein Allquantor, kein Existenzquantor: ein Control verschwindet nie still.

`apply-unicode-guard-patch.mjs` ist idempotent, assertiert exakte Anchor (byte-exakt mit Tab-Semantik für Top-Level; whitespace-/parametertolerant für Minified-Kopien) und prüft jede gepatchte Datei mit `node --check`. Gateway-Config (`openclaw.json`) wird von diesem Mechanismus nicht benötigt.

## Gestrippte Bereiche (immer — kein legitimer rendering-relevanter Kontext)

| Codepoints | Name | Rationale |
|---|---|---|
| U+200B | Zero Width Space | Klassischer Smuggling-Träger; invisibles Trennzeichen |
| U+200C | ZWNJ (Zero Width Non-Joiner) | Smuggling-Träger — s. Tradeoffs unten |
| U+200E, U+200F | LRM / RLM | Unsichtbare Richtungssteuerung |
| U+202A–U+202E | Bidi-Controls (LRE, RLO …) | Trojan-Source-/Bidi-Override-Vektor |
| U+2060–U+2064 | Word Joiner, Invisible Operatoren | Unsichtbare Verbindungen (Core-Parität) |
| U+206A–U+206F | Deprecated Format Characters | Unsichtbar (Core-Parität) |
| U+FEFF | BOM / Zero Width No-Break Space | Unsichtbares Trennzeichen |
| **U+E0000–U+E007F** | **Tag-Block (komplett, inkl. ASCII-Tag-Kombinationen)** | Stärkster belegter Smuggling-Kanal (PoC: „SYSTEM"-Anweisungen als Tag-Zeichen); ASCII a–z spiegelt sich in U+E0061–U+E007A |

## Kontextsensitive Ausnahmen (Pflicht laut Spec: Emoji-Qualität ist Akzeptanzkriterium)

| Erhalten | Bedingung | Beispiele |
|---|---|---|
| **U+FE0F (VS16)** — und alle U+FE00–U+FE0F | unmittelbar davor liegt eine Extended_Pictographic-Emoji-Base (`\p{Extended_Pictographic}`) | ❤️ (U+2764 U+FE0F), ☺️, ⚠️ |
| **U+FE0F/VS** in Keycaps | davor `#`, `*` oder `0`–`9` UND danach U+20E3 (Combining Enclosing Keycap) | 1️⃣, #️⃣, *️⃣ |
| **U+200D (ZWJ)** | davor: Emoji-Base (direkt, über VS oder über Skin-Tone-Modifier U+1F3FB–U+1F3FF) UND danach: Emoji-Base | 👨‍👩‍👧, ❤️‍🔥, 👨🏻‍⚕️, 🏳️‍🌈 |

Isolierte VS **ohne** gültige Base (auch VS15 U+FE0E, auch U+FE0F nach U+FE0F — malformed doubling) und ZWJ **außerhalb** gültiger Sequenzen werden strippen. Die Sequenz-Bewertung nutzt die Originaltext-Nachbarschaft; Strip-Entscheidungen früherer Zeichen heben keine späteren gültigen Kontexte (isolierte Kandidaten fallen komplett).

## Dokumentierte Tradeoffs (bewusst in Kauf genommen)

- **Subdivision-Flags** (🏴󠁧󠁢󠁥󠁮󠁧󠁿 England, 🏴󠁥󠁣󠁳󠁴󠁿 Schottland): Ihre Tag-Zeichen liegen im Tag-Block und werden — Spec: „komplett, inkl. ASCII-Tag-Kombinationen" — immer entfernt; übrig bleibt 🏴. Nutzen vs. Risiko: Flags sind selten, der Tag-Block der stärkste dokumentierte Angriffskanal.
- **ZWNJ (U+200C), Pfad-Differenzierung (Audit F3):** wird überall bedingungslos entfernt. **web_fetch-Pfad:** Parität zu OpenClaw 2026.9.8 — die naive Core-Regex `\u200B-\u200F` enthielt U+200C, kein neuer Qualitätsregress. **Funnel-Pfade (web_search, Email, Webhook, Cron, Browser, Channel-Metadaten):** dort lief vor dem Patch **gar kein** Strip (reines Pass-Through), das ZWNJ-Stripping ist also NEU und spec-gewollt (§2 listet U+200C) — persische/arabische Snippets verlieren ZWNJ auf diesen Pfaden neu. Emoji-Belange: ZWNJ ist Teil keiner RGI-Emoji-Sequenz.
- **CJK Standardized Variation Sequences** (U+FE00–U+FE0F nach Nicht-Emoji-Basen, z. B. seltenere Glyphvarianten): fallen weg — OWASP-Leitlinie priorisiert das Schließen des VS-Smuggling-Kanals; RGI-Emoji bleiben vollständig intakt.
- **Nicht-String-Input** wird unverändert durchgereicht statt (wie im Original) zu werfen — defensiver, kein Aufrufer verlässt sich auf den TypeError.

## Residuale Kanäle (bewusst, dokumentiert — Audit F4)

Der Strip ist Core-parität für Bereiche, die OpenClaw 2026.9.8 ebenfalls nicht erfasste und die daher weiterhin durchreichen (kein Spec-Verstoß; Erweiterung gehört in den Upstream-PR, nicht stillschweigend in den Patch):

- **U+2066–U+2069** (LRI/RLI/FSI/PDI, Bidi-Isolate — Trojan-Source-Vektor), **U+061C** (Arabic Letter Mark), **U+180B–U+180E** (Mongolische FVS), **U+2000–U+200A** (unsichtbare Spaces) — empirisch bestätigt unverändert.
- **VS16-nach-Emoji-Base als Payload-Kanal:** Vektor 3/6 erzwingen den Erhalt von U+FE0F nach gültiger Base (❤️); An-/Abwesenheit von VS16 nach einer Base kann Bits tragen — by-design Tradeoff Emoji-Qualität > Restkanal (Kapazität gering, die Base bleibt sichtbar).

## Performance

Fast-Path: ein einziger nicht-globaler Scan-Regex (`/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}]/u`) erkennt sauberen Text und gibt ihn **per Referenz** unverändert zurück (keine Allokation, kein Copy). Verschmutzter Text: ein Linear-Pass mit codePointAt, Strip-Entscheidungen nur an targeted Positionen. Messwerte s. Test „Vektor 7" (57 KB sauber: Mikrosekunden-Bereich; verschmutzt: einstellige Millisekunden auf dem Pi5).

## Tests

```bash
node --test openclaw_ha_addon/unicode-guard/strip-invisible-unicode.test.mjs
```

15 Tests: Vektoren 1–8 gemäß Spec §3, Randfälle (invalide ZWJ-Kontexte, Formatierungszeichen-Parität, URLs, Umlaute, Idempotenz, Nicht-String-Input) und optionale Dist-Verifikation. Gegen die **gepatchten** OpenClaw-Module (unicode-visibility, external-content, echte `web_fetch`-Extraktion, Worker-Bundle-Splices byte-identisch + naiv-rest-frei) läuft die Dist-Verifikation:

```bash
UNICODE_GUARD_DIST_TEST_DIR=/tmp/oc-guard-test node --test openclaw_ha_addon/unicode-guard/strip-invisible-unicode.test.mjs
```

## Pflege & Update-Sicherheit

- **OpenClaw-Upgrade:** `apply-unicode-guard-patch.mjs` läuft im Build nach `npm install -g openclaw@<version>`. Patch-Anchor nicht gefunden, Zähler-Asserts verletzt oder Universalitäts-Sweep-Fund → Build failt **laut** mit Dateiliste → Patch muss aufs neue dist-Layout portiert werden (update-openclaw-ha-addon-Skill). Nie still überspringen: ein still fehlendes Patch = still verlorene Security-Control.
- **Anchor-Quellen (jeweils 4 Kopien je Target, namensbasiert inventarisiert):** `stripInvisibleUnicode` in `dist/unicode-visibility-*.mjs`, inline im Gateway-Bundle und minifiziert in `dist/worker/worker.mjs` + `dist/worker/sqlite-store.worker.mjs`; `sanitizeExternalContentText` in `dist/external-content-*.mjs`, inline im Bundle und in denselben Workern. Byte-exakte Anchor (Tabs signifikant) für die Top-Level-Kopien; whitespace-/parametertolerante Regex-Anchor (Backreference, erfasster Minify-Parameter wird im Replacement wiederverwendet) für die Worker-Kopien. Dateinamen sind inhaltsgehasht — der Patch sucht per Inhalt und rekursiv, nicht per Top-Level-Dateiname.
- **Import-Binding (Audit F2):** die Sanitize-Patch-Stelle erhält `stripInvisibleUnicode` entweder aus einer lokalen gepatchten Definition (Bundles, Worker) oder aus einem injizierten Import mit **exaktem Binding** `import { t as stripInvisibleUnicode } from "./unicode-visibility-<hash>.mjs"` — ein Import eines anderen Symbols zählt nicht als Binding (sonst Laufzeit-ReferenceError statt Build-Fail).
- **Live-Patch:** `node apply-unicode-guard-patch.mjs <openclaw-dir> --backup` erzeugt `.oc-unicode-guard.bak`-Sicherungen (nur nach GaRoN-GO + Audit; Standardpfad ist der Build).
- **Langfristig:** gehört upstream (github.com/openclaw/openclaw) — `strip-invisible-unicode.mjs` ist als Beitrag formliert; der Build-Patch entfällt, sobald der Fix nativ ist. Der Universalitäts-Sweep failt dann **bewusst** (Definition ohne `unicodeGuard`-Impl-Marker) und erzwingt die Patchblock-Entfernung — das ist der intendierte Entscheidungs-Trigger, kein Bug.