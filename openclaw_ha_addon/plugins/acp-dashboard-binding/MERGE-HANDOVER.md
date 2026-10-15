# Merge-Handover: Binding-Pack für 0.7.13.30 (→ Merge-Session f954d7b8)

Stand 2026-10-15. Diese Datei dokumentiert Branch-Endzustand, Szenarien-Audit und
verbleibende Risiken für die beauftragte Merge-Session. KEIN Push/Tag/Deploy von
dieser Seite (GaRoN-GO-Lage: Merge-Session führt aus).

## Branch: `feature/binding-native-unarchive`

Basierend auf Lokaler-HEAD = `3e75be2` (Writer-.30-Spitze: 532f8c8 → afe0e36 →
6f88503 → d79234e). **Kein Konflikt-Feld erwartet**: nur Binding-Plugin-Dateien
+ BRIDGE.md angefasst (Writer-Changelogs unberührt — siehe aber Release-Commit-Hinweis).

| Commit | Inhalt |
|---|---|
| 2650067 | §23 native-mode un-archive: Boot-Heal legacy γ-Stamps + keine Stamps in Native + Bootline-Korrektur |
| 0d3cd7e | §23.2/V39: Boot-Heal räumt `spawnedBy`-Over-Hiding-Stamps auf Clone-Grammatik (5 REAL-Sessions live befreit) |
| 2a8f631 | §24 Init-Race: bounded (10 s) Join der in-flight Provision an 4 async-Ingress-Grenzen |
| bbc6b8d | §24 Lücke: explizit gebundene Records joinen ebenfalls |

Suite: **231/231** (8 Dateien, `npx vitest run`). Doku: BRIDGE.md §23 + §23.6 + §24.

## Release-Commit-Hinweis (wichtig)

`d79234e chore(release): 0.7.13.30` ist auf main VOR diesen Commits → der
Release-Commit erwähnt die Binding-Fixes NICHT. Empfehlung: Changelog um §23/§24
erweitern + Release-Commit neu schneiden (ungetaggt, daher kostengünstig) ODER
Binding-Pack als eigene Release-Zeile .31. Entscheidung Merge-Session/GaRoN.

## Erwartetes Live-Verhalten beim nächsten Deploy/Boot (.29 → .30)

Boot-Log (nativer Modus aktiv):
1. `boot sweep settled …` — §19c Orphan-Settle (4 stuck-running Dashboard-Entries)
2. `native dispatch mode: un-archived 4 legacy γ stamp(s) …: …4fbefeb91c0aed3d, …4729694a…, …5b4952f6…, …5f3d7decc2ba19bb`
3. `native dispatch mode: cleared spawnedBy provenance on 5 overstamped work session(s) …: 60bac3d6, 4b5b8fbd, f13a1603, 5b4952f6, 5f3d7dec`
4. Bootline „clone auto-archive = off (default) … boot sweep un-archives legacy stamps (native)"

Danach: `/reset` auf Binding-Konversationen normal; `/compact`-Gate clean;
Listing zeigt die 5 REAL-Sessions (vorher falsch als Subagenten verhüllt).

## Verifikations-Punkte für die Merge-Session

1. `npx vitest run` (231/231) + BRIDGE.md §23/§24 lesen.
2. Dry-Run-Harness (echte Host-Module + reale Entries, read-only) — Methode in
   BRIDGE §23.6 beschrieben; bei Host-Update wieder ausführen.
3. Deploy → Boot-Log-Greps oben; danach ein Smoke: `/acp status` + `/reset` auf
   dem Main-Binding (60bac3d6) — muss ohne Archiv-Refusal laufen.

## Bekannte Restrisiken (dokumentiert, bewusst nicht in diesem Zug)

- **TW-Owner-Race** (18/18 deterministisch, KEIN Reply-Verlust — zstd): Host-Code,
  Upstream-Familie (#149801). Plugin bleibt richtig still.
- **Recovery-Reihenfolge Host-zuerst**: läuft `markStartupOrphanedMainSessionsForRecovery`
  VOR unserem §19c-Sweep, markiert der Host die stuck-Entries + Recovery-Turn;
  unser Sweep sieht dann nur `running` mit aktueller updatedAt → skip. Phantom-
  Re-Delivery kann dann einmalig auftreten (Live-Präzedenz 12:55). Nur Host-seitig
  zu beheben — unser Sweep entwaffet es in der Normalreihenfolge (gateway_start).
- **V39-Guard (Prävention, 2dd81d9)** ist NICHT im .28-Baseline: `stampSubagentProvenance`
  schreibt in Claim-Modus weiterhin ohne Grammatik-Guard. Optional aus 2dd81d9
  cherry-picken (nur den Guard-Anteil) — oder: in .30 Native ist das irrelevanter Pfad.
- **Slow Boot >120 s** (.26-erbe, healthz-Watchdog-Backlog) — unverändert.

## Verbote (unverändert)

Kein `git add -A`; REPAIR_STATUS.md NIEMALS committen; Live-/usr/lib nur lesen;
Live-DB-Writes nur mit per-Entry-Recheck; Commits enden auf
`Co-Authored-By: Claude Code <noreply@anthropic.com>`.
