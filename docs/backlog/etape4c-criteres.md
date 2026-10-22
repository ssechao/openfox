# Lot 4c — Critères (cache des instantanés)

Planner : session courante, titre Aether « Planner 4c cache ». Ticket `1ed948f6`. Révision : 2026-10-22. Aucun code écrit.

Périmètre 4c : dimensionner le cache `EventStore.snapshotCache` existant. Limite configurable ; métriques hits / misses / octets / évictions visibles sur `/api/diagnostics` et la page Santé ; le plafond d’octets est respecté après chaque insertion ; une entrée ne retient pas le JSON brut **et** l’objet parsé. Lot autonome : on instrumente et on borne le cache actuel, on ne le réécrit pas.

Hors périmètre : LRU (l’ordre d’insertion Map actuel suffit), refonte du hot path, FTS5 (4b), blobs (4a), compaction des snapshots, prompts cache.

Référence plan : `docs/backlog/plan-multithread.md` § Étape 4 / 4c. Ancien ticket : `1ed948f6`.

Base acceptée : `origin/main` (`034e3c9f` = prod).

Worktree de build (pas encore créé) :

```bash
git worktree add ~/Source/github.com/OpenFoxFork-mt-etape4c -b mt/etape4c-cache origin/main
npx husky
git config openfox.testRemote ssechao@192.168.71.122
```

État actuel (`034e3c9f`) : `SNAPSHOT_CACHE_MAX_ENTRIES = 16`, `SNAPSHOT_CACHE_MAX_BYTES = 128 MiB`, constantes de classe. Hits / misses seulement si `OPENFOX_SNAPSHOT_DIAGNOSTICS=1`. Pas de compteur d’évictions. `snapshotCacheBytes` n’est pas exposé. Les sessions `isRunning` restent épinglées (inchangé).

---

## 3 critères (une commande chacun)

### C1 — Plafond réel, métriques toujours à jour, pas de double rétention

Commande :

```bash
npx vitest run src/server/events/store-snapshot-cache.test.ts
```

- **Limite configurable** : option constructeur **et** env `OPENFOX_SNAPSHOT_CACHE_MAX_BYTES` / `OPENFOX_SNAPSHOT_CACHE_MAX_ENTRIES`. Défaut inchangé : 128 MiB / 16. Option > env > défaut. Valeurs ≤ 0 ou non numériques → défaut.
- **Plafond d’octets** : après `cacheSnapshot` / `evictSnapshots`, la somme des `bytes` des sessions **inactives** est ≤ la limite. Un payload plus gros que la limite n’est **pas** gardé (miss au GET suivant). Les sessions `isRunning` restent épinglées (test `store-hot-path.test.ts` « active snapshots bypass capacity eviction » reste vert).
- **Plafond d’entrées** : même règle sur le nombre d’entrées inactives.
- **Métriques toujours actives** (indépendantes de `OPENFOX_SNAPSHOT_DIAGNOSTICS`) : `hits`, `misses`, `bytes` (somme courante), `evictions` (capacité seulement : dépassement d’entrées ou d’octets). Invalidation d’écriture, `clearSnapshotCache`, `deleteSession` **ne comptent pas** comme évictions. Compteurs persistants jusqu’à `resetDiagnostics` / process.
- **Pas de double rétention** : l’entrée cache détient l’objet parsé (immutable) et sa taille ; elle ne conserve pas la chaîne JSON du payload en plus. Test : après un GET qui peuple le cache, aucune référence depuis l’entrée vers `row.payload` / string JSON du snapshot.
- Tests unitaires : dépassement d’octets → éviction + compteur ; payload > limite → non conservé ; hits/misses sur GET répété ; env + option ; épinglage running inchangé. Bases temporaires seulement.

### C2 — Santé : hits, misses, octets, évictions, limite

Commande :

```bash
npx vitest run src/server/diagnostics/snapshot-cache-health.test.ts web/src/components/health/SantePage.test.tsx
```

- `/api/diagnostics` expose le cache (noms stables, unités) :
  - `snapshotCacheHits` (count, cumul)
  - `snapshotCacheMisses` (count, cumul)
  - `snapshotCacheBytes` (bytes, jauge courante)
  - `snapshotCacheEvictions` (count, cumul capacité)
  - `snapshotCacheLimitBytes` (bytes, jauge = limite configurée)
- Le collecteur lit ces jauges à chaque tick, comme `runningSessions`. Les compteurs cumulatifs ne sont **pas** des percentiles et ne s’effacent pas avec la fenêtre 10 s.
- Page Santé (`/sante`) : une carte par métrique, `data-testid="sante-series-<nom>"`, libellés FR/EN :
  - en : Snapshot cache hits / misses / bytes / evictions / limit
  - fr : Cache instantanés hits / misses / octets / évictions / limite
