import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, BookOpen, Search, Zap } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { useTitle } from '../lib/useTitle';
import { PageHeader } from './PageHeader';

const FEATURES = [
  ['Organiser', 'Mes workflows', 'Crée un workflow, donne-lui un nom et ouvre-le pour relier ses étapes. Utilise les tags, la recherche et le tri pour le retrouver.', '/workflows'],
  ['Organiser', 'Favoris', 'Clique sur l’étoile d’un workflow, puis sur « Favoris » au-dessus de la liste. Tes favoris sont mémorisés dans ce navigateur pour ton compte.', '/workflows?favorites=1'],
  ['Organiser', 'Modèles et exemples', 'Choisis un modèle puis « Utiliser ce modèle ». Une copie personnelle s’ouvre : tu peux modifier les étapes et les paramètres.', '/templates'],
  ['Organiser', 'Importer, exporter, dupliquer', 'Dans Mes workflows, importe un JSON ou utilise les icônes d’une ligne pour exporter, dupliquer, renommer et gérer ses tags.', '/workflows'],
  ['Construire', 'Éditeur visuel', 'Ajoute un déclencheur avec +, ajoute une action et relie leurs connecteurs. Double-clique sur une étape pour régler ses paramètres.', '/workflows'],
  ['Construire', 'Enregistrer et exécuter', 'Clique sur « Enregistrer », puis « Exécuter ». Ouvre une étape pour voir ses données d’entrée et de sortie. Active le workflow pour ses déclenchements automatiques.', '/workflows'],
  ['Construire', 'Conditions, boucles et données', 'IF / Switch orientent les données. Loop Over Items traite chaque élément. Edit Fields, Filter, Merge et Sort transforment tes résultats.', '/workflows'],
  ['Construire', 'Expressions et code', 'Utilise {{ $json.champ }} pour lire une donnée, {{ $vars.nom }} pour une variable. Le nœud Code permet un traitement JavaScript.', '/variables'],
  ['Déclencher', 'Planning et webhooks', 'Schedule Trigger lance à une heure donnée. Webhook reçoit une requête HTTP : écoute une fois en test ou active le workflow pour son URL de production.', '/workflows'],
  ['Déclencher', 'Formulaires et QR code', 'Ajoute Form Trigger, configure les champs et ouvre l’aperçu. Pour recevoir de vraies réponses, active le workflow et partage son URL de production ou son QR code.', '/workflows'],
  ['Déclencher', 'Chat, RSS et surveillance', 'Chat Trigger ouvre une conversation ; RSS surveille un flux ; HTTP Poll surveille une URL ; Local File surveille le dossier de fichiers autorisé.', '/workflows'],
  ['Connecter', 'Clés et connexions', 'Ajoute un identifiant SMTP, Telegram, Discord, Gemini ou HTTP. Teste-le, enregistre-le puis sélectionne-le dans le nœud correspondant.', '/credentials'],
  ['Connecter', 'Email, Telegram et Discord', 'Ajoute Send Email, Telegram ou Discord. Choisis tes identifiants, le destinataire et le contenu du message, puis exécute pour tester.', '/credentials'],
  ['Connecter', 'HTTP et GraphQL', 'Ajoute HTTP Request ou GraphQL, indique l’URL, la méthode, les paramètres et si besoin tes identifiants. HTTP Request peut aussi importer une commande cURL.', '/workflows'],
  ['Connecter', 'Météo et fichiers', 'Weather récupère la météo sans clé API (Internet requis). Les nœuds fichiers lisent, convertissent et écrivent dans data/files ; les sorties binaires se téléchargent.', '/templates'],
  ['Intelligence artificielle', 'Création avec IA', 'Dans l’éditeur, ouvre « Build with AI » et décris ton automatisation. Avec Gemini : génération IA ; sans clé : choix du modèle préconfiguré le plus proche.', '/workflows'],
  ['Intelligence artificielle', 'Agent IA', 'Ajoute AI Agent avec un Gemini Chat Model et sa clé. Connecte Simple Memory pour la mémoire et des outils (calcul, météo, HTTP) pour les actions.', '/credentials'],
  ['Suivre', 'Tableau de bord et historique', 'L’accueil montre les statistiques réelles. Dans Historique, ouvre une exécution pour examiner sa durée, son statut, les données et les erreurs.', '/executions'],
  ['Suivre', 'Time travel et versions', 'Ouvre une exécution puis « Time travel » pour rejouer ses étapes. Dans l’éditeur, l’icône horloge permet de consulter et restaurer une version sauvegardée.', '/executions'],
  ['Suivre', 'Variables et paramètres', 'Variables stocke tes valeurs réutilisables (pas tes secrets). Paramètres règle le fuseau horaire, les délais, la concurrence et la conservation des exécutions.', '/settings'],
  ['Suivre', 'Démo guidée', 'Le bouton « Démo guidée » présente une automatisation pas à pas. Les intégrations sans clé sont simulées uniquement pendant la démo et signalées comme telles.', '/home'],
] as const;

export function GuidePage() {
  useTitle('Guide rapide');
  const [search, setSearch] = useState('');
  const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const visible = FEATURES.filter((f) => normalize(f.join(' ')).includes(normalize(search.trim())));
  return (
    <div className="animate-fade-in">
      <PageHeader title="Un peu d’aide, beaucoup de possibilités." subtitle="Le guide Atlas Flow : une fonctionnalité, une explication simple." />
      <div className="space-y-6 px-8 py-6">
        <Card className="atlas-hero p-6">
          <div className="relative z-10">
            <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-teal-300"><Zap size={15} /> Ton premier workflow</span>
            <h2 className="mt-3 text-xl font-semibold">Commence sans clé API.</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">Mes workflows → Nouveau workflow → Manual Trigger → Edit Fields → ajoute un champ « message » avec la valeur « Bonjour Atlas » → relie les deux étapes → Enregistrer → Exécuter.</p>
            <Link to="/workflows" className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-teal-300">Créer mon premier workflow <ArrowRight size={16} /></Link>
          </div>
        </Card>
        <label className="flex max-w-xl items-center gap-3 rounded-xl border border-line-strong bg-panel px-4 py-3">
          <Search size={18} className="shrink-0 text-subtle" />
          <input aria-label="Rechercher dans le guide" placeholder="Chercher une fonctionnalité : email, IA, formulaire…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-full min-w-0 bg-transparent text-sm outline-none" />
        </label>
        <p className="text-xs text-muted" aria-live="polite">{visible.length} fonctionnalité{visible.length > 1 ? 's' : ''}</p>
        <div className="grid gap-4 lg:grid-cols-2">
          {visible.map(([category, title, description, to]) => (
            <Card key={title} className="flex flex-col gap-3 p-5 transition-colors hover:border-line-strong">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-teal-300">{category}</span>
              <h2 className="flex items-center gap-2 text-base font-semibold"><BookOpen size={16} className="text-muted" />{title}</h2>
              <p className="flex-1 text-[13px] leading-relaxed text-muted">{description}</p>
              <Link to={to} className="inline-flex items-center gap-2 self-start text-xs font-medium text-accent-hover">Ouvrir <ArrowRight size={14} /></Link>
            </Card>
          ))}
        </div>
        {visible.length === 0 && <Card className="p-8 text-center text-muted">Aucun résultat. Essaie un autre mot, ou efface la recherche.</Card>}
      </div>
    </div>
  );
}
