# Atlas Flow — guide express

Atlas Flow est ta version personnalisée de FlowForge : interface bleu/turquoise, navigation et parcours principaux en français, favoris, guide intégré et exemple personnel sans clé API. Les noms techniques des nœuds et certains écrans avancés restent en anglais.

## 1. Démarrer

Prérequis : **Node.js 22.13 ou plus récent** et npm (inclus avec Node). Internet est nécessaire pour installer les dépendances.

Dans PowerShell, ouvre le dossier du projet et lance :

```powershell
cd D:\IRISI\S5\GENAI\flowforge
npm install
npm start
```

Ouvre **http://localhost:5679**. Le premier démarrage compile le projet : attends le message du serveur. Crée ton compte avec ton prénom, ton email et un mot de passe de 8 à 64 caractères, avec une majuscule et un chiffre. Les prochaines fois, lance simplement `npm start`. Pour arrêter : **Ctrl+C** dans le terminal.

Pour modifier le code avec rechargement automatique : `npm run dev`, puis **http://localhost:5173**.

## 2. Premier essai en une minute

1. Sur **Tableau de bord**, clique **Essayer mon premier flow**.
2. Un workflow personnel de trois étapes s’ouvre : démarrer → profil → message.
3. Clique **Exécuter**, puis ouvre **Mon message** et regarde **Output** : ton message de bienvenue apparaît.
4. Pour le personnaliser, ouvre **Mon profil**, modifie `prenom`, puis **Enregistrer** et **Exécuter**.

Cet exemple fonctionne localement, sans clé API. Chaque clic sur le bouton crée une nouvelle copie modifiable.

## 3. Chaque fonctionnalité, brièvement

| Fonctionnalité | Comment l’utiliser |
|---|---|
| Tableau de bord | Consulte les exécutions, réussites, erreurs et connexions. Déplie « État du système » pour l’adresse publique et le dossier de données. |
| Nouveau workflow | **Mes workflows → Nouveau workflow** ; clique sur son nom dans l’éditeur pour le renommer. |
| Ajouter et relier des étapes | Clique **+**, cherche un nœud et ajoute-le ; relie la sortie d’une étape à l’entrée de la suivante. Double-clique pour configurer. |
| Sauvegarder / lancer / arrêter | **Enregistrer**, puis **Exécuter** ; **Arrêter** interrompt l’exécution en cours. |
| Entrées / sorties | Ouvre une étape : **Input** = données reçues, **Parameters** = réglages, **Output** = résultat. |
| Favoris (nouveau) | Clique l’étoile d’un workflow, puis **Favoris** au-dessus de la liste. Mémorisés par compte dans ce navigateur ; non synchronisés entre appareils. |
| Recherche, tri et tags | Dans **Mes workflows**, cherche un nom ou un tag, filtre les actifs et trie. L’icône tag permet d’attribuer des catégories. |
| Dupliquer / renommer / supprimer | Utilise les icônes de la ligne d’un workflow. Les cases permettent une suppression groupée avec confirmation. |
| Import / export | **Import** charge un fichier JSON. L’icône de téléchargement d’une ligne exporte le workflow pour le partager. |
| Modèles et exemples | **Modèles → Utiliser ce modèle**, ou **Mes workflows → Exemples → Importer** ; une copie s’ouvre dans l’éditeur. Certaines intégrations exigent des clés. |
| Déclenchement manuel | Ajoute **Manual Trigger**, relie tes actions et clique **Exécuter**. |
| Activer un workflow | Utilise l’interrupteur de la liste ou de l’éditeur pour les déclencheurs automatiques. Un workflow purement manuel se lance avec **Exécuter**. |
| Planning | Ajoute **Schedule Trigger**, règle l’heure et le fuseau, enregistre puis active. Laisse le serveur démarré. |
| Webhook | Configure méthode et chemin. **Listen for test event** ouvre l’URL de test une fois ; l’URL de production nécessite un workflow actif. |
| Réponse HTTP | Ajoute **Respond to Webhook** pour définir le corps et le statut de la réponse reçue par l’appelant. |
| Formulaire et QR code | **Form Trigger** : ajoute des champs et consulte l’aperçu. Active puis partage l’URL de production ou son QR code. |
| Chat | Ajoute **Chat Trigger** et une action de réponse ou un agent ; utilise le panneau de test ou la page publique du workflow actif. |
| RSS / HTTP Poll / Local File | Choisis le déclencheur adapté, renseigne le flux, l’URL ou le dossier autorisé, règle la fréquence si proposée et active. |
| Modifier les données | **Edit Fields** ajoute/modifie des champs ; **Filter**, **Sort**, **Limit**, **Remove Duplicates** filtrent et organisent les éléments. |
| Regrouper et comparer | **Aggregate**, **Summarize**, **Split Out**, **Compare Datasets** regroupent, résument, découpent ou comparent les données. |
| Conditions / boucles / fusion | **IF** ou **Switch** choisit une branche ; **Loop Over Items** répète ; **Merge** rassemble les branches. |
| Expressions | Dans une valeur, `{{ $json.champ }}` lit l’entrée ; `{{ $vars.nom }}` lit une variable globale. Utilise l’aperçu pour vérifier. |
| JavaScript | Ajoute **Code**, écris ton traitement et teste sa sortie. Le code s’exécute dans un environnement isolé. |
| Dates, formats et calculs | **Date & Time**, **Crypto**, **HTML**, **XML**, **Markdown** transforment les valeurs selon l’opération sélectionnée. |
| API HTTP / GraphQL | Renseigne URL, méthode, paramètres, corps et authentification. **HTTP Request** propose aussi l’import cURL et la pagination. |
| Fichiers | Les nœuds de fichiers lisent/écrivent dans `data/files`. **Convert to File / Extract from File** convertissent les données ; **Binary** permet le téléchargement. |
| Météo | Ajoute **Weather (Open-Meteo)** et renseigne le lieu demandé : pas de clé, mais Internet requis. |
| Connexions | **Connexions** : ajoute un identifiant, choisis son type, remplis les champs, teste et sauvegarde. Sélectionne-le ensuite dans ton nœud. |
| Email | **Send Email** : choisis la connexion SMTP, le destinataire, l’objet et le message ; exécute pour tester l’envoi réel. |
| Telegram / Discord | Crée une connexion avec le token du bot ou l’URL webhook, puis règle le destinataire et le message dans le nœud. |
| Gemini | Ajoute ta clé dans **Connexions**, choisis-la dans **Google Gemini** puis saisis ton prompt. |
| Création de workflow par IA | Dans l’éditeur, ouvre **Build with AI** et décris le besoin. Avec une clé Gemini : génération ; sans clé : modèle préconfiguré le plus proche. |
| Agent IA / mémoire / outils | Connecte **Gemini Chat Model** à **AI Agent**. Ajoute **Simple Memory** et des outils météo, calcul, HTTP ou code selon le besoin. Clé Gemini requise. |
| Attente / sous-workflow | **Wait** suspend ; **Execute Workflow** appelle un autre workflow configuré avec **Execute Workflow Trigger**. |
| Gestion des erreurs | Dans les réglages du nœud, configure les tentatives ou la continuation sur erreur ; **Error Trigger** lance un workflow d’alerte. |
| Historique / relancer | **Historique** : ouvre une exécution pour voir statut, durée, étapes et erreurs ; utilise la relance proposée si nécessaire. |
| Time travel | Depuis une exécution, clique **Time travel**, puis avance étape par étape ; **Re-run from here** démarre une nouvelle exécution. |
| Versions | Icône horloge de l’éditeur : consulte les versions et restaure celle voulue. **Maj + clic sur Enregistrer** ajoute une note. |
| Annuler, copier, organiser | Utilise annuler/rétablir, copier/coller et l’auto-organisation de l’éditeur. **?** affiche les raccourcis, **Ctrl+K** la palette. |
| Variables | Ajoute une paire nom/valeur dans **Variables**, puis lis-la avec `{{ $vars.nom }}`. Place les secrets dans **Connexions**. |
| Paramètres | Règle fuseau horaire (ex. `Africa/Casablanca`), délais, concurrence et conservation des exécutions. |
| Commandes système | **Execute Command** est désactivé par défaut ; son activation se trouve dans **Paramètres → Security** si ton scénario le nécessite. |
| Démo guidée | Le bouton de la barre latérale lance une visite. Les services sans clé sont explicitement simulés pendant cette démo seulement. |
| Guide intégré (nouveau) | **Guide rapide** explique les fonctions avec une recherche et des liens vers les pages concernées. |

