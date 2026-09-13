# Compaction : budget cohérent pour un contexte inconnu avec images

## Périmètre et état

- Base : `main` / `9e76bbb1a1edf7d36331e8e875032d27a9a78689` (sources du binaire fork.6).
- Branche isolée : `fix/compaction-token-budget`.
- OpenFox uniquement. Aucun accès en écriture aux sessions/config utilisateur, aucun appel LLM payant, aucun restart.
- Pas de commit/push/merge/déploiement sans instruction distincte.
- Hors périmètre : migration des anciens checkpoints et erreur wrapper `native_context_rebuild_required`.

## Défaut reproduit en lecture seule

LBS : usage inconnu, fenêtre active 1 050 000 ; garde actuelle >= 5 438 265 « tokens »
(octets JSON), dont 3 471 671 octets de pièces jointes image. Le réducteur estime
396 573 tokens et refuse donc toute réduction. Deux métriques incompatibles.
Ces chiffres ne sont pas un comptage fournisseur de la requête actuelle.

## Contrat de correction

1. Séparer texte et pièces jointes image : ne jamais tokeniser le base64 image
   comme du texte, ni enlever/modifier les images envoyées pour faciliter le calcul.
2. Pour GPT-5/6, utiliser une tokenisation locale o200k avec marge explicite et
   bornes de travail. C'est une estimation, pas une nouvelle mesure fournisseur.
   Pour les modèles dont le tokenizer n'est pas établi, conserver le repli
   conservateur UTF-8 pour le texte, plutôt que supposer le tokenizer GPT identique.
3. Réserver un budget image explicite et conservateur ; ne pas confondre sa taille
   compressée avec son coût vision. Les formats non pris en charge restent conservateurs.
4. La garde, la réduction et le calcul de sortie utilisent la même estimation de
   la requête assemblée (système + messages + outils effectivement envoyés).
   Pas de double comptage du delta déjà assemblé quand l'usage est inconnu.
5. Ne réduire les résultats d'outils que si ce budget le nécessite, sans modifier
   l'historique durable. Garder les limites de tentatives et l'échec explicite si
   aucun budget sûr n'est disponible. Ne pas toucher au matcher de reprise.
6. Ne jamais publier l'estimation dans `currentTokens` : Unknown demeure inconnu
   jusqu'à une mesure fournisseur. Un échec ne remplace pas le contexte par un résumé vide.

