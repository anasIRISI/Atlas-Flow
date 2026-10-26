# Atlas Flow — configurer et tester les API

On avance **une intégration à la fois** : ajouter la connexion → tester la connexion → exécuter un petit workflow → vérifier le résultat réel.

## 1. Configuration de base

- Le fichier local `.env` est prêt : port `5679`, fuseau `Africa/Casablanca`, URL publique automatique.
- Lance `npm start` puis ouvre [Atlas Flow](http://localhost:5679).
- Mets les identifiants dans **Connexions**, où ils sont chiffrés. Le fichier `.env` peut rester sans clé.
- Après une modification de `.env`, arrête le serveur avec **Ctrl+C**, puis relance `npm start`. Après **Save** dans Connexions, tu peux tester directement.
- Priorité : connexion choisie dans le nœud → connexion par défaut du service → variables `.env`.

**Vérifier la base :** ouvre le tableau de bord et exécute **Essayer mon premier flow**. Résultat attendu : trois étapes réussies et ton message dans **Mon message → Output**.

## 2. Première intégration : Gmail / SMTP

Gmail n’utilise pas une clé API pour ce scénario : Atlas Flow envoie les emails via SMTP avec un **mot de passe d’application Google**.

### A. Préparer Google

1. Connecte-toi au compte Gmail que tu veux utiliser pour envoyer les emails.
2. Active la [validation en deux étapes](https://myaccount.google.com/signinoptions/two-step-verification).
3. Ouvre [Mots de passe d’application](https://myaccount.google.com/apppasswords).
4. Crée un mot de passe nommé **Atlas Flow** et garde le code affiché pour le coller dans l’application.

Il faut utiliser ce code, **pas ton mot de passe Gmail habituel**. Si l’option n’apparaît pas, vérifie les restrictions de ton compte scolaire/professionnel ou de Protection Avancée : [aide officielle Google](https://support.google.com/accounts/answer/185833?hl=fr).

### B. Ajouter la connexion dans Atlas Flow

1. Ouvre **Connexions → Add credential → SMTP**.
2. Clique sur le bouton **Gmail** dans **Quick setup**.
3. Remplis les champs :

| Champ de l’interface | Valeur |
|---|---|
| Credential name | `Gmail Atlas` |
| Host | `smtp.gmail.com` (prérempli par Gmail) |
| Port | `465` (prérempli) |
| SSL/TLS | Activé (prérempli) |
| User | Ton adresse Gmail complète |
| Password | Le mot de passe d’application Google |
| Default Sender (From) | Ton adresse Gmail, ou laisse vide pour utiliser User |

4. Clique **Test**. Ce bouton vérifie la connexion et l’authentification ; il n’envoie pas d’email.
5. Résultat attendu : **Connected to smtp.gmail.com:465 and signed in as…**.
6. Clique **Save**. Si tu as plusieurs connexions SMTP, sélectionne explicitement `Gmail Atlas` dans le nœud ou choisis-la comme connexion par défaut.

### C. Tester un vrai email dans le workflow

1. Ouvre **Mes workflows → Exemples** et importe **Test Gmail - Atlas Flow**. Il est aussi disponible dans **Modèles** en recherchant `Gmail`.
2. Double-clique sur **Envoyer mon email**.
3. Dans **Credentials**, sélectionne **Gmail Atlas**.
4. Dans **To Email**, saisis **ta propre adresse** pour ce premier test. Garde **From Email** vide, **Subject** = `Test Atlas Flow` et **Email Format** = `Text`.
5. Clique **Enregistrer**, puis **Exécuter**. Chaque exécution envoie un vrai email.
6. Résultat attendu : les deux étapes réussissent ; **Output** contient `accepted` avec ton adresse, et le message arrive dans ta boîte de réception. Vérifie aussi les spams.

Une adresse dans `accepted` signifie que le serveur SMTP a accepté le message ; la réception effective se vérifie dans la boîte mail.

### D. Tester aussi depuis le terminal

Après avoir sauvegardé la connexion, ouvre un deuxième terminal dans le dossier du projet et lance :

```powershell
npm run check:email -- --credential "Gmail Atlas"
```

Résultat attendu : **OK connected and signed in**, puis **OK email sent**. Par défaut, ce test envoie l’email à l’adresse **User** de la connexion (sauf si `SMTP_TEST_TO` est défini). Le serveur peut rester ouvert.

Pour choisir un autre destinataire, remplace l’adresse ci-dessous par une adresse que tu souhaites tester :

```powershell
npm run check:email -- ton-adresse@gmail.com --credential "Gmail Atlas"
```

### E. Si le test échoue

| Erreur | Vérification à faire, puis retester |
|---|---|
| Authentication failed / 535 | Vérifie User et colle un nouveau mot de passe d’application Google dans Password, puis Test et Save. |
| Pas d’option « Mots de passe d’application » | Active la validation en deux étapes et consulte l’aide Google pour les restrictions de ton compte. |
| Timeout / connection refused | Vérifie Internet et `smtp.gmail.com:465` avec SSL/TLS activé. Si le réseau bloque SMTP, essaie un autre réseau ; variante : port `587`, SSL/TLS désactivé (STARTTLS). |
| Credentials are missing | Sauvegarde la connexion et sélectionne-la dans le nœud Send Email. |
| Test réussit mais aucun email | Le bouton Test n’envoie rien : lance le workflow ou `check:email`, puis vérifie To Email et les spams. |
| Mauvais compte utilisé | Vérifie la connexion choisie dans le nœud. Pour le terminal, garde `--credential "Gmail Atlas"`. |

## 3. Les prochaines intégrations, avec leur test

Ne configure que les services dont tu as besoin. Les noms des champs peuvent rester en anglais dans l’application.

| Service | Configuration | Petit test et résultat attendu |
|---|---|---|
| Météo | Aucune clé. Ajoute Weather (Open-Meteo) et renseigne le lieu demandé. | Manual Trigger → Weather → Exécuter : température et lieu dans Output. Internet requis. |
| Telegram | Crée un bot avec `/newbot` chez [BotFather](https://t.me/BotFather), puis Connexions → Telegram Bot → Bot Token → Test → Save. Envoie `/start` au bot. | Le bouton Test doit reconnaître le bot. Ensuite configure ton Chat ID dans le nœud Telegram et envoie-toi `Test Atlas Flow` : tu dois recevoir le message. Un seul programme doit écouter ce bot. [Guide Telegram](https://core.telegram.org/bots/features#botfather). |
| Discord | Dans ton serveur : Paramètres → Intégrations → Webhooks → créer/copier l’URL, puis Connexions → Discord Webhook → Test → Save. | Manual Trigger → Discord avec cette connexion et le message `Test Atlas Flow` → Exécuter : message visible dans le salon choisi. [Guide Discord](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks). |
| Gemini | Crée une clé dans [Google AI Studio](https://aistudio.google.com/apikey), puis Connexions → Google Gemini API. Vérifie le champ Default Model avec la [liste Google](https://ai.google.dev/gemini-api/docs/models) : n’utilise pas un nom de modèle indisponible pour ta clé. Test → Save. | Manual Trigger → Google Gemini → prompt `Réponds uniquement OK` → Exécuter : une réponse dans Output. Une erreur 404 peut indiquer un modèle indisponible ; 429 un quota atteint. |
| API HTTP | Ajoute HTTP Request et renseigne l’URL et la méthode indiquées par le fournisseur. Si nécessaire, ajoute une connexion HTTP Bearer / Header / Basic adaptée à son API. | Exécute d’abord une requête de lecture connue du fournisseur : vérifie le JSON renvoyé. 401/403 : authentification ou droits ; 404 : URL ; 429 : quota. |

Pour les champs détaillés et le Chat ID Telegram : [API_SETUP.md](API_SETUP.md).

## 4. Vérification générale et fichiers locaux

- `npm run check` vérifie les intégrations ; **il peut envoyer un email si CHECK_EMAIL_TO est rempli et un message Telegram si un Chat ID est configuré**. Pour commencer avec Gmail seul, préfère le bouton Test, puis `check:email`.
- `npm run check -- --send` ajoute un vrai message Discord au diagnostic général.
- `OK` = test réussi ; `FAIL` = échec à corriger ; `SKIP` = service non configuré ou étape ignorée. Un service que tu n’utilises pas peut rester en SKIP.
- `.env`, ses variantes locales et `data/` restent hors de Git. N’ajoute pas tes mots de passe dans `.env.example` ou dans le JSON d’un workflow.
- Garde `data/.encryption_key` avec ta base de données : ne change pas cette clé après avoir enregistré des connexions.
- Les tests automatiques SMTP utilisent un faux serveur local : ils valident le code, mais seul ton test Gmail valide ton compte et la réception réelle.
