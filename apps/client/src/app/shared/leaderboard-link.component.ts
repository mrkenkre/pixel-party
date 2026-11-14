import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core'
import { TranslocoPipe } from '@jsverse/transloco'
import { appUrl } from '../core/net/app-url'

// Fork extra (party-20 / cf-workers): a link to the leaderboard page `/_scores`. Only the fork's hosts
// have one (the Pi's leaderboard hook, the Cloudflare Worker); a plain Pixel Party server answers
// /_scores.json with the app's index.html, so the link stays hidden there. Checked once per page load.
let available: Promise<boolean> | undefined
const hasLeaderboard = (): Promise<boolean> =>
  (available ??= fetch(appUrl('_scores.json'), { method: 'HEAD', cache: 'no-store' })
    .then((r) => r.ok && (r.headers.get('content-type') ?? '').includes('application/json'))
    .catch(() => false))

@Component({
  selector: 'app-leaderboard-link',
  imports: [TranslocoPipe],
  template: `
    @if (show()) {
      <a
        class="arcade-btn lb"
        [href]="href"
        [attr.target]="newTab() ? '_blank' : null"
        [attr.rel]="newTab() ? 'noopener' : null"
      >
        🏆 {{ 'common.leaderboard' | transloco }}
      </a>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host { display: block; }
    .lb { text-decoration: none; text-align: center; display: block; }
  `,
})
export class LeaderboardLinkComponent {
  // In a room, open it in a new tab so the game keeps running.
  readonly newTab = input(false)
  readonly href = appUrl('_scores')
  readonly show = signal(false)

  constructor() {
    void hasLeaderboard().then((ok) => this.show.set(ok))
  }
}