## 4. Clés, données et dépannage

**Configurer les API et tester chaque étape : [CONFIGURATION_API.md](CONFIGURATION_API.md).** Commence par Gmail : Connexions → SMTP → Gmail → Test → Save, puis importe l’exemple **Test Gmail - Atlas Flow** et envoie-toi un email.

- **Aucune clé pour commencer** : l’exemple personnel, les transformations locales, les fichiers et l’historique fonctionnent sans service externe. Météo et appels HTTP nécessitent Internet ; email, messagerie et IA nécessitent leurs identifiants.
- Configuration facultative : copie `.env.example` vers `.env`. Pour changer de port, mets `PORT=5680`, redémarre et ouvre `http://localhost:5680`. Les variables gardent leur préfixe technique `FLOWFORGE_`.
- Les étapes détaillées pour les clés se trouvent dans [API_SETUP.md](API_SETUP.md).
- Garde le dossier `data/` pour retrouver ton compte et tes workflows ; sauvegarde aussi `data/.encryption_key` pour pouvoir déchiffrer tes connexions.
- Mot de passe oublié : arrête le serveur, lance `npm run user:reset`, redémarre puis recrée ton compte. Les workflows restent conservés.
- Sur téléphone : même Wi-Fi, serveur démarré, utilise l’adresse réseau affichée au démarrage. Si le QR code pointe mal, règle `PUBLIC_URL` dans `.env` et redémarre.
- Vérifier le code : `npm test` ; compiler : `npm run build`. Vérifier tes connexions réelles : `npm run check` (ou `npm run check:email`).

Base technique : moteur FlowForge. Atlas Flow personnalise l’expérience et la prise en main. Dépôt : [Atlas Flow](https://github.com/anasIRISI/Atlas-Flow).
