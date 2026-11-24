import { html, Button } from './components.js';
import { t } from '../../../shared/i18n.js';

export function BossRouteToggle({ visible, onToggle }) {
  return html`<${Button} size="sm" variant=${visible ? 'secondary' : 'ghost'} active=${visible}
    data-testid="boss-route-toggle" aria-pressed=${String(visible)}
    onKeyDown=${e => { if (e.key === ' ') e.stopPropagation(); }}
    onClick=${onToggle}>${t('Boss 路线')}<//>`;
}
