# Démo — Étape 2 : une seule instance par base

Mesures du 2026-10-21. HOME, config et `OPENFOX_DB_PATH` temporaires, ports ≥ 10620.

## Commandes

```bash
npx vitest run src/server/db/instance-lock.test.ts
npx vitest run src/server/session/provider-reconcile.test.ts
npx vitest run --config e2e/vitest.config.ts e2e/instance-collision.test.ts
```

Linux : Docker `node:24-bookworm` sur `ssechao@192.168.71.122` (pas de VM locale).

## Résultats

| Critère                         | macOS (worktree) | Linux (.122 Docker) |
| ------------------------------- | ---------------- | ------------------- |
| C1 `instance-lock.test.ts`      | 13/13            | 13/13               |
| C2 `provider-reconcile.test.ts` | 7/7              | 7/7 (hook)          |
| C3 `instance-collision.test.ts` | 4/4              | 4/4                 |

## Chiffres C3

| Grandeur                                      | macOS    | Linux  |
| --------------------------------------------- | -------- | ------ |
| Refus de B, verrou seul (`refuseMs`)          | 815 ms   | 106 ms |
| Refus de B, process complet (`fullStartupMs`) | 4 793 ms | 757 ms |
| Exit code de B (sans SIGKILL)                 | 1        | 1      |
| Réacquisition du verrou après `kill -9`       | 400 ms   | 84 ms  |
| Redémarrage complet de A                      | 6 531 ms | 753 ms |

B s'arrête tout seul (`exit 1`) avec, sur stderr :
`database already in use by instance PID … : <db>. Use that instance, or stop PID …`.
A reste HTTP 200, `provider_id` / `provider_model` et `isRunning` intacts.

Rapport JSON : `ETAPE2_DEMO_REPORT=<file>`.

## Contrat gateway / workers

Dans `src/server/db/instance-lock.ts` :

- la gateway détient le verrou ;
- les seq sont attribuées par l'écrivain unique d'une session (`UNIQUE(session_id, seq)`) ;
- un worker écrit ses propres événements avec un jeton remis par la gateway ;
- la gateway invalide ses caches **après commit**, sur notification du worker ;
- si une invalidation est perdue, reconnexion du worker → resynchronisation par seq / révision ;
- un worker n'exécute jamais les remises à zéro globales (`is_running`, réconciliation, maintenance).
