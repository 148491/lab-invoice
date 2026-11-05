# Lab Facturation

Application web de facturation mensuelle par projet : temps de l'équipe (Jira + saisies de
chacun), coûts employeur, CAPEX (DAP) et frais généraux, contrôles, facture détaillée et
validation. Desktop et mobile, comptes et droits par rôle.

La méthode de calcul et les règles sont décrites dans [docs/FONCTIONNEMENT.md](docs/FONCTIONNEMENT.md).

## Fonctionnalités

| Domaine | Ce que fait l'application |
|---|---|
| **Temps** | Import du fichier *Timesheet - All Teams* (ou export Jira) avec **aperçu avant import** : collaborateurs inconnus (rattacher / créer / ignorer), collaborateurs déclarés absents du fichier, **heures par personne comparées à l'attendu du mois** (± 20 %), epics inconnues. |
| **Saisie par chacun** | « Mes temps » : chaque collaborateur déclare ses heures par projet (recherche, copier-coller depuis Excel, compteur d'heures vs attendu), depuis son ordinateur ou son téléphone. Les chefs de projet peuvent saisir pour quelqu'un. |
| **Charges** | Fichier *Charge Patronale*, copier-coller (« Nom ⇥ Montant ») ou saisie directe dans le tableau ; aperçu avec variation vs mois précédent. |
| **Noms** | Un seul nom par personne. Rapprochement automatique (casse, accents, ordre des mots, initiales, translittération), alias mémorisés, détection de doublons à la création ; **IA (Claude)** en complément si `ANTHROPIC_API_KEY` est définie. |
| **Contrôles** | Lignes sans epic, epics inconnues, heures sur un projet déjà en ligne, coût sans heures, coûts négatifs… avec actions de correction en un clic. |
| **Facture** | Vue détaillée ou client, détail par collaborateur, export Excel, impression PDF, validation (mois figé, lots mensuels inscrits comme livrés). |
| **Accès** | Comptes et rôles : Administrateur, Finance, Chef de projet, Collaborateur. Journal de toutes les actions. |
| **Confort** | Palette de commandes (⌘K / Ctrl+K), thème sombre, installable sur mobile (PWA). |

### Droits par rôle

| Droit | Admin | Finance | Chef de projet | Collaborateur |
|---|:-:|:-:|:-:|:-:|
| Saisir ses temps | ✓ | ✓ | ✓ | ✓ |
| Consulter factures et tableau de bord | ✓ | ✓ | ✓ | |
| Gérer les temps de tous (import, corrections) | ✓ | ✓ | ✓ | |
| Référentiels (projets, epics, collaborateurs) | ✓ | ✓ | ✓ | |
| Charges employeur | ✓ | ✓ | | |
| CAPEX / frais généraux, validation des factures | ✓ | ✓ | | |
| Comptes, journal, paramètres | ✓ | | | |

## Installation locale

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --port 8000
```

Ouvrez http://localhost:8000 : au premier lancement, l'application demande de créer le compte administrateur.

### Reprise des fichiers Excel existants

Depuis l'interface : **Paramètres › Reprise des fichiers Excel**. En ligne de commande, placez les classeurs dans `samples/` (ignoré par git), puis :

```bash
python -m scripts.seed --facturation samples/Facturation-Paris.xlsx --charges samples/Charge-Patronale_-_BDD.xlsx --timesheet "samples/Timesheet - All Teams - October 26.xlsx" --accounts comptes.txt
```

Charge salariés, base projets, epics, coûts, historique des temps depuis 2025, recalcule et
valide chaque facture passée (rapport `docs/reconciliation.md`), désactive les anciens salariés
et crée des comptes de démonstration (identifiants dans `comptes.txt`). **Remplace la base existante.**

## Déploiement

**Sur votre VPS (Ubuntu 22.04+ / Debian 12+)**, en root :

```bash
git clone https://github.com/Office1480/Lab-Invoicing.git /opt/lab-facturation && bash /opt/lab-facturation/deploy/install.sh factu.votre-domaine.com
```

Sans nom de domaine, omettez-le : le site est servi sur `http://IP-DU-SERVEUR`. Le script installe Python,
un service systemd, Caddy (HTTPS Let's Encrypt automatique) et une sauvegarde quotidienne de la base.
Mise à jour : `sudo bash /opt/lab-facturation/deploy/update.sh`.

**Railway :** *New Project* › *Deploy from GitHub repo* › Lab-Invoicing, puis ajoutez un **Volume** monté sur `/data`
et générez un domaine (*Settings › Networking › Generate Domain*). Configuration fournie : `railway.json`.

**Gratuit :** PythonAnywhere, sans carte bancaire, données conservées. Suivez le guide pas à pas
[docs/DEPLOIEMENT-GRATUIT.md](docs/DEPLOIEMENT-GRATUIT.md) (≈ 10 minutes).

**Payant (≈ 7 $/mois), en un clic :**

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Office1480/Lab-Invoicing)

1. Cliquez sur le bouton ci-dessus (ou Render › *New +* › *Blueprint* › ce dépôt) et autorisez l'accès au dépôt.
2. À l'ouverture de l'URL, créez le compte administrateur.
3. **Paramètres › Reprise des fichiers Excel** : déposez *Facturation Paris*, *Charge Patronale* et le dernier timesheet. L'historique est chargé et chaque facture recalculée.
4. **Comptes & droits › Créer les comptes de l'équipe**.

* **Docker** : `docker build -t lab-facturation . && docker run -p 8000:8000 -v lab-data:/data lab-facturation`
* **Render** : *New + → Blueprint* sur ce dépôt (`render.yaml`, disque persistant inclus).
* Derrière HTTPS, gardez `FACTU_SECURE_COOKIE=1` (valeur par défaut de l'image).

| Variable | Rôle |
|---|---|
| `FACTU_DB` | Chemin de la base SQLite (défaut `data/facturation.db`) |
| `FACTU_SECURE_COOKIE` | `1` pour des cookies de session HTTPS uniquement |
| `ANTHROPIC_API_KEY` | Facultatif : active le rapprochement des noms par Claude (seuls des noms sont envoyés) |

La base contient des données de paie : elle n'est jamais versionnée. Sauvegardez le fichier SQLite (volume `/data`).

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```

Si les fichiers réels sont dans `samples/`, un test vérifie en plus que les factures d'août et septembre 2026 sont retrouvées au centime près.

## Structure

```
app/
  main.py       API (FastAPI) : authentification, droits, endpoints
  auth.py       comptes, sessions, rôles
  engine.py     calcul : lots, prorata, coûts, contrôles, facture, validation
  review.py     aperçu avant import : collaborateurs, heures vs attendu, décisions
  sheets.py     feuilles de temps saisies dans l'application
  importers.py  lecture des classeurs Excel et des copier-coller
  names.py      rapprochement des noms (local) ; ai.py : rapprochement par Claude
  export.py     export Excel de la facture
  db.py         schéma SQLite
static/         interface (HTML/CSS/JS modules, sans dépendance ni build)
scripts/seed.py reprise des fichiers Excel existants
```
