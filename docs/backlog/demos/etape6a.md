# Étape 6a — Démo : une session dans son propre processus

Branche : `mt/etape6a-worker`. Option **désactivée par défaut** ; une seule session en mode worker à la fois.

## Activer

- Réglages → clé `agent.sessionWorkerMode` = `true` (ou `PUT /api/settings/agent.sessionWorkerMode {"value":"true"}`), ou `OPENFOX_SESSION_WORKER=true` au démarrage.

## Scénario de démo

1. Lancer une session avec un tour long (ex. `sleep 300` via `run_command`). Le tour s'exécute dans un processus fils forké (`workerId`, `generation` persistés sur la session ; le PID ne sert jamais d'identité).
2. `kill -9 <pid du worker>`.
3. La gateway détecte la mort **par le handler `exit`** (pas de timeout) : la session passe « interrompue — reprendre » (`interrupted_at` persisté, visible via `GET /api/sessions/:id`), un message système propose la reprise, et `running.changed(false)` est réécrit pour qu'un redémarrage ne contourne pas la reprise explicite.
4. **Aucun orphelin** : toute création d'enfant exclusif réserve d'abord une entrée dans `<db>.worker-<workerId>.children`, puis y finalise immédiatement le PID et son identité de démarrage. La gateway déduplique par `(pid,startIdentity)`, tue les groupes survivants même si leur processus racine est déjà sorti et supprime le sidecar. `lastCrashReport.killedChildren`, exposé en mode test par `GET /api/test/worker`, en fournit la preuve.
5. Les MCP partagés restent dans la gateway. Un LSP lancé par un worker est au contraire un enfant exclusif suivi : Stop le ferme proprement ; après SIGKILL du worker, la gateway le tue depuis le sidecar. Le test d'intégration vérifie les deux chemins.
6. **Reprise explicite uniquement** : `POST /api/sessions/:id/resume-interruption` (409 sinon). La continuation part du rappel « stream interrupted ». Chaque appel d'outil au résultat inconnu produit un état durable `tool.reconciliation_required` ; tant qu'il n'est pas résolu par `POST /api/sessions/:id/reconcile-tools`, tout nouvel outil à effet est refusé et les outils en lecture seule restent disponibles. La reprise s'exécute dans un nouveau worker, génération suivante : toute écriture de l'ancienne génération est rejetée par le fence transactionnel (`StaleWorkerGenerationError`).
7. Dès le début d'un arrêt de gateway, les admissions worker sont fermées. Le worker actif est interrompu et son settlement est traité comme un crash, jamais comme une réussite susceptible de lancer un tour mis en file.

## Démo mesurée sur .122

Le script reproductible est `scripts/demo-etape6a.ts`. Depuis le checkout synchronisé sur `.122`, il s'exécute dans l'image Linux de test :

```bash
docker run --rm --user node -v /tmp/openfox-etape6a-worker-fix:/work -w /work node:24-bookworm npx tsx scripts/demo-etape6a.ts
```

Mesure UTC du 2026-10-23 sur `.122` ; sortie standard exacte :

```text
2026-10-23T17:55:19.273Z event=worker_launched elapsed_ms=1654 launch_ms=488 generation=1 worker_pid=87
2026-10-23T17:55:19.273Z event=sigkill_sent elapsed_ms=1654 worker_pid=87
2026-10-23T17:55:19.519Z event=interrupted_observed elapsed_ms=1900 detection_ms=246 pending_reconciliations=1
2026-10-23T17:55:19.525Z event=resume_response elapsed_ms=1906 status=200
2026-10-23T17:55:19.959Z event=resume_completed elapsed_ms=2340 resume_ms=440 effect_bytes=1 duplicate_refused=true pending_reconciliations=1
2026-10-23T17:55:19.977Z event=stop_worker_launched elapsed_ms=2359 launch_ms=6 generation=1 worker_pid=176
2026-10-23T17:55:19.979Z event=stop_response elapsed_ms=2360 status=200
2026-10-23T17:55:20.427Z event=worker_stopped elapsed_ms=2808 stop_ms=450 worker_alive=false
```

Cette trace prouve que le premier effet reste unique (`effect_bytes=1`), que la répétition est refusée tant que la réconciliation reste pendante, que la reprise est explicite et que Stop élimine effectivement son worker.

## Vérifications

- `npx vitest run src/server/session/worker.test.ts` (fencing, Mac OK).
- `npx vitest run src/server/session/worker-crash.integration.test.ts` — **.122 uniquement**.
- `npx vitest run src/server/session/worker-cleanup.test.ts` — **.122 uniquement** ; couvre shell, groupe orphelin et LSP sur Stop/SIGKILL.

## Limites connues (lot 6a)

- Tours chat simples uniquement : pas d'outils MCP dans le worker (connexions partagées détenues par la gateway), pas d'invite interactive (ask_user / confirmations de chemins) à travers l'IPC. Le mode worker n'est prévu que pour les sessions qui n'ont besoin que des outils intégrés ; une session nécessitant des outils MCP ou des invites interactives n'est pas supportée en worker et doit rester en-processus.
- Les sessions interrompues ne démarrent pas de tour automatiquement : les messages mis en file attendent la reprise explicite.
- Enfants exclusifs couverts : shells via `spawnShell` et LSP lancés dans le worker. Les spawns directs hors de ces chemins (pty terminal, dev-server) ne sont pas encore enregistrés dans le sidecar.
