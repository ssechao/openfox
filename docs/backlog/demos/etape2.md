# Démo — Étape 2 : une seule instance par base

Mesures prises le 2026-10-21 sur le worktree `mt/etape2-verrou` (HOME, config et
`OPENFOX_DB_PATH` temporaires, ports ≥ 10620).

## Commandes

```bash
npx vitest run src/server/db/instance-lock.test.ts
npx vitest run src/server/session/provider-reconcile.test.ts
npx vitest run --config e2e/vitest.config.ts e2e/instance-collision.test.ts
```

## Résultats

| Critère                         | Commande                                        | Résultat                                                                                         |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| C1 Verrou noyau                 | `src/server/db/instance-lock.test.ts`           | 9/9 pass (deux processus concurrents, symlink, SIGKILL puis deux repreneurs, échec d'init)       |
| C2 Réconciliation conservatrice | `src/server/session/provider-reconcile.test.ts` | 7/7 pass (config vide, 1 provider inconnu, orphelin isolé, suppression explicite, base sans pin) |
| C3 Incident reproduit           | `e2e/instance-collision.test.ts`                | 4/4 pass                                                                                         |

## Chiffres C3

Dernière exécution isolée de `e2e/instance-collision.test.ts` (2026-10-21 19:49) :

| Grandeur                  | Valeur                               |
| ------------------------- | ------------------------------------ |
| Durée totale du fichier   | 49,47 s de tests (53,11 s wall)      |
| Refus de B (message PID)  | 13,58 s                              |
| kill -9 de A puis reprise | 13,64 s (dont sonde de verrou < 2 s) |

Le verrou est un fcntl noyau (`locking_mode=EXCLUSIVE` sur `<db>.instance-lock`).
Après `SIGKILL`, une sonde dédiée réacquiert le verrou en moins de 2 s ; le
redémarrage complet de l'instance réussit ensuite. B s'arrête avec
`base déjà utilisée par l'instance PID …`. A reste à HTTP 200, conserve
`provider_id` / `provider_model`, et la session reste `isRunning`.

## Contrat gateway / workers

Documenté dans `src/server/db/instance-lock.ts` :

- la gateway détient le verrou ;
- les seq sont attribuées par l'écrivain unique d'une session (`UNIQUE(session_id, seq)`) ;
- un worker écrit ses propres événements avec un jeton remis par la gateway ;
- la gateway invalide ses caches sur notification ;
- un worker n'exécute jamais les remises à zéro globales (`is_running`, réconciliation, maintenance).
