# Fonctionnement de la facturation par projet

Ce document décrit la méthode retrouvée dans les classeurs Excel d'origine
(*Timesheet - All Teams*, *Charge Patronale - BDD*, *Facturation Paris*) et la
façon dont le logiciel la reproduit. Le recalcul de l'historique est **identique
au centime** pour 19 factures sur 21 (janvier 2025 → septembre 2026) ; les
2 autres sont des onglets Excel cassés (voir § 7).

## 1. Vue d'ensemble

```
 Jira (worklogs)          Charge patronale (DATAS)        CAPEX (DAP) + frais généraux
        │                          │                                 │
        ▼                          ▼                                 │
 Temps par collaborateur   Coût employeur mensuel                    │
 et par ticket → LOT       par collaborateur                         │
        │                          │                                 │
        └──────────► coût de chaque ligne ◄──────────┘               │
                           │                                         │
                           ▼                                         ▼
                 coût salarial par LOT  ──── % du total ────►  quote-part DAP + FG
                           │                                         │
                           └────────────── PRICE ◄───────────────────┘
                                             │
                              SUB TOTAL → COST + (7 %) → TOTAL
```

## 2. Les temps (fichier Timesheet)

* **Onglet `Details`** : export Jira brut — `User`, `Issue key`, `Issue summary`,
  `Epic`, `Time spent (hours)`.
* **Onglet `Roadmap_Project_Names`** : référentiel des epics. Pour chaque epic
  (`EPICS-194: SILO PAGES 2026`) : nom du lot facturé (`JIRA NAME`), statut,
  date de mise en ligne, sous-catégorie, catégorie.
* **Lot d'une ligne** = nom du lot de son epic (colonne `JIRA NAME`). Le lot est **mensuel**
  (`NOM - MM/YY`, ex. `CSE - BUG FIXES - 10/26`) quand ce nom contient un mot-clé :
  - `MINOR EVOLUTION` → évolutions mineures (Agile) ;
  - `BUG` (BUG FIXES, BUGS FIX, BUGS MANAGEMENT…) → support ;
  - activités récurrentes (run) : `REUNIONS & PILOTAGE`, `INFRA & SERVICES`, `CI/CD`,
    `DOCUMENTATION`, `CX - RUN`, `FASTERIZE`.

  Toutes les autres epics sont des projets : une seule ligne jusqu'à leur mise en ligne.
  La règle ne dépend que des noms (et plus de la colonne « Catégorie » de la Roadmap), ce qui
  permettra de lire les temps directement dans Jira. Mots-clés modifiables dans Paramètres.
  Constat sur l'historique : 109 des 134 lots mensuels facturés depuis 2018 contiennent
  `MINOR EVOLUTION` ou `BUG`, et tous les noms contenant ces mots ont été facturés au mois ; les
  autres lots mensuels sont les activités de run ci-dessus, plus quelques exceptions anciennes
  (contrats CRO 2020-2022, hébergement 2018, CMS V3 2023).
* **CTO** : pas de saisie. Son total d'heures = (jours ouvrés − absences) × 7
  est réparti sur les lots **au prorata des heures Jira de l'équipe**
  (feuille `Time_Tracking_Summary_<prénom>`).
* **Product Owner** : saisit lui-même ses heures par epic
  (feuille `Time_Tracking_Summary_<prénom>`, ou écran « Mes temps »).
* **Direction** : réparti au prorata des heures des collaborateurs **qui ont un coût**
  (hors développeurs CX et freelances sans coût). Deux membres de la direction
  ont donc la même répartition.

> Le total d'heures d'un collaborateur au prorata n'a aucun effet sur le coût :
> seule la proportion par lot compte (coût × heures du lot / heures du mois).

Jours ouvrés = `NETWORKDAYS.INTL(début, fin, 7)` : semaine du dimanche au jeudi.

## 3. Les coûts (fichier Charge patronale)

Onglet `DATAS` : une ligne par mois × salarié × catégorie (salaire brut, bitouah
leoumi, retraite, keren ichtalmout, provisions, miluim…), en NIS, type `Real`.
Le coût mensuel d'un collaborateur est la **somme de toutes ses catégories**.

Rapprochement des noms : la casse, les accents, les points et l'ordre des mots
sont ignorés (`Marie DUPONT` = `Marie Dupont` = `DUPONT Marie`,
`jerome.martin` = `Jérôme Martin`). C'est la cause des écarts sur les anciens
mois si l'on compare naïvement les noms.

## 4. Le coût d'une ligne

```
coût ligne = coût mensuel du collaborateur × heures de la ligne / heures du collaborateur sur le mois
```

(colonnes `Salaire Mensuel`, `% du Mois`, `Cout Projet` de l'onglet *BDD - Time Sheet*).
Un collaborateur sans coût (CX, freelance facturé à part) valorise ses heures à 0.
Un coût sans aucune heure est **bloquant** : il ne serait pas refacturé.

## 5. La facture (onglets `JJMMAA - FACT. PROJET`)

| Colonne | Calcul |
|---|---|
| PROJET SALAIRES | somme des coûts de ligne du lot |
| % | coût du lot / total des coûts du mois |
| DAP + OP. COST | (DAP + Frais généraux) × % |
| PRICE | PROJET SALAIRES + DAP + OP. COST |
| STATUT / DATE | statut et date de MEL du projet ; lots mensuels : PRODUCTION au dernier jour du mois |

Puis `SUB TOTAL`, `COST +` = 7 % du sous-total, `TOTAL`.
Les lots sont présentés en deux blocs : projets & évolutions, puis support & bug fixes.
Le n° de facture d'origine est le numéro de série Excel de la date (30/09/2026 → 46295) ;
c'est la valeur proposée par défaut, modifiable.

## 6. Règles de contrôle

| Règle | Niveau |
|---|---|
| Ligne sans epic (« No epic ») : à envoyer au chef de projet ou affecter un lot | bloquant |
| Epic absente du référentiel | bloquant |
| **Heures sur un projet déjà en ligne** : un projet en PRODUCTION à une date ne peut plus recevoir d'heures sur un mois postérieur (même règle pour un projet ABANDONED) | bloquant |
| Coût employeur sans heure | bloquant |
| Aucun coût / aucun temps sur le mois | bloquant |
| Coût négatif (régularisation miluim, provisions…) | à vérifier |
| Collaborateur inconnu | à vérifier |
| Heures Jira d'un collaborateur au prorata (ignorées) | info |

À la **validation**, la facture est figée (instantané) et chaque lot mensuel est
inscrit dans la base projets en PRODUCTION au dernier jour du mois, comme on le
faisait à la main dans l'onglet *MEP Dates*.

## 7. Contrôle de l'historique

L'assistant **Paramètres › Reprise des fichiers Excel** (ou `python -m scripts.seed …`) recalcule chaque mois à partir des temps de
*BDD - Time Sheet* et des coûts actuels, puis compare chaque ligne à l'onglet facture
(rapport généré dans `docs/reconciliation.md`, non versionné car il contient des montants).

* 2025-01 → 2025-11 et 2026-01 → 2026-09 : **identiques** ligne à ligne.
* 2025-12 et 2026-04 : onglets Excel en `#REF!` (tableau croisé cassé), non comparables.

## 8. Version 2 : Jira

L'import des temps est isolé (`app/importers.py`, format « Details »). Il suffira
de remplacer la lecture du fichier par un appel à l'API des worklogs Jira
(projets MC et RD10, mois courant, tous les utilisateurs) qui produit les mêmes
cinq colonnes.