- Auth inchangée (401 sans jeton). Séries étape 1 conservées. Test UI : payload fictif → les cinq cartes affichent valeur et unité.

### C3 — Démo corpus : mémoire sous la limite configurée

Commande :

```bash
npx vitest run --config e2e/vitest.config.ts e2e/snapshot-cache.demo.test.ts
```

Le test unique vérifie :

1. **Corpus** : `docs/backlog/corpus/generate.mjs` (même générateur 4a-1 / 4b, graine fixe) écrit dans un tmp. Snapshot lourd ~107 Mio **plus 6 sessions moyennes (~5 Mio chacune)**. Pas 236 Mio dans git. Les moyennes sont ajoutées par le test (même base tmp), sessions arrêtées (`isRunning: false`).
2. **Instance isolée** : `e2e/utils/health-server-child.ts`, HOME / XDG / `OPENFOX_DB_PATH` sous `os.tmpdir()`, `OPENFOX_MOCK_LLM`, plafond **< snapshot lourd** : `OPENFOX_SNAPSHOT_CACHE_MAX_BYTES=16777216` (16 Mio) et `OPENFOX_SNAPSHOT_CACHE_MAX_ENTRIES=4` (ou équivalent option). 3 × 5 Mio = 15 Mio ≤ 16 Mio ; la 4e moyenne évince.
3. **Charge** :
   - les **6 sessions moyennes** : `GET /api/sessions/:id` **deux fois** chacune (froid puis chaud) → hits, misses et évictions se font **sur elles** ;
   - la **session lourde (~107 Mio)** : `GET /api/sessions/:id` → **miss, non conservée** (payload > limite). Un second GET reste un miss. `snapshotCacheBytes` ne saute pas à 107 Mio.
4. **Après charge**, `GET /api/diagnostics` :
   - `snapshotCacheBytes.value` ≤ `snapshotCacheLimitBytes.value` (16 Mio)
   - `snapshotCacheLimitBytes.value === 16777216`
   - `snapshotCacheEvictions.value` ≥ 1 (évictions des moyennes, pas de la lourde)
   - `snapshotCacheHits.value` ≥ 1 et `snapshotCacheMisses.value` ≥ 1 (moyennes ouvertes 2 fois)
5. **Jamais la base live.** `lsof` : 0 fichier sous `~/Library/Application Support/openfox`. Rapport JSON optionnel (`SNAPSHOT_CACHE_DEMO_REPORT=<file>`).

---

## Contraintes communes

- Jamais la base live (`~/Library/Application Support/openfox/sessions.db`). Corpus et tests en tmp, comme 4a-1 / 4b.
- Pas de refonte : `evictSnapshots` (Map insertion order + épinglage running) reste le mécanisme. On rend la limite configurable, on compte, on expose.
- `docs/backlog/` est dans `.git/info/exclude` : forcer le fichier (`git add -f`) comme `etape4a1-criteres.md`.
- Build dans le worktree `~/Source/github.com/OpenFoxFork-mt-etape4c`, branche `mt/etape4c-cache` depuis `origin/main` (`034e3c9f`).

---

## Risques

1. **Octets JSON vs heap.** `bytes` = `row.payload.length` aujourd’hui, pas `process.memoryUsage()`. Le plafond borne cette somme. La démo C3 vérifie la jauge exposée, pas le RSS du process (V8 peut rester au-dessus).
2. **Sessions running épinglées.** N sessions running × snapshots lourds peuvent dépasser la limite. C1 le documente ; on n’évince pas une session en cours. C3 charge des sessions arrêtées.
3. **Payload > limite.** Ne pas le garder : sinon un seul snapshot de 107 Mio casse le plafond. Miss au GET suivant, acceptable.
4. **Double rétention.** Garder la string SQL **et** l’objet parsé double la RAM. C1 l’interdit sur l’entrée cache.
5. **Cumul vs fenêtre.** Hits / misses / évictions sont des compteurs process, pas des p99 10 s. Les mélanger aux histogrammes étape 1 fausse la page Santé.
6. **`OPENFOX_SNAPSHOT_DIAGNOSTICS`.** Les quatre métriques Santé vivent sans ce flag. Le flag peut rester pour timings / `cacheMemory`.
7. **Corpus.** `docs/backlog/corpus/` n’est pas checkouté sur `main` local (exclude). Le worktree 4c reprend `generate.mjs` + `manifest.json` de 4a-1 / 4b (`git show origin/main:docs/backlog/corpus/...` ou copie depuis le worktree 4b).
