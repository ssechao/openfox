# Lot 4b — Critères (recherche FTS5)

Planner : session courante, titre Aether « Planner 4b FTS5 ». Ticket `e392ae2d` laissé `in_progress`. Révision : 2026-10-22 (revue Astra + pilote, v6). Aucun code écrit.

Périmètre 4b : remplacer la recherche globale côté client (snapshot parsing + `fuzzyMatch`) par un index FTS5 alimenté à l’écriture, paginée. La recherche en ligne et le démarrage ne parsent jamais `turn.snapshot`. La reconstruction hors ligne (`scripts/rebuild-search-index.ts`) et l’import explicite d’une session exportée peuvent lire `turn.snapshot` pour retrouver les prompts antérieurs à un `cleanupOldEvents`. Couvre titres de session et prompts utilisateur. Reconstruction de l’index pour l’existant via commande explicite, sous verrou d’instance, jamais au démarrage.

Hors périmètre : recherche inside session (reste côté client sur les messages déjà chargés), recherche dans les résultats d’outils / thinking, autocomplétion, suggestions.

Référence plan : `docs/backlog/plan-multithread.md` § Étape 4 / 4b. Ancien ticket : `e3fec8ae`.

Base acceptée : `origin/main` (`ff2b1018`), qui contient déjà 4a-1 et 4a-2.

Worktree de build (pas encore créé) :

```bash
git worktree add ~/Source/github.com/OpenFoxFork-mt-etape4b -b mt/etape4b-fts origin/main
npx husky
git config openfox.testRemote ssechao@192.168.71.122
```

---

## 3 critères (une commande chacun)

### C1 — Index FTS5 alimenté à l’écriture, cohérent et sans snapshot parsing en ligne

Commande :

```bash
npx vitest run src/server/search/fts-index.test.ts
```

- Table virtuelle FTS5, ex. `search_index(session_id UNINDEXED, title, body)`, créée par migration si absente.
- **Atomicité** : l’écriture d’un event et la mise à jour correspondante de l’index FTS5 se font dans la **même transaction SQLite** pour `append`, `appendBatch`, `importEvents`, renommage de session et suppression de session. Si l’écriture FTS échoue, **aucun event n’est commité** et inversement.
- **Alimentation à l’écriture uniquement** : `EventStore.append` / `appendBatch` / `importEvents` et `updateSessionMetadata` mettent à jour l’index pour les événements suivants :
  - `session.initialized` avec `title` ;
  - `session.name_generated` ;
  - `message.start` role=`user`, non `isSystemGenerated`, sans `messageKind` ni `subAgentType` ;
  - `message.delta` et `message.done` pour reconstruire le **contenu final** du message (pas seulement `message.start.content`) ;
  - changement explicite de titre (route `PUT /api/sessions/:id/title` ou équivalent).
- **Purge technique vs retrait logique** : `cleanupOldEvents` supprime les events antérieurs au snapshot, mais l’index ne perd pas les messages utilisateur correspondants car ils restent présents dans le snapshot. L’index ne supprime une entrée que pour un retrait logique : suppression de session, suppression d’un message (s’il existe), ou remplacement d’un snapshot qui n’inclut plus ce message. Le retrait logique d’un message transmet les IDs retirés ; le chemin en ligne ne relit pas les snapshots persistés.
- **Jamais de parsing de `turn.snapshot`** dans le chemin d’indexation en ligne. Le code de test vérifie qu’aucune fonction de lecture de snapshot n’est appelée lors de l’indexation en ligne.
- Les messages système, les messages de sous-agent (`subAgentType` défini) et les `messageKind` (correction, auto-prompt, etc.) sont **exclus** de l’index.
- Une suppression de session (`deleteSession`) retire ses entrées de l’index.
- Les prompts indexés sont **tous les prompts utilisateur** de la session, pas seulement les 20 derniers de `recent_user_prompts`.
- Teste la cohérence transactionnelle : simulation d’une erreur FTS pendant `append` → l’event n’est pas en base et l’index n’a pas changé.
- Teste la cohérence fonctionnelle : création de session + titre + plusieurs messages, y compris messages avec deltas et `cleanupOldEvents` → recherche retourne la session pour des termes présents dans le titre ou dans le contenu final de n’importe quel prompt ; suppression de session → la session disparaît des résultats.
- Teste les mots tokenisés par FTS5, les accents/asciifolding si activés, et la non-régression de la route existante quand `?q` est absent.

### C2 — Route paginée, recherche robuste, UI explicite et démo de performance

Commande :

```bash
npx vitest run --config e2e/vitest.config.ts e2e/search.demo.test.ts
```

Le test unique vérifie :