Référence consultée (OpenAI Docs, 2026-09-13) :
[Images and vision](https://developers.openai.com/api/docs/guides/images-vision).
Le coût vision dépend du modèle, du détail et des patches, pas de la longueur base64.

## Suivi TDD

- [x] Vérifier base, worktree propre, runtime et diagnostic chiffré.
- [x] RED : tests unitaires image/base64, vrai texte dense, arguments/outils, budget homogène.
- [x] RED : vrai client HTTP + SQLite synthétique, Unknown + historique + images ; aucune requête sur la base.
- [x] GREEN : estimation locale bornée, budget multimodal et réducteur cohérents.
- [x] Tests adversariaux : garde overflow, Unicode, fausses images dans du texte,
      absence de mutation, compteurs mesurés, delta, budget de sortie, formats non supportés.
- [x] Vérification hors ligne du cas LBS, seulement nombres/hashes, aucune conversation exportée.
- [x] Tests ciblés, `npm run check`, suite complète avec concurrence plafonnée.
- [x] Relecture du diff, résultats et limites consignés ; production inchangée.

## Résultats

- RED initial : 4 échecs discriminants / 56 passés (3 fichiers) ; RED HTTP : 1 échec / 6 ignorés.
  Le message d'échec est exactement celui de la capture, avant toute requête HTTP.
- GREEN ciblé : 74/74 (4 fichiers), incluant GPT-5.6 Chat et Responses, GPT-6 Responses,
  Claude Responses, conservation du contenu/image et de la mesure fournisseur.
- Relecture hors ligne LBS, snapshot 122 / 1 604 messages : estimation GPT avec système
  conservé et sans outils de compaction = 866 280, marge sortie = 181 672 avant choix
  des 8 192 tokens. Hash des messages inchangé. Aucun LLM, aucune écriture SQLite.
- Temps froid de cette mesure : 1 159 ms (diagnostic synchrone local, non SLA).
  Tokenizer chargé paresseusement seulement si l'estimation GPT est nécessaire,
  segments BPE de 2 048 caractères, cache plafonné à 512 segments. Les tours avec
  mesure fournisseur ne retokenisent pas tout l'historique.
- Dépendance locale épinglée : `js-tiktoken@1.0.21`, vocabulaire o200k uniquement.
  Marge texte GPT de 25 % ; autres tokenizers : repli UTF-8 conservateur inchangé.
- Réserve image de 40 000 par pièce jointe raster reconnue : marge de planification,
  pas un comptage exact ni une borne universelle tous fournisseurs. Texte contenant
  une data URL, arguments, PDF et formats inconnus ne sont pas exemptés du budget.
- `npm run check` : vert (types serveur/web/E2E, lint, format, duplication : 0 clone).
- Suite complète : `VITEST_MAX_WORKERS=1 OPENFOX_E2E_MAX_WORKERS=4 npm run test`, exit 0.
  Unitaires : 5 606 passés / 32 ignorés, 414 fichiers passés / 2 ignorés ;
  E2E : 346 passés / 49 ignorés, 48 fichiers passés / 3 ignorés.
- Compilation serveur directe (`tsup`, sans hook de versionnement) : JavaScript et
  déclarations TypeScript verts. Smoke du helper compilé : dépendance locale chargée,
  budget 158 925 pour la fixture code + image, aucun appel fournisseur.
- Revue finale : aucune modification du protocole de reprise, des données persistées,
  du wrapper ni de la production. Les messages de conversation produits par le
  constructeur réel portent `source: history` ; retirer ce champ de l'estimation
  aligne leur représentation sur l'assemblage LLM sans modifier la requête.
- Livraison limitée à l'implémentation non commitée sur `fix/compaction-token-budget`.
  Aucun commit, push, merge, déploiement ou redémarrage effectué.

## Limites de cette livraison

Le comptage exact reste celui du fournisseur. Aucune API de comptage propriétaire
ni génération facturée n'est appelée pour estimer. L'estimateur peut encore être
conservateur (notamment le texte Claude et les formats non reconnus). Une erreur
de contexte du fournisseur conserve la récupération bornée existante ; un 409 de
reprise reste explicite et n'est pas contourné. Un vert local ne prouve pas la
reprise d'un checkpoint ancien ni une compaction réussie en production.

## Déploiement autorisé le 13 septembre 2026

Après validation, l'utilisateur a arrêté OpenFox puis autorisé explicitement
l'installation, sans démarrage par l'agent. Paquet installé : **2.0.145-fork.7**,
répertoire `/Users/sechaosouchiam/.local/share/openfox/releases/2.0.145-fork.7-9494d276`.

- Archive figée de 1 249 sources testées ; seuls les champs de version ont été
  ajustés dans la copie de build. Dépôt principal et branche de travail inchangés.
- Build serveur/web et vérification de paquet verts ; 502 fichiers dist comparés
  au build, langues et assets présents. Dépendances de production installées depuis
  le lockfile exact ; modules natifs reconstruits et chargés, SQLite en mémoire seulement.
- Estimation issue du JavaScript livré testée avec ses dépendances installées,
  pour GPT-5.6, GPT-6 et Claude ; images/texte conservés, aucun appel LLM.
- Lien global basculé atomiquement ; `openfox --version` retourne fork.7.
  Port 450 libre ; hashes de la DB et de la configuration inchangés.
- Fork.6 conservée pour retour arrière. Manifeste, empreintes, archive des sources
  et procédure de rollback dans le répertoire de release.
- Aucun commit, push ou merge effectué : le correctif reste sur la branche dédiée.
  L'utilisateur peut maintenant lancer `openfox --port 450` depuis son terminal habituel.
