# Étape 6a — Démo : une session dans son propre processus

Branche : `mt/etape6a-worker`. Option **désactivée par défaut** ; une seule session en mode worker à la fois.

## Activer

- Réglages → clé `agent.sessionWorkerMode` = `true` (ou `PUT /api/settings/agent.sessionWorkerMode {"value":"true"}`), ou `OPENFOX_SESSION_WORKER=true` au démarrage.

## Scénario de démo (identique aux tests .122)

1. Lancer une session avec un tour long (ex. `sleep 300` via run_command). Le tour s'exécute dans un processus fils forké (`workerId`, `generation` persistés sur la session ; le PID ne sert jamais d'identité).
2. `kill -9 <pid du worker>`.
3. La gateway détecte la mort **par le handler `exit`** (pas de timeout) : la session passe « interrompue — reprendre » (`interrupted_at` persisté, visible via `GET /api/sessions/:id`), un message système propose la reprise, et `running.changed(false)` est réécrit pour qu'un redémarrage ne contourne pas la reprise explicite.
4. **Aucun orphelin** : les enfants exclusifs du worker (shell détachés) étaient enregistrés de façon synchrone dans `<db>.worker-<workerId>.children` ; la gateway tue chaque groupe de processus et supprime le fichier (`lastCrashReport.killedChildren` = preuve, visible en mode test via `GET /api/test/worker`).
5. Les MCP partagés et les LSP (processus gateway) ne sont jamais touchés : un appel d'outil MCP sur une autre session réussit juste après le crash.
6. **Reprise explicite uniquement** : `POST /api/sessions/:id/resume-interruption` (409 sinon). La continuation part du rappel « stream interrupted » — un outil au résultat inconnu n'est jamais rejoué à l'aveugle. La reprise s'exécute dans un nouveau worker, génération suivante : toute écriture de l'ancienne génération est rejetée par le fence transactionnel (`StaleWorkerGenerationError`).

## Vérifications

- `npx vitest run src/server/session/worker.test.ts` (fencing, Mac OK).
- `npx vitest run src/server/session/worker-crash.integration.test.ts` — **.122 uniquement**.
- `npx vitest run src/server/session/worker-cleanup.test.ts` — **.122 uniquement**.

## Limites connues (lot 6a)

- Tours chat simples uniquement : pas d'outils MCP dans le worker (connexions partagées détenues par la gateway), pas d'invite interactive (ask_user / confirmations de chemins) à travers l'IPC — ces sessions restent en-processus.
- Les sessions interrompues ne démarrent pas de tour automatiquement : les messages mis en file attendent la reprise explicite.
- Enfants exclusifs couverts : shells via `spawnShell`. Les spawns directs hors `spawnShell` (pty terminal, dev-server) ne sont pas encore enregistrés dans le sidecar.
