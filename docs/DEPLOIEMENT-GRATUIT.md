# Mettre l'application en ligne gratuitement (PythonAnywhere)

Gratuit, sans carte bancaire, les données sont conservées. Adresse obtenue :
`https://VOTRE-IDENTIFIANT.pythonanywhere.com` (HTTPS, ordinateur et mobile). Compter 10 minutes.

Dans ce guide, remplacez **`VOTRE-IDENTIFIANT`** par l'identifiant choisi à l'étape 1.

## 1. Créer le compte

1. Allez sur https://www.pythonanywhere.com → **Pricing & signup** → **Create a Beginner account**.
2. Choisissez un identifiant : il devient l'adresse du site (ex. `labfacturation` → `https://labfacturation.pythonanywhere.com`).
3. Confirmez votre e-mail.

## 2. Récupérer le code

1. Sur GitHub, dans le dépôt **Lab-Invoicing** : bouton vert **Code** → **Download ZIP**.
   Vous obtenez `Lab-Invoicing-main.zip`.
2. Sur PythonAnywhere, onglet **Files** → **Upload a file** → choisissez le ZIP.

## 3. Installer

Onglet **Consoles** → **Bash**, puis copiez-collez cette ligne et validez :

```bash
unzip -q Lab-Invoicing-main.zip && cd Lab-Invoicing-main && pip3.11 install --user -r requirements.txt
```

Attendez la fin de l'installation (1 à 2 minutes).

## 4. Créer le site

1. Onglet **Web** → **Add a new web app** → **Next**.
2. Choisissez **Manual configuration** (pas « FastAPI » ni « Flask ») → **Python 3.11** → **Next**.
3. Dans la section **Code**, cliquez sur le lien du **WSGI configuration file**
   (`/var/www/VOTRE-IDENTIFIANT_pythonanywhere_com_wsgi.py`).
4. **Effacez tout** le contenu du fichier et remplacez-le par ces 3 lignes :

   ```python
   import sys
   sys.path.insert(0, "/home/VOTRE-IDENTIFIANT/Lab-Invoicing-main")
   from wsgi import application
   ```

5. **Save**, puis revenez à l'onglet **Web**.
6. Dans **Security**, activez **Force HTTPS**.
7. Cliquez sur le gros bouton vert **Reload**.

## 5. Démarrer

1. Ouvrez `https://VOTRE-IDENTIFIANT.pythonanywhere.com` : créez le compte administrateur.
2. **Paramètres › Reprise des fichiers Excel** : déposez *Facturation Paris*, *Charge Patronale*
   et le dernier timesheet → **Lancer la reprise** (peut prendre jusqu'à une minute).
3. **Comptes & droits › Créer les comptes de l'équipe**, puis partagez l'adresse.

## À savoir (offre gratuite)

* **Tous les 3 mois**, connectez-vous à PythonAnywhere et cliquez sur
  **Run until 3 months from today** (onglet Web), sinon le site est mis en pause. Un e-mail vous prévient.
* Espace disque : 512 Mo (largement suffisant : la base fait quelques Mo).
* L'assistant IA de rapprochement des noms n'est pas disponible sur l'offre gratuite
  (accès Internet sortant restreint) ; le rapprochement local fonctionne normalement.
* La base est le fichier `Lab-Invoicing-main/data/facturation.db` : téléchargez-le de temps en
  temps depuis l'onglet **Files** pour en garder une sauvegarde.

## Mettre à jour l'application plus tard

1. Téléchargez le nouveau ZIP depuis GitHub et envoyez-le dans **Files** (il remplace l'ancien).
2. Console **Bash** — la base de données (`data/`) n'est pas touchée :

   ```bash
   unzip -oq Lab-Invoicing-main.zip && cd Lab-Invoicing-main && pip3.11 install --user -r requirements.txt
   ```

3. Onglet **Web** → **Reload**.
