# Démo — Étape 3 : plus d’appels bloquants dans les routes

Branche `mt/etape3-async` (depuis `origin/mt/etape2-verrou` 948f9d72). Référence du 2026-10-21, chiffres C3 du 2026-10-22.

## Référence avant correctif

Incident production (instance 450, 2026-10-21) : l’outil `workspace` a duré 227 s et a gelé l’instance pendant environ 110 s (`execSync` du setup).

Mesure contrôlée sur `origin/mt/etape2-verrou`, même capteur `setTimeout(20)` que l’étape 1 :

| Opération                          | Durée    | Retard du minuteur 20 ms |
| ---------------------------------- | -------- | ------------------------ |
| `execSync('sleep 2')`              | 2 295 ms | 2 295 ms                 |
| `fs.promises.rm` de 5 000 fichiers | 2 970 ms | 21 ms                    |

## Commandes

```bash
npx vitest run src/server/git/workspace.test.ts
npx vitest run src/server/utils/permissions.test.ts src/server/utils/project-creator.test.ts src/server/dev-server/inspect-proxy.test.ts
npx vitest run --config e2e/vitest.config.ts e2e/workspace-nonblocking.demo.test.ts
```

Linux : Docker `node:24-bookworm` sur `ssechao@192.168.71.122` (le seuil ≤ 100 ms n’est affirmé que là).

## Résultats

| Critère                                          | macOS (worktree)    | Linux (.122 Docker)         |
| ------------------------------------------------ | ------------------- | --------------------------- |
| C1 `workspace.test.ts`                           | 41/41               | 41/41                       |
| C2 permissions / project-creator / inspect-proxy | 36/36               | 36/36                       |
| C3 `workspace-nonblocking.demo.test.ts`          | 2/2 ×5 (sans seuil) | 2/2 ×5, surcoût médian 0 ms |

## Chiffres C3

Mesures du 2026-10-22, qui remplacent celles du 2026-10-21 (fenêtres non disjointes).

Méthode : un minuteur `setTimeout(20)` dédié dans le serveur de démo (route `/api/health/loop-delay`, active seulement hors production avec `OPENFOX_DEMO_LOOP_PROBE=1`) renvoie le retard maximal observé depuis la lecture précédente, puis repart de zéro. Le test lit cette valeur aux bornes de trois phases disjointes et contiguës :

1. `create` : `switch-workspace` (clone, puis setup qui écrit 5 000 fichiers et `sleep 1`) ;
2. `delete` : `delete-workspace` ;
3. référence : aucune opération, pendant une durée égale à `create` + `delete`.

La sonde `/sante`, `/api/diagnostics` et `/api/health` (toutes les 200 ms) tourne pendant les trois phases. Surcoût = max(`create`, `delete`) − référence. Charge = moyenne sur 1 min (`uptime` ; dans le conteneur, `/proc/loadavg`, qui reflète l’hôte) relevée avant chaque exécution.

### Linux (.122, Docker `node:24-bookworm`, 24 cœurs, 5 exécutions consécutives)

| Exécution | Charge 1 min | Référence | `create` | `delete` | Surcoût | Durée create | Durée delete |
| --------- | ------------ | --------- | -------- | -------- | ------- | ------------ | ------------ |
| 1         | 0,39         | 5,5 ms    | 4,2 ms   | 1,0 ms   | −1,3 ms | 1 199 ms     | 54 ms        |
| 2         | 0,51         | 1,6 ms    | 4,3 ms   | 1,9 ms   | 2,7 ms  | 1 159 ms     | 50 ms        |
| 3         | 0,71         | 1,5 ms    | 3,8 ms   | 0,2 ms   | 2,4 ms  | 1 161 ms     | 50 ms        |
| 4         | 0,74         | 1,5 ms    | 1,4 ms   | 0,2 ms   | −0,2 ms | 1 160 ms     | 49 ms        |
| 5         | 0,76         | 1,3 ms    | 1,4 ms   | 0,6 ms   | 0,0 ms  | 1 161 ms     | 50 ms        |

Médiane du surcoût : **0,0 ms** (maximum 2,7 ms) ; pic absolu sous charge ≤ 4,3 ms ; charge médiane 0,71. Le seuil ≤ 100 ms est tenu à chaque exécution, sans sonde en timeout (2 s) ni en erreur.

### macOS (worktree, Mac mini 14 cœurs, macOS 26.2, Node 25.6.1, 5 exécutions consécutives)

| Exécution | Charge 1 min | Référence  | `create`   | `delete`   | Surcoût    | Phase du pic | Durée create | Durée delete |
| --------- | ------------ | ---------- | ---------- | ---------- | ---------- | ------------ | ------------ | ------------ |
| 1         | 12,02        | 2 575,4 ms | 3 356,0 ms | 132,7 ms   | 780,6 ms   | create       | 36 175 ms    | 8 099 ms     |
| 2         | 14,91        | 2 164,4 ms | 6 595,1 ms | 1 463,0 ms | 4 430,8 ms | create       | 45 978 ms    | 10 655 ms    |
| 3         | 15,09        | 406,8 ms   | 2 047,4 ms | 13,6 ms    | 1 640,5 ms | create       | 15 804 ms    | 1 888 ms     |
| 4         | 10,52        | 155,0 ms   | 1 590,7 ms | 1 704,0 ms | 1 549,0 ms | delete       | 14 555 ms    | 6 874 ms     |
| 5         | 13,96        | 216,8 ms   | 761,7 ms   | 1 091,0 ms | 874,2 ms   | delete       | 14 782 ms    | 5 928 ms     |

Médiane du surcoût : **1 549,0 ms** ; charge médiane 13,96 pour 14 cœurs (de 10,52 à 15,09). D’autres sessions saturaient déjà la machine : la référence au repos monte jusqu’à 2,6 s et les durées varient d’un facteur 3. Cette mesure ne sépare pas la contention CPU (git et le `node` du setup en concurrence avec le serveur) d’un éventuel blocage ; le surcoût macOS est donc consigné sans seuil, comme le prévoit le critère. L’exécution 2 compte 2 sondes en timeout (10 s), non affirmées sur macOS.

HOME, config et `OPENFOX_DB_PATH` temporaires, ports ≥ 10630, `lsof` sans fichier sous `~/Library/Application Support/openfox*`.

Une suppression annulée ou expirée lève `WorkspaceDeleteIncompleteError` : des fichiers peuvent rester ; un nouvel appel à `deleteWorkspace` termine le nettoyage.
