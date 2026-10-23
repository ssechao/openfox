# Étape 6a — Critères (worker de session, premier lot)

Branche : `mt/etape6a-worker` (depuis `origin/mt/etape5-runtime`, 77669b20).
Périmètre : une session dans son propre processus, **option explicite désactivée par défaut**, une seule session en mode worker à la fois. Voir [plan-multithread.md](plan-multithread.md) § Étape 6, lot 6a.

## Critère 1 — Worker isolé avec fencing worker+génération

Une session peut être lancée dans un processus fils (option explicite, désactivé par défaut, une à la fois) ; le worker est identifié par (workerId, génération) et non par le PID seul ; une écriture/événement d'une génération périmée est rejetée (aucune double exécution après réutilisation de PID) ; un outil à effet externe dont le résultat est inconnu après plantage n'est jamais rejoué à l'aveugle (reprise explicite uniquement).

**Vérification :** `npx vitest run src/server/session/worker.test.ts` (run ciblé autorisé sur le Mac).

## Critère 2 — Détection du plantage et reprise

Avec `OPENFOX_MOCK_LLM`, une session tourne dans son worker ; après `kill -9` du processus worker, la gateway détecte la mort (handler exit, pas de timeout long), marque la session « interrompue » (état persisté en base, visible via API) et propose « reprendre » ; les autres sessions continuent de fonctionner (une session témoin répond toujours).

**Vérification :** `npx vitest run src/server/session/worker-crash.integration.test.ts` — **exécuté sur la .122 uniquement** (`scripts/test-remote.sh` ou hook pre-commit), jamais sur le Mac (kill -9 / processus).

## Critère 3 — Nettoyage prouvé après kill -9

Les enfants exclusifs du worker (shell, process-group détaché) sont tués (plus aucun orphelin : pgrep ne retrouve ni le PID ni le groupe), tandis que les MCP partagés de la gateway et les LSP restent vivants et fonctionnels (un appel d'outil MCP sur une autre session réussit après le plantage) ; le test produit la preuve du nettoyage (aucun processus résiduel).

**Vérification :** `npx vitest run src/server/session/worker-cleanup.test.ts` — **exécuté sur la .122 uniquement** (`scripts/test-remote.sh` ou hook pre-commit), jamais sur le Mac (kill -9 / processus).

## Hors périmètre / limites (lot 6a)

Le worker est réservé aux tours chat utilisant uniquement les outils intégrés. Les outils MCP (connexions partagées détenues par la gateway) ne sont pas enregistrés dans le worker, et les invites interactives (`ask_user`, confirmations de chemin) ne sont pas relayées via l'IPC. Une session nécessitant des outils MCP ou des invites interactives n'est pas supportée en worker ; elle doit rester en-processus.