1. **Référence AVANT remesurée** sur le corpus synthétique (`docs/backlog/corpus/`, graine fixe, généré dans un tmp) et la même recette : instance isolée, base fraîche, cache snapshot vide. La référence est le temps total de `GET /api/sessions` (chargement complet + parsing de tous les snapshots pour `recent_user_prompts`) suivi du `fuzzyMatch` côté client sur le corpus entier. Mesure p99 sur N requêtes de recherche (N ≥ 100).
2. **Corpus** : environ 100 sessions / 12 000 events, avec des prompts anciens et des recherches positives, négatives et sur mots courants. La référence AVANT est mesurée sur le commit figé `ff2b1018`, sans parsing artificiel ajouté.
3. **Hôte de mesure** : la démo de performance s’exécute sur `.122` (x86_64, build Docker distant), à froid et à chaud, avec la même recette avant et après. Le p99 est une latence HTTP de bout en bout (`fetch` jusqu’au JSON reçu).
4. **Route de recherche** : `GET /api/sessions?q=<terme>&limit=<L>&offset=<O>` retourne `{sessions, hasMore, indexReady}` et utilise l’index FTS5. Sans `?q`, le comportement existant est conservé.
5. **Robustesse de la recherche** : fixtures couvrant mots entiers, préfixes, accents, multi-mots, `q` vide, ponctuation. Échappement correct de la syntaxe MATCH FTS5 ; aucune requête de recherche ne produit de 500.
6. **Déduplication et ordre** : les résultats sont dédupliqués **par session avant la pagination** ; l’ordre est stable et suit le sens du score FTS5 natif (`rank`/`bm25` : le meilleur score est le plus petit, donc tri ASC) ; les filtres projet et droits sont appliqués comme sur la route existante.
7. **État `indexReady`** : la disponibilité de l’index est stockée dans une ligne versionnée en base (ex. `settings` ou table dédiée), **pas déduite du nombre de lignes**. Une base existante reste `indexReady: false` même après de nouvelles écritures tant qu’un rebuild explicite n’a pas été fait. Quand `indexReady` est `false`, la route retourne `indexReady: false`, `sessions: []` et un message explicite ; jamais de liste vide silencieuse.
8. **UI** : la sidebar affiche le message d’indisponibilité de l’index en français et en anglais :
   - en : « Search index is unavailable. Run scripts/rebuild-search-index.ts to enable search. »
   - fr : « L’index de recherche est indisponible. Exécutez scripts/rebuild-search-index.ts pour activer la recherche. »
     Lorsque l’index est prêt, elle affiche les pages serveur sans les refiltrer côté client et ignore les réponses périmées (race entre plusieurs requêtes de pagination).
9. **Pagination** : `hasMore` est correct pour `limit` petit ; `offset` retourne la page suivante ; les résultats contiennent au moins les sessions attendues par les fixtures (pas d’équivalence stricte FTS vs `fuzzyMatch` requise).
10. **Seuil de performance** : le p99 du temps de recherche serveur (`/api/sessions?q=...`) sur le corpus est **≤ 100 ms**.
11. **Rapport** : le test écrit les chiffres avant/après (p50, p99, ratio) dans un rapport JSON optionnel (`SEARCH_DEMO_REPORT=<file>`). Si le seuil n’est pas atteint, le test échoue sur le point 10.

Le corpus réutilise le générateur `docs/backlog/corpus/generate.mjs` + `manifest.json` du lot 4a-1. `display.maxVisibleItems=50` est figé dans le manifeste pour la comparaison.

### C3 — Reconstruction atomique, état ready versionné, jamais au démarrage

Commande :

```bash
npx vitest run src/server/search/fts-rebuild.test.ts
```

- CLI : `scripts/rebuild-search-index.ts --yes --db <path>`.
- **Vrai verrou d’instance** : le rebuild utilise le **vrai `acquireInstanceLock`** (même contrat que `scripts/migrate-blobs.ts`). Refuse de reconstruire si la base est ouverte par une instance OpenFox.
- **Atomicité** : le rebuild construit l’index dans une transaction ; le flag `indexReady` n’est posé à `true` qu’**après succès**. Si le processus est tué au milieu (`SIGKILL`) et relancé, l’ancien index cohérent est conservé OU le statut reste `indexReady: false` ; jamais un index partiel annoncé comme prêt.
- **Jamais au démarrage** : `initDatabase` / `initEventStore` ne lance pas la reconstruction automatiquement, même si la table FTS est vide ou manquante. Un démarrage sur une base existante sans `indexReady: true` retourne `indexReady: false` avec message explicite.
- **Idempotente** : reconstruire deux fois donne le même résultat.
- **Sources de reconstruction hors ligne** : `sessions.title`, les événements `message.start` utilisateur postérieurs au dernier snapshot, les `message.delta`/`message.done` postérieurs au snapshot pour reconstruire le contenu final, et, pour les prompts antérieurs à un `cleanupOldEvents`, les messages utilisateur lus depuis le dernier `turn.snapshot` de chaque session. La lecture de snapshot est **autorisée uniquement dans la CLI de rebuild hors ligne et dans l’import explicite d’une session exportée**.
- Tests :
  - corrompre la table FTS (`DROP` ou `DELETE` arbitraire), reconstruire, vérifier que les recherches retrouvent les mêmes résultats qu’avant corruption ;
  - **prompt ancien, snapshot, cleanup, rebuild x2** : un prompt utilisateur antérieur au snapshot reste trouvable après `cleanupOldEvents` et deux reconstructions successives ;
  - **import snapshot-only** : importer une session exportée dont seul le snapshot contient les prompts utilisateur rend ces prompts trouvables ;
  - **SIGKILL pendant rebuild** : relancer après kill → ancien index cohérent ou `indexReady: false`, jamais d’index partiel prêt ;
  - lancer la CLI sur une base ouverte → échec explicite ;
  - démarrer une instance sur une base sans `indexReady: true` → `GET /api/sessions?q=...` retourne `indexReady: false` et `sessions: []` avec message explicite.

