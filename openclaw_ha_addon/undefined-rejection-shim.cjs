"use strict";
/**
 * 0.7.12.5-hotfix: Toleranter Umgang mit OpenClaw 2026.9.8-Exit-Politik.
 *
 * Hintergrund (Repo-Diagnose 2026-10-05): Der 9.8-Gateway beendet sich bei
 * JEDER unhandled rejection, deren reason nicht als "transient" klassifiziert
 * wird (dist/unhandled-rejections-*.mjs: exitWithTerminalRestore ->
 * process.exit(1)). Auf dem Pi blockiert der Chat-Start sporadisch die
 * Event-Loop (plugin-tools-Init 13-15 s, SQLite reclamation 14-25 s), und
 * genau waehrend dieser Blockade wird pro Chat-Start eine stille Promise mit
 * reason === undefined rejected -> sofortiger Gateway-Exit("Unhandled promise
 * rejection: undefined"). Der HA-Start-Loop startet neu, der naechste
 * Chat-Start crasht erneut.
 *
 * Dieser Preload-Shim registriert sich -- vor allen OpenClaw-Modulen -- in
 * der von OpenClaw selbst verwendeten Handler-Registry
 * (Symbol.for("openclaw.unhandledRejection.handlers")). Ein Handler, der
 * true zurueckgibt, markiert eine Rejection als "handled"; die 9.8-Politik
 * setzt dann KEINEN Exit. Strenge Begrenzung: NUR reason === undefined
 * wird gefiltert; alle anderen Rejections laufen unveraendert durch die
 * normale OpenClaw-Klassifikation (FATAL/CONFIG/transient/etc.).
 *
 * Vom Upstream als Bug bestätigt/Beantragt; entfernt mit nächstem 9.x-Fix.
 */
const KEY = Symbol.for("openclaw.unhandledRejection.handlers");
const g = globalThis;
if (!(g[KEY] instanceof Set)) {
  g[KEY] = new Set();
}
g[KEY].add(function isOpenClawUndefinedRejectionHandled(reason) {
  return reason === undefined;
});
