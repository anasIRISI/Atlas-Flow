import { BookOpen, Braces, History, KeyRound, LayoutDashboard, LayoutTemplate, Settings, Workflow, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Phase that delivers the page (shown on placeholder pages until then). */
  phase?: string;
  description: string;
}

export const MAIN_NAV: NavItem[] = [
  { to: '/home', label: 'Tableau de bord', icon: LayoutDashboard, description: 'Dashboard: runs per day, success rate, failing workflows and instance status.' },
  {
    to: '/workflows',
    label: 'Mes workflows',
    icon: Workflow,
    description: 'Create, open and organise workflows in the visual editor.',
  },
  {
    to: '/templates',
    label: 'Modèles',
    icon: LayoutTemplate,
    description: 'Ready-made workflows you can import in one click.',
  },
  {
    to: '/executions',
    label: 'Historique',
    icon: History,
    description: 'Every run of every workflow, with the input and output of each node.',
  },
  {
    to: '/credentials',
    label: 'Connexions',
    icon: KeyRound,
    description: 'Encrypted API keys and logins for SMTP, Telegram, Discord and Gemini, with a Test button.',
  },
  {
    to: '/variables',
    label: 'Variables',
    icon: Braces,
    description: 'Global key/value pairs available in expressions as $vars.',
  },
  { to: '/guide', label: 'Guide rapide', icon: BookOpen, description: 'Les fonctionnalités expliquées simplement.' },
];

export const SETTINGS_NAV: NavItem = {
  to: '/settings',
  label: 'Paramètres',
  icon: Settings,
  description: 'Timezone, execution timeout, concurrency, data pruning and security toggles.',
};