---

## Mesure et procédure de MEP

- **Référence AVANT** : mesurée sur le commit figé `ff2b1018` avec le générateur de corpus. Pas de parsing artificiel ajouté.
- **Hôte** : `.122` via build Docker distant (builder `pve8-builder` / contexte `pve8`). Mesures à froid et à chaud.
- **Métrique** : p99 de la latence HTTP de bout en bout sur au moins 100 requêtes `GET /api/sessions?q=...`.
- **Seuil** : p99 ≤ 100 ms.
- **Rapport** : fichier JSON écrit par `e2e/search.demo.test.ts` quand `SEARCH_DEMO_REPORT` est défini.
- **Procédure de MEP en production** (exécutée sous le contrôle de Souchiam, jamais automatiquement par l’agent) :
  1. Arrêter l’instance OpenFox concernée (450 ou 550).
  2. Sauvegarder la base SQLite et le dossier de blobs (`sessions.db` + `sessions.db.blobs`).
  3. Lancer `scripts/rebuild-search-index.ts --yes --db <chemin>`.
  4. Vérifier que `indexReady` est `true` (flag en base).
  5. Redémarrer l’instance.
  6. Faire un smoke test : recherche sur un terme connu retourne des résultats.

---

## Contraintes communes

- Jamais la base live (`~/Library/Application Support/openfox/sessions.db`). Corpus et tests en tmp, comme 4a-1.
- L’index FTS est dans le **même fichier SQLite** que la base (pas de DB externe) pour la cohérence WAL/backup.
- `docs/backlog/` est dans `.git/info/exclude` : forcer le fichier (`git add -f`) comme `etape4a1-criteres.md`.
- `lsof` : 0 fichier sous `~/Library/Application Support/openfox`.
- Le build se fera dans le worktree `~/Source/github.com/OpenFoxFork-mt-etape4b`, branche `mt/etape4b-fts` depuis `origin/main`.

---

## Risques

1. **Taille de l’index FTS5.** Sur la copie prod (1,34 Gio, 101 snapshots), le texte indexable (titres + prompts) est faible comparé aux payloads binaires. L’index devrait rester petit, mais il faut le mesurer.
2. **`cleanupOldEvents` supprime les `message.start` antérieurs au snapshot.** Le rebuild hors ligne doit donc lire le snapshot pour ne pas perdre ces prompts. En ligne, l’index est alimenté par les events avant cleanup, donc reste complet.
3. **Atomicité event + index.** Partager la transaction entre l’insert event et l’insert FTS peut augmenter la contention. Le test C1 vérifie que l’échec d’un côté annule l’autre.
4. **`indexReady` versionné.** Une base pré-4b reste `indexReady: false` jusqu’à reconstruction explicite, même si de nouvelles sessions y sont créées. L’UI doit communiquer clairement cet état.
5. **`recent_user_prompts` existant.** La colonne reste utilisée par la sidebar quand `?q` est absent. Elle continue de parser le snapshot en backfill. Ce n’est pas dans le périmètre 4b.
6. **Ranking FTS5.** Le classement par `rank` FTS5 peut différer du `fuzzyMatch` côté client. La démo C2 compare les résultats, pas l’ordre exact.
7. **Reconstruction sur base grande.** La reconstruction parcourt snapshots + events ; sur une base de prod cela peut prendre plusieurs secondes. C’est acceptable car explicite et sous verrou, jamais au boot.
8. **Verrou d’instance.** Le CLI doit utiliser le vrai `acquireInstanceLock`, pas un simple `BEGIN IMMEDIATE`.
9. **Pagination et ordre.** `hasMore` doit être cohérent même si le ranking change légèrement entre deux pages. Utiliser un ordre stable (rank ASC, session_id, etc.).
10. **Tests sur .122.** La démo de performance doit utiliser le même hôte pour avant/après. Si le Mac est chargé, la mesure se fait sur `.122` via le builder distant (Docker), avec un container qui reproduit le corpus.
11. **Limite de messages par session dans l’index.** Si une session a des milliers de prompts, l’index stocke une entrée par message pour permettre le ranking. Alternative : une entrée par session avec `body` = concaténation des prompts. L’entrée par session est plus compacte mais perd le contexte message. Garder une entrée par message semble plus précis ; le test C1 valide le comportement.
